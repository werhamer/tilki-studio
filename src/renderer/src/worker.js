/*
 * Tilki Studio — kayıt motoru (worker)
 *
 * Arayüz iş parçacığından bağımsız çalışır; pencere küçültülse de kare kaçırmaz.
 *   ekran + kamera kareleri → birleştirme (OffscreenCanvas) → VideoEncoder (GPU)
 *   ses verisi → AudioEncoder
 *   kodlanmış paketler → kayıt dosyası ve/veya anlık tekrar tamponu
 */
import {
  Output, Mp4OutputFormat, MkvOutputFormat, WebMOutputFormat, StreamTarget,
  EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket,
} from 'mediabunny';
import { camRect, RESOLUTIONS, targetBitrate } from './geometry.js';

const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);

// ------------------------------------------------------------------ durum

let preview = null;
let pctx = null;
let previewVisible = true;

const comp = new OffscreenCanvas(1920, 1080);
const cctx = comp.getContext('2d', { alpha: false });

const screenSlot = { reader: null, frame: null, dirty: false, w: 0, h: 0 };
const camSlot = { reader: null, frame: null, dirty: false, w: 0, h: 0 };

let config = { fps: 60, resolution: 'source', videoOrder: ['h264'], quality: 'high' };
let layout = {
  cam: { enabled: false, shape: 'circle', size: 0.28, x: 0.86, y: 0.78, mirror: true },
  crop: null,
  cropEditing: false,
};
let layoutDirty = true;
let lastDims = '';

let session = null; // kodlayıcılar açıkken dolu
let sessionStarting = false;
let preparedVideo = null;
let prepareTimer = null;
let rec = null; // etkin kayıt (Sink)
const replay = { enabled: false, seconds: 30, video: [], audio: [] };

const MB_VIDEO = { h264: 'avc', hevc: 'hevc', av1: 'av1', vp9: 'vp9', vp8: 'vp8' };

// ------------------------------------------------------------------ kaynak kareleri

function replaceSlot(slot, readable) {
  const old = slot.reader;
  slot.reader = null;
  if (old) old.cancel().catch(() => {});
  if (slot.frame) slot.frame.close();
  slot.frame = null;
  slot.w = 0;
  slot.h = 0;
  slot.dirty = true;
  layoutDirty = true;
  if (readable) pumpVideo(slot, readable);
}

async function pumpVideo(slot, readable) {
  const reader = readable.getReader();
  slot.reader = reader;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (slot.reader !== reader) {
        value.close();
        break;
      }
      if (slot.frame) slot.frame.close();
      slot.frame = value;
      slot.dirty = true;
      if (value.displayWidth !== slot.w || value.displayHeight !== slot.h) {
        slot.w = value.displayWidth;
        slot.h = value.displayHeight;
        if (slot === screenSlot) updateOutSize();
      }
    }
  } catch {
    // Kaynak kapandı; arayüz 'ended' olayını ayrıca alır.
  }
  if (slot.reader === reader) slot.reader = null;
}

// ------------------------------------------------------------------ boyut ve birleştirme

function sourceRect() {
  const f = screenSlot.frame;
  if (!f) return null;
  const fw = f.displayWidth;
  const fh = f.displayHeight;
  const c = layout.crop;
  if (!c) return { x: 0, y: 0, w: fw, h: fh };
  const x = Math.max(0, Math.min(fw - 16, Math.round(c.x * fw)));
  const y = Math.max(0, Math.min(fh - 16, Math.round(c.y * fh)));
  return {
    x,
    y,
    w: Math.max(16, Math.min(fw - x, Math.round(c.w * fw))),
    h: Math.max(16, Math.min(fh - y, Math.round(c.h * fh))),
  };
}

function desiredOutSize() {
  const r = sourceRect();
  if (!r) return { w: comp.width, h: comp.height };
  const cap = RESOLUTIONS[config.resolution] || { w: 3840, h: 2160 };
  const scale = Math.min(1, cap.w / r.w, cap.h / r.h);
  const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { w: even(r.w), h: even(r.h) };
}

function updateOutSize() {
  // Kayıt sırasında çıktı boyutu sabittir; kaynak değişirse kareye sığdırılır.
  if (!session && !sessionStarting) {
    const d = desiredOutSize();
    if (comp.width !== d.w || comp.height !== d.h) {
      comp.width = d.w;
      comp.height = d.h;
    }
  }
  layoutDirty = true;
  const dims = { outW: comp.width, outH: comp.height, srcW: screenSlot.w, srcH: screenSlot.h };
  const key = JSON.stringify(dims);
  if (key !== lastDims) {
    lastDims = key;
    post('dims', dims);
  }
  scheduleVideoPreparation();
}

function drawCam(W, H) {
  const f = camSlot.frame;
  const cam = layout.cam;
  const r = camRect(cam, W, H);
  const shape = () => {
    cctx.beginPath();
    if (cam.shape === 'circle') cctx.arc(r.cx, r.cy, r.h / 2, 0, Math.PI * 2);
    else cctx.roundRect(r.x, r.y, r.w, r.h, r.r);
  };

  cctx.save();
  cctx.shadowColor = 'rgba(0,0,0,0.5)';
  cctx.shadowBlur = r.h * 0.1;
  cctx.shadowOffsetY = r.h * 0.025;
  cctx.fillStyle = '#000';
  shape();
  cctx.fill();
  cctx.restore();

  cctx.save();
  shape();
  cctx.clip();
  const fw = f.displayWidth;
  const fh = f.displayHeight;
  const s = Math.max(r.w / fw, r.h / fh);
  if (cam.mirror) {
    cctx.translate(r.cx * 2, 0);
    cctx.scale(-1, 1);
  }
  cctx.drawImage(f, r.cx - (fw * s) / 2, r.cy - (fh * s) / 2, fw * s, fh * s);
  cctx.restore();

  cctx.save();
  cctx.lineWidth = Math.max(2, r.h * 0.014);
  cctx.strokeStyle = 'rgba(255,255,255,0.92)';
  shape();
  cctx.stroke();
  cctx.restore();
}

function compose() {
  const W = comp.width;
  const H = comp.height;
  cctx.fillStyle = '#000';
  cctx.fillRect(0, 0, W, H);
  const f = screenSlot.frame;
  const r = sourceRect();
  if (f && r) {
    const s = Math.min(W / r.w, H / r.h);
    const dw = r.w * s;
    const dh = r.h * s;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(f, r.x, r.y, r.w, r.h, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  if (layout.cam.enabled && camSlot.frame) drawCam(W, H);
}

// Hızlı yol: kamera yoksa ve ölçekleme gerekmiyorsa yakalanan kare tuvale hiç
// uğramadan doğrudan kodlayıcıya gider (ekran kartına yükle / geri oku turu yok).
// Bu durumda kaynak karede kullanılacak dikdörtgeni, aksi halde null döndürür.
function directRect() {
  const f = screenSlot.frame;
  if (!f) return null;
  if (layout.cam.enabled && camSlot.frame) return null;
  const r = sourceRect();
  if (session && (r.w !== session.width || r.h !== session.height)) return null;
  return r;
}

function drawPreview(rect) {
  if (!pctx || !previewVisible) return;
  pctx.imageSmoothingQuality = 'high';
  const f = screenSlot.frame;
  if (layout.cropEditing && f) {
    pctx.drawImage(f, 0, 0, preview.width, preview.height);
  } else if (rect && f) {
    pctx.drawImage(f, rect.x, rect.y, rect.w, rect.h, 0, 0, preview.width, preview.height);
  } else {
    pctx.drawImage(comp, 0, 0, preview.width, preview.height);
  }
}

// ------------------------------------------------------------------ ana döngü

let loopTimer = null;
let nextTick = 0;

function startLoop() {
  if (loopTimer !== null) return;
  nextTick = performance.now();
  const step = () => {
    const fps = session ? session.fps : config.fps;
    const interval = 1000 / fps;
    try {
      tick(nextTick);
    } catch (err) {
      post('error', { message: `tick: ${err && err.message}` });
    }
    nextTick += interval;
    const now = performance.now();
    if (session && session.encoding) session.maxLate = Math.max(session.maxLate, now - nextTick);
    if (nextTick < now - interval * 2) {
      // Geride kaldık: aradaki kareleri atla.
      const skipped = Math.floor((now - nextTick) / interval);
      nextTick += skipped * interval;
      if (session && session.encoding) session.dropped += skipped;
    }
    loopTimer = setTimeout(step, Math.max(0, nextTick - performance.now()));
  };
  step();
}

let previewDirty = true;
let lastPreview = 0;
const PREVIEW_INTERVAL = 1000 / 30; // önizleme 30 fps yeter; kayıt tam hızda sürer

function tick(time) {
  const s = session;
  const encoding = !!(s && s.encoding);
  const dirty = screenSlot.dirty || camSlot.dirty || layoutDirty;
  const rect = directRect();
  if (dirty) {
    if (!rect) compose();
    screenSlot.dirty = false;
    camSlot.dirty = false;
    layoutDirty = false;
    previewDirty = true;
  }
  if (encoding) encodeFrame(s, time, rect);
  if (previewDirty && time - lastPreview >= PREVIEW_INTERVAL - 2) {
    if (!rect && !dirty) compose();
    drawPreview(rect);
    lastPreview = time;
    previewDirty = false;
  }
}

function encodeFrame(s, time, rect) {
  const n = Math.max(1, Math.round((time - s.t0) / s.interval) + 1);
  if (n <= s.lastN) return;
  s.lastN = n;
  if (s.venc.state !== 'configured') return;
  if (s.venc.encodeQueueSize > Math.max(10, s.fps / 2)) {
    // Kodlayıcı yarım saniyeden fazla geride: bellek şişmesin diye kareyi bırak.
    s.dropped++;
    s.queueDrops++;
    return;
  }
  const key = s.forceKey || n - s.lastKeyN >= s.fps * 2;
  if (key) {
    s.forceKey = false;
    s.lastKeyN = n;
  }
  const init = { timestamp: Math.round((n * 1e6) / s.fps), duration: Math.round(1e6 / s.fps) };
  let frame;
  if (rect) {
    const src = screenSlot.frame;
    if (layout.crop) {
      const v = src.visibleRect;
      init.visibleRect = { x: (v.x + rect.x) & ~1, y: (v.y + rect.y) & ~1, width: rect.w, height: rect.h };
      init.displayWidth = rect.w;
      init.displayHeight = rect.h;
    }
    frame = new VideoFrame(src, init);
    s.direct++;
  } else {
    frame = new VideoFrame(comp, init);
  }
  try {
    s.venc.encode(frame, { keyFrame: key });
    s.frames++;
  } finally {
    frame.close();
  }
}

// ------------------------------------------------------------------ kodlayıcı seçimi

function h264Level(w, h, fps) {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = fs * fps;
  if (fs <= 8704 && mbps <= 245760) return '28';
  if (fs <= 8704 && mbps <= 522240) return '2a';
  if (fs <= 22080 && mbps <= 589824) return '32';
  if (fs <= 36864 && mbps <= 983040) return '33';
  return '34';
}

function codecStrings(codec, w, h, fps) {
  const px = w * h;
  const heavy = px * fps > 1920 * 1088 * 31;
  const big = px > 1920 * 1088;
  const tier = big ? (heavy ? 3 : 2) : heavy ? 1 : 0; // 1080p30, 1080p60, 4K30, 4K60
  switch (codec) {
    case 'h264': {
      const l = h264Level(w, h, fps);
      return [`avc1.6400${l}`, `avc1.4d00${l}`, `avc1.42e0${l}`, `avc1.4200${l}`];
    }
    case 'hevc': {
      const l = ['L120', 'L123', 'L150', 'L153'][tier];
      return [`hvc1.1.6.${l}.B0`, `hev1.1.6.${l}.B0`];
    }
    case 'av1':
      return [`av01.0.${['08', '09', '12', '13'][tier]}M.08`];
    case 'vp9':
      return [`vp09.00.${['40', '41', '50', '51'][tier]}.08`];
    case 'vp8':
      return ['vp8'];
    default:
      return [];
  }
}

function videoConfig(codec, str, w, h, fps, bitrate, hw) {
  const cfg = {
    codec: str,
    width: w,
    height: h,
    bitrate,
    framerate: fps,
    hardwareAcceleration: hw ? 'prefer-hardware' : 'prefer-software',
    latencyMode: 'realtime',
    bitrateMode: 'variable',
  };
  if (codec === 'h264') cfg.avc = { format: 'avc' };
  if (codec === 'hevc') cfg.hevc = { format: 'hevc' };
  return cfg;
}

// Adayları sırayla üretir; çağıran ilk çalışan kodlayıcıda durur, böylece
// kullanılmayacak kodekler boşuna yoklanmaz ve kayıt daha çabuk başlar.
async function* videoCandidates(order, w, h, fps, quality) {
  for (const codec of order) {
    const bitrate = targetBitrate(w, h, fps, quality, codec);
    for (const hw of [true, false]) {
      for (const str of codecStrings(codec, w, h, fps)) {
        const cfg = videoConfig(codec, str, w, h, fps, bitrate, hw);
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) {
            yield { codec, hw, cfg, bitrate };
            break;
          }
        } catch {
          // Bu dizgi desteklenmiyor, sıradakini dene.
        }
      }
    }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

// Kodlayıcıyı gerçekten bir kare kodlatarak dener: bazı sürücüler "destekliyorum"
// deyip ilk karede hata verir.
function tryVideoEncoder(cand, canvas, fps, signal) {
  return new Promise((resolve) => {
    const video = { ...cand, encoder: null, decoderConfig: null, owner: null };
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig) video.decoderConfig = meta.decoderConfig;
        if (video.owner && session === video.owner) {
          session.vConfig = video.decoderConfig;
          onVideoChunk(session, chunk);
        }
      },
      error: (err) => {
        if (video.owner && session === video.owner) {
          post('fatal', { message: `video: ${err && err.message}` });
        }
        finish(false);
      },
    });
    video.encoder = enc;
    const timeout = setTimeout(() => finish(false), 4000);
    let settled = false;
    const abort = () => finish(false);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (!ok && enc.state !== 'closed') enc.close();
      resolve(ok ? video : null);
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      enc.configure(cand.cfg);
      const frame = new VideoFrame(canvas, { timestamp: 0, duration: Math.round(1e6 / fps) });
      try {
        enc.encode(frame, { keyFrame: true });
      } finally {
        frame.close();
      }
      enc.flush().then(
        () => finish(enc.state === 'configured' && !!video.decoderConfig),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}

async function findVideoEncoder({ w, h, fps, videoOrder, quality }, signal) {
  const testCanvas = new OffscreenCanvas(w, h);
  testCanvas.getContext('2d', { alpha: false }).fillRect(0, 0, w, h);
  for await (const candidate of videoCandidates(videoOrder, w, h, fps, quality)) {
    if (signal?.aborted) break;
    const video = await tryVideoEncoder(candidate, testCanvas, fps, signal);
    if (video) return video;
  }
  return null;
}

function videoRequest() {
  const { fps, videoOrder, quality } = config;
  return { w: comp.width, h: comp.height, fps, videoOrder, quality };
}

function discardPreparedVideo() {
  const entry = preparedVideo;
  preparedVideo = null;
  if (!entry) return;
  clearTimeout(entry.expiry);
  entry.controller.abort();
  if (entry.video?.encoder.state === 'configured') entry.video.encoder.close();
}

function scheduleVideoPreparation() {
  clearTimeout(prepareTimer);
  if (session || sessionStarting) return;
  const request = videoRequest();
  const key = JSON.stringify(request);
  if (screenSlot.frame && preparedVideo?.key === key) return;
  discardPreparedVideo();
  if (!screenSlot.frame) return;

  // Sık değişen kaynak ve bölge boyutları durulana kadar bekle.
  prepareTimer = setTimeout(() => {
    const entry = { key, controller: new AbortController(), video: null, expiry: null };
    preparedVideo = entry;
    entry.promise = findVideoEncoder(request, entry.controller.signal).catch(() => null).then((video) => {
      if (entry.controller.signal.aborted) {
        if (video?.encoder.state === 'configured') video.encoder.close();
        return null;
      }
      if (preparedVideo === entry) {
        entry.video = video;
        // Boşta tek bir kodlayıcı tut ve uzun süre kullanılmazsa bırak.
        entry.expiry = setTimeout(discardPreparedVideo, 30000);
      }
      return video;
    });
  }, 180);
}

async function claimVideoEncoder(request) {
  clearTimeout(prepareTimer);
  if (preparedVideo?.key === JSON.stringify(request)) {
    const entry = preparedVideo;
    preparedVideo = null;
    clearTimeout(entry.expiry);
    const video = await entry.promise;
    if (video?.encoder.state === 'configured') return { video, prepared: true };
  } else {
    discardPreparedVideo();
  }
  return { video: await findVideoEncoder(request), prepared: false };
}

async function pickAudioConfig(order, bitrate) {
  for (const codec of order) {
    const cfg = codec === 'aac'
      ? { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate }
      : { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: Math.min(bitrate, 256000) };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r.supported) return { codec, cfg };
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ oturum

async function startSession(msg) {
  if (session) return sessionInfo();
  updateOutSize();
  sessionStarting = true;
  try {
    return await openSession(msg, videoRequest());
  } finally {
    sessionStarting = false;
    if (!session) updateOutSize();
  }
}

async function openSession(msg, request) {
  const { w: width, h: height, fps } = request;
  const s = {
    fps,
    interval: 1000 / fps,
    t0: 0,
    lastN: 0,
    lastKeyN: -1e9,
    forceKey: true,
    encoding: false,
    dropped: 0,
    queueDrops: 0,
    direct: 0,
    maxLate: 0,
    frames: 0,
    bytes: 0,
    vConfig: null,
    venc: null,
    video: null,
    audio: [],
    aCodec: null,
    width,
    height,
    timing: { start: performance.now() },
  };

  try {
    const audioSupported = msg.audio.length ? pickAudioConfig(msg.audioOrder, msg.audioBitrate) : null;
    const { video, prepared } = await claimVideoEncoder(request);
    if (!video) throw new Error('no-video-encoder');
    s.video = video;
    s.venc = video.encoder;
    s.vConfig = video.decoderConfig;
    s.timing.videoPrepared = prepared;
    s.timing.videoReady = Math.round(performance.now() - s.timing.start);

    const audio = await audioSupported;
    if (msg.audio.length && !audio) throw new Error('no-audio-encoder');
    s.aCodec = audio?.codec ?? null;
    s.timing.audioPicked = Math.round(performance.now() - s.timing.start);

    msg.audio.forEach((input, index) => {
      const track = {
        name: input.name, enc: null, reader: null, config: null,
        encTime: 0, wallNext: null, wallEnd: 0, segments: [],
      };
      track.enc = new AudioEncoder({
        output: (chunk, meta) => {
          if (meta && meta.decoderConfig) track.config = meta.decoderConfig;
          if (session === s) onAudioChunk(s, index, chunk);
        },
        error: (err) => {
          if (session === s) post('fatal', { message: `audio: ${err && err.message}` });
        },
      });
      s.audio.push(track);
      track.enc.configure(audio.cfg);
    });

    s.t0 = performance.now();
    video.owner = s;
    session = s;
    msg.audio.forEach((input, index) => pumpAudio(s, s.audio[index], input.readable));
    updateEncoding();
    return sessionInfo();
  } catch (err) {
    for (const input of msg.audio) input.readable.cancel().catch(() => {});
    for (const track of s.audio) if (track.enc.state !== 'closed') track.enc.close();
    if (s.venc && s.venc.state !== 'closed') s.venc.close();
    throw err;
  }
}

function sessionInfo() {
  const s = session;
  return {
    width: s.width,
    height: s.height,
    fps: s.fps,
    videoCodec: s.video.codec,
    hardware: s.video.hw,
    videoBitrate: s.video.bitrate,
    audioCodec: s.aCodec,
    timing: s.timing,
  };
}

async function stopSession() {
  const s = session;
  if (!s) return;
  if (rec) await stopRec();
  session = null;
  replay.video = [];
  replay.audio = [];
  for (const a of s.audio) {
    if (a.reader) a.reader.cancel().catch(() => {});
    try {
      a.enc.close();
    } catch {}
  }
  try {
    s.venc.close();
  } catch {}
  updateOutSize();
}

function updateEncoding() {
  const s = session;
  if (!s) return;
  const next = replay.enabled || !!(rec && !rec.paused);
  if (next && !s.encoding) s.forceKey = true;
  s.encoding = next;
}

async function pumpAudio(s, track, readable) {
  const reader = readable.getReader();
  track.reader = reader;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (session !== s) {
        value.close();
        break;
      }
      try {
        handleAudio(s, track, value);
      } finally {
        value.close();
      }
    }
  } catch {
    // Oturum kapanırken okuyucu iptal edilir.
  }
}

function handleAudio(s, track, data) {
  if (!s.encoding || track.enc.state !== 'configured') {
    track.wallNext = null;
    return;
  }
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  const durUs = (frames / data.sampleRate) * 1e6;
  // Kodlayıcı yalnızca kesintisiz bir örnek sayacı görür (encTime). Gerçek oturum
  // zamanı "segment" tablosunda tutulur; duraklatma ya da kopma yeni segment açar.
  const wall = (performance.now() - s.t0) * 1000 - durUs;
  if (track.wallNext === null || Math.abs(wall - track.wallNext) > 150000) {
    const start = Math.max(wall, track.wallNext === null ? track.wallEnd : track.wallNext, 0);
    track.segments.push({ enc: track.encTime, wall: start });
    if (track.segments.length > 32) track.segments.shift();
    track.wallNext = start;
  }
  const buffer = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    data.copyTo(buffer.subarray(c * frames, (c + 1) * frames), { planeIndex: c, format: 'f32-planar' });
  }
  const out = new AudioData({
    format: 'f32-planar',
    sampleRate: data.sampleRate,
    numberOfFrames: frames,
    numberOfChannels: channels,
    timestamp: Math.round(track.encTime),
    data: buffer,
  });
  track.encTime += durUs;
  track.wallNext += durUs;
  track.wallEnd = track.wallNext;
  try {
    track.enc.encode(out);
  } finally {
    out.close();
  }
}

function onVideoChunk(s, chunk) {
  const pkt = EncodedPacket.fromEncodedChunk(chunk);
  s.bytes += pkt.byteLength;
  if (replay.enabled) {
    replay.video.push(pkt);
    trimReplay();
  }
  if (rec) rec.pushVideo(pkt);
}

function onAudioChunk(s, index, chunk) {
  const track = s.audio[index];
  let seg = track.segments[0];
  for (const candidate of track.segments) {
    if (candidate.enc <= chunk.timestamp + 500) seg = candidate;
    else break;
  }
  if (!seg) return;
  const pkt = EncodedPacket.fromEncodedChunk(chunk).clone({
    timestamp: (chunk.timestamp - seg.enc + seg.wall) / 1e6,
  });
  s.bytes += pkt.byteLength;
  if (replay.enabled) (replay.audio[index] ||= []).push(pkt);
  if (rec) rec.pushAudio(index, pkt);
}

// ------------------------------------------------------------------ dosya hedefi

const pendingWrites = new Map();
let writeSeq = 0;

function makeFile(fileId) {
  const file = { id: fileId, bytes: 0, writable: null };
  file.writable = new WritableStream({
    write(chunk) {
      file.bytes = Math.max(file.bytes, chunk.position + chunk.data.byteLength);
      return new Promise((resolve, reject) => {
        const seq = ++writeSeq;
        pendingWrites.set(seq, { resolve, reject });
        post('file-write', { fileId, seq, position: chunk.position, data: chunk.data });
      });
    },
  });
  return file;
}

// ------------------------------------------------------------------ kayıt alıcısı

class Sink {
  constructor(s, output, file, vSource, aSources) {
    this.s = s;
    this.output = output;
    this.file = file;
    this.vSource = vSource;
    this.aSources = aSources;
    this.chain = Promise.resolve();
    this.failed = null;
    this.base = null;
    this.pausedTotal = 0;
    this.pauseAt = 0;
    this.paused = false;
    this.waitKey = true;
    this.lastEnd = 0;
    this.duration = 0;
    this.vStarted = false;
    this.aStarted = aSources.map(() => false);
    this.aLast = aSources.map(() => -1);
    this.pendingAudio = [];
  }

  enqueue(fn) {
    this.chain = this.chain.then(() => (this.failed ? null : fn())).catch((err) => {
      if (!this.failed) {
        this.failed = err;
        post('fatal', { message: `mux: ${err && err.message}` });
      }
    });
  }

  pushVideo(pkt) {
    if (this.paused) return;
    if (this.waitKey) {
      if (pkt.type !== 'key') return;
      this.waitKey = false;
      if (this.base === null) this.base = pkt.timestamp;
      else this.pausedTotal += pkt.timestamp - this.pauseAt;
      const queued = this.pendingAudio;
      this.pendingAudio = [];
      for (const [index, p] of queued) this.pushAudio(index, p);
    }
    const ts = pkt.timestamp - this.base - this.pausedTotal;
    this.lastEnd = pkt.timestamp + pkt.duration;
    this.duration = ts + pkt.duration;
    const meta = this.vStarted ? undefined : { decoderConfig: this.s.vConfig };
    this.vStarted = true;
    const out = pkt.clone({ timestamp: ts });
    this.enqueue(() => this.vSource.add(out, meta));
  }

  pushAudio(index, pkt) {
    if (this.paused) return;
    if (this.waitKey) {
      // İlk anahtar kare gelene kadar ses bekletilir ki baştaki ses kaybolmasın.
      if (this.base === null && this.pendingAudio.length < 600) this.pendingAudio.push([index, pkt]);
      return;
    }
    const ts = pkt.timestamp - this.base - this.pausedTotal;
    if (ts < 0 || ts < this.aLast[index]) return;
    this.aLast[index] = ts + pkt.duration * 0.5;
    const meta = this.aStarted[index] ? undefined : { decoderConfig: this.s.audio[index].config };
    this.aStarted[index] = true;
    const out = pkt.clone({ timestamp: ts });
    this.enqueue(() => this.aSources[index].add(out, meta));
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pauseAt = this.lastEnd;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.waitKey = true;
    this.s.forceKey = true;
  }

  async finish() {
    await this.chain;
    if (this.failed) throw this.failed;
    if (!this.vStarted) {
      await this.output.cancel().catch(() => {});
      throw new Error('empty-recording');
    }
    await this.output.finalize();
  }
}

async function createSink(s, fileId, container, crashSafe) {
  let format;
  // MKV kümeler halinde yazıldığı için kesintiden sonra zaten okunabilir. appendOnly
  // kullanılmaz: o modda normal biten kayda bile süre ve arama dizini yazılmıyor.
  if (container === 'mkv') format = new MkvOutputFormat();
  else if (container === 'webm') format = new WebMOutputFormat();
  else format = new Mp4OutputFormat({ fastStart: crashSafe ? 'fragmented' : false });

  const file = makeFile(fileId);
  const streaming = container !== 'mp4' || crashSafe;
  const output = new Output({
    format,
    target: new StreamTarget(file.writable, streaming ? {} : { chunked: true, chunkSize: 2 * 1024 * 1024 }),
  });
  const vSource = new EncodedVideoPacketSource(MB_VIDEO[s.video.codec]);
  output.addVideoTrack(vSource, { frameRate: s.fps });
  const aSources = s.audio.map((track) => {
    const source = new EncodedAudioPacketSource(s.aCodec);
    output.addAudioTrack(source, { name: track.name });
    return source;
  });
  await output.start();
  return new Sink(s, output, file, vSource, aSources);
}

async function flushEncoders(s) {
  const jobs = [];
  if (s.venc.state === 'configured') jobs.push(s.venc.flush());
  for (const a of s.audio) if (a.enc.state === 'configured') jobs.push(a.enc.flush());
  await withTimeout(Promise.allSettled(jobs), 4000);
  s.forceKey = true;
}

async function startRec(msg) {
  if (!session) throw new Error('no-session');
  if (rec) throw new Error('already-recording');
  const sink = await createSink(session, msg.fileId, msg.container, msg.crashSafe);
  rec = sink;
  session.forceKey = true;
  updateEncoding();
}

async function stopRec() {
  const sink = rec;
  if (!sink) return null;
  if (session && !sink.paused) await flushEncoders(session);
  rec = null;
  updateEncoding();
  await sink.finish();
  return { duration: sink.duration, bytes: sink.file.bytes };
}

// ------------------------------------------------------------------ anlık tekrar

function trimReplay() {
  const v = replay.video;
  if (!v.length) return;
  const cutoff = v[v.length - 1].timestamp - (replay.seconds + 6);
  const drop = (list) => {
    let i = 0;
    while (i < list.length && list[i].timestamp < cutoff) i++;
    if (i > 120) list.splice(0, i);
  };
  drop(v);
  for (const list of replay.audio) if (list) drop(list);
}

function replayBuffered() {
  const v = replay.video;
  if (v.length < 2) return 0;
  return Math.min(replay.seconds, v[v.length - 1].timestamp - v[0].timestamp);
}

async function saveReplay(msg) {
  const s = session;
  if (!s || !replay.enabled) throw new Error('replay-off');
  const v = replay.video.slice();
  if (!v.length) throw new Error('replay-empty');
  const last = v[v.length - 1];
  const end = last.timestamp + last.duration;
  const want = end - replay.seconds;
  let start = -1;
  for (let i = 0; i < v.length; i++) {
    if (v[i].type !== 'key') continue;
    if (start === -1 || v[i].timestamp <= want) start = i;
    else break;
  }
  if (start === -1) throw new Error('replay-empty');
  const base = v[start].timestamp;

  const items = [];
  for (let i = start; i < v.length; i++) items.push({ t: v[i].timestamp, k: -1, p: v[i] });
  replay.audio.forEach((list, k) => {
    if (!list) return;
    for (const p of list) if (p.timestamp >= base && p.timestamp < end) items.push({ t: p.timestamp, k, p });
  });
  items.sort((a, b) => a.t - b.t || a.k - b.k);

  const sink = await createSink(s, msg.fileId, msg.container, false);
  for (const it of items) {
    if (it.k === -1) sink.pushVideo(it.p);
    else sink.pushAudio(it.k, it.p);
  }
  await sink.finish();
  return { duration: sink.duration, bytes: sink.file.bytes };
}

// ------------------------------------------------------------------ istatistik

let statsLast = { time: 0, frames: 0, bytes: 0 };

function startStats() {
  setInterval(() => {
    const s = session;
    const now = performance.now();
    const dt = (now - statsLast.time) / 1000 || 1;
    const stats = { active: !!s };
    if (s) {
      stats.fps = (s.frames - statsLast.frames) / dt;
      stats.bitrate = ((s.bytes - statsLast.bytes) * 8) / dt;
      stats.dropped = s.dropped;
      stats.queueDrops = s.queueDrops;
      stats.direct = s.direct;
      stats.frames = s.frames;
      stats.maxLate = Math.round(s.maxLate);
      stats.queue = s.venc.encodeQueueSize;
      statsLast = { time: now, frames: s.frames, bytes: s.bytes };
    } else {
      statsLast = { time: now, frames: 0, bytes: 0 };
    }
    stats.rec = rec ? { duration: rec.duration, bytes: rec.file.bytes, paused: rec.paused } : null;
    stats.replay = replay.enabled ? { buffered: replayBuffered(), seconds: replay.seconds } : null;
    post('stats', { stats });
  }, 250);
}

// ------------------------------------------------------------------ mesajlar

const handlers = {
  init(msg) {
    preview = msg.canvas;
    pctx = preview.getContext('2d', { alpha: false });
    startLoop();
    startStats();
  },

  config(msg) {
    config = { ...config, ...msg.config };
    updateOutSize();
  },

  screen(msg) {
    replaceSlot(screenSlot, msg.readable || null);
    updateOutSize();
  },

  cam(msg) {
    replaceSlot(camSlot, msg.readable || null);
  },

  layout(msg) {
    layout = { ...layout, ...msg.layout };
    updateOutSize();
  },

  preview(msg) {
    if (!preview) return;
    if (msg.width && msg.height && (preview.width !== msg.width || preview.height !== msg.height)) {
      preview.width = msg.width;
      preview.height = msg.height;
    }
    if (typeof msg.visible === 'boolean') previewVisible = msg.visible;
    layoutDirty = true;
  },

  async probe() {
    const result = {};
    for (const codec of ['h264', 'hevc', 'av1', 'vp9']) {
      const list = [];
      for await (const cand of videoCandidates([codec], 1920, 1080, 60, 'high')) list.push(cand);
      result[codec] = { hardware: list.some((c) => c.hw), software: list.some((c) => !c.hw) };
    }
    return result;
  },

  'session-start': startSession,
  'prepare-video': scheduleVideoPreparation,
  'session-stop': stopSession,
  'rec-start': startRec,
  'rec-stop': stopRec,

  'rec-pause'() {
    if (rec) rec.pause();
    updateEncoding();
  },

  'rec-resume'() {
    if (rec) rec.resume();
    updateEncoding();
  },

  replay(msg) {
    replay.seconds = msg.seconds || replay.seconds;
    if (replay.enabled !== !!msg.enabled) {
      replay.enabled = !!msg.enabled;
      replay.video = [];
      replay.audio = [];
    }
    updateEncoding();
  },

  'replay-save': saveReplay,

  async screenshot() {
    compose();
    const blob = await comp.convertToBlob({ type: 'image/png' });
    const buffer = await blob.arrayBuffer();
    return { buffer, width: comp.width, height: comp.height };
  },

  'file-ack'(msg) {
    const pending = pendingWrites.get(msg.seq);
    if (!pending) return;
    pendingWrites.delete(msg.seq);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve();
  },
};

self.onmessage = async (event) => {
  const msg = event.data;
  const handler = handlers[msg.type];
  if (!handler) return;
  if (msg.id == null) {
    try {
      await handler(msg);
    } catch (err) {
      post('error', { message: `${msg.type}: ${err && err.message}` });
    }
    return;
  }
  try {
    const result = await handler(msg);
    const transfer = result && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    post('reply', { id: msg.id, result }, transfer);
  } catch (err) {
    post('reply', { id: msg.id, error: String((err && err.message) || err) });
  }
};
