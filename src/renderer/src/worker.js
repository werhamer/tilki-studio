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

if (self.name === 'stall') {
  // Yalnızca otomatik testte: iş parçacığını her ~280 ms'de 170 ms meşgul et.
  setInterval(() => {
    const until = performance.now() + 170;
    while (performance.now() < until) { /* meşgul bekle */ }
  }, 280);
}

if (self.name === 'hang') {
  // Yalnızca otomatik testte: yanıt vermeyen ekran kartı sürücüsünü taklit et.
  VideoEncoder.isConfigSupported = () => new Promise(() => {});
}

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
      if (session && session.encoding && !session.audioOnly) session.dropped += skipped;
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
  // Sadece ses kaydında görüntü kodlanmaz ve önizleme sahnenin arkasında kalır: hiç
  // çizim yapma ki iş parçacığı ses işlemeye ayrılsın.
  if (s && s.audioOnly) return;
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
  if (encoding && s.venc) encodeFrame(s, time, rect);
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
  if (s.videoRecovering || !s.venc || s.venc.state !== 'configured') {
    s.dropped++;
    return;
  }
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
  } catch (err) {
    recoverVideoEncoder(s, err);
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
  // Annex B biçimi: anahtar karelerin içinde SPS/PPS satır içi taşınır; böylece GPU
  // süreci çöküp kodlayıcı (donanım ya da CPU yedeğiyle) yeniden açıldığında kayıt
  // aynı dosyada bölünmeden sürer.
  if (codec === 'h264') cfg.avc = { format: 'annexb' };
  if (codec === 'hevc') cfg.hevc = { format: 'annexb' };
  return cfg;
}

// Adayları sırayla üretir; çağıran ilk çalışan kodlayıcıda durur, böylece
// kullanılmayacak kodekler boşuna yoklanmaz ve kayıt daha çabuk başlar.
// Ekran kartı sürücüsü bazen "destekliyor musun?" sorusuna hiç yanıt vermiyor
// (örneğin GPU başka bir uygulama tarafından kilitlendiğinde). Her sorgu ve
// aramanın tamamı süreyle sınırlıdır; yanıt gelmezse o seçenek atlanır.
const QUERY_TIMEOUT = 2500;
const SEARCH_BUDGET = 15000;

async function* videoCandidates(order, w, h, fps, quality) {
  const deadline = performance.now() + SEARCH_BUDGET;
  for (const codec of order) {
    const bitrate = targetBitrate(w, h, fps, quality, codec);
    for (const hw of [true, false]) {
      for (const str of codecStrings(codec, w, h, fps)) {
        const cfg = videoConfig(codec, str, w, h, fps, bitrate, hw);
        if (performance.now() > deadline) return;
        try {
          const r = await withTimeout(VideoEncoder.isConfigSupported(cfg), QUERY_TIMEOUT);
          if (r === 'timeout') {
            post('error', { message: `isConfigSupported zaman aşımı: ${cfg.codec} ${hw ? 'hw' : 'sw'}` });
            break;
          }
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
          recoverVideoEncoder(video.owner, err);
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

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GPU süreci çökerse (exitCode 34) video kodlayıcıyı kaydı bölmeden aynı dosyada yeniler:
// önce yeniden kalkan GPU'yu, olmazsa işlemci (prefer-software) kodlayıcısını dener.
async function recoverVideoEncoder(s, err) {
  if (!s || session !== s || s.audioOnly || s.videoRecovering) return;
  s.videoRecovering = true;
  const targetCodec = s.video ? s.video.codec : 'h264';
  try {
    if (s.venc && s.venc.state !== 'closed') s.venc.close();
  } catch {}
  s.venc = null;
  post('log', {
    level: 'error',
    message: `[video kodlayıcı] hata (${(err && err.message) || err}); aynı dosyada kurtarılıyor…`,
  });
  for (const delay of [100, 300, 800, 1800]) {
    await waitMs(delay);
    if (session !== s) return;
    try {
      const next = await findVideoEncoder({
        w: s.width,
        h: s.height,
        fps: s.fps,
        videoOrder: [targetCodec],
        quality: config.quality,
      });
      if (session !== s) {
        if (next && next.encoder.state !== 'closed') next.encoder.close();
        return;
      }
      if (next) {
        next.owner = s;
        s.video = next;
        s.venc = next.encoder;
        s.vConfig = next.decoderConfig;
        s.forceKey = true;
        s.vRecoveries = (s.vRecoveries || 0) + 1;
        s.videoRecovering = false;
        post('log', {
          level: 'info',
          message: `[video kodlayıcı] kurtarıldı: ${next.codec} ${next.hw ? 'GPU' : 'CPU'} (kurtarma #${s.vRecoveries})`,
        });
        post('session-updated', { info: sessionInfo() });
        return;
      }
    } catch {}
  }
  s.videoRecovering = false;
  if (session === s) post('fatal', { message: `video: ${(err && err.message) || 'encoder-lost'}` });
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
  // Windows'un AAC kodlayıcısı en fazla 192 kbps kabul ediyor. Daha yüksek bir değer
  // seçildiyse sessizce Opus'a geçmek yerine (bazı kurgu programları MP4/M4A içinde
  // Opus açamaz) önce 192 kbps AAC denenir.
  const candidates = [];
  for (const codec of order) {
    if (codec === 'aac') {
      for (const rate of new Set([bitrate, Math.min(bitrate, 192000)])) {
        candidates.push(['aac', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: rate }]);
      }
    } else {
      candidates.push([codec, { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: Math.min(bitrate, 256000) }]);
    }
  }
  for (const [codec, cfg] of candidates) {
    try {
      const r = await withTimeout(AudioEncoder.isConfigSupported(cfg), QUERY_TIMEOUT);
      if (r !== 'timeout' && r.supported) return { codec, cfg };
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
    const audioSupported = msg.outputs.length ? pickAudioConfig(msg.audioOrder, msg.audioBitrate) : null;
    // Sadece ses kaydı: video kodlayıcı hiç açılmaz.
    const { video, prepared } = msg.audioOnly ? { video: null, prepared: false } : await claimVideoEncoder(request);
    if (!video && !msg.audioOnly) throw new Error('no-video-encoder');
    if (msg.audioOnly && !msg.outputs.length) throw new Error('nothing-to-record');
    s.audioOnly = !!msg.audioOnly;
    if (s.audioOnly) {
      s.width = 0;
      s.height = 0;
    }
    s.video = video;
    s.venc = video ? video.encoder : null;
    s.vConfig = video ? video.decoderConfig : null;
    s.timing.videoPrepared = prepared;
    s.timing.videoReady = Math.round(performance.now() - s.timing.start);

    const audio = await audioSupported;
    if (msg.outputs.length && !audio) throw new Error('no-audio-encoder');
    s.aCodec = audio?.codec ?? null;
    s.audioOrder = msg.audioOrder;
    s.audioBitrate = msg.audioBitrate;
    s.vRecoveries = 0;
    s.videoRecovering = false;
    s.timing.audioPicked = Math.round(performance.now() - s.timing.start);

    msg.outputs.forEach((output, index) => {
      const track = {
        name: output.name,
        sources: output.sources,
        audioCfg: audio.cfg,
        enc: null,
        fail: null,
        config: null,
        encTime: 0,
        confirmedEncUs: 0,
        emittedFrames: 0,
        recovering: false,
        recoveries: 0,
        segments: [],
        mix: newMix(),
        encDiag: newEncDiag(),
      };
      s.audio.push(track);
      openTrackEncoder(s, track, index, audio.cfg);
    });

    s.t0 = performance.now();
    if (video) video.owner = s;
    session = s;
    updateEncoding();
    return sessionInfo();
  } catch (err) {
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
    videoCodec: s.video ? s.video.codec : null,
    hardware: s.video ? s.video.hw : null,
    videoBitrate: s.video ? s.video.bitrate : 0,
    audioOnly: !!s.audioOnly,
    audioCodec: s.aCodec,
    vRecoveries: s.vRecoveries || 0,
    aRecoveries: s.audio.reduce((sum, a) => sum + (a.recoveries || 0), 0),
    timing: s.timing,
  };
}

function openTrackEncoder(s, track, index, cfg) {
  let dead = false;
  let enc = null;
  const fail = (err) => {
    if (dead || session !== s) return;
    dead = true;
    try {
      if (enc && enc.state !== 'closed') enc.close();
    } catch {}
    recoverAudioTrack(s, track, index, err);
  };
  enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) track.config = meta.decoderConfig;
      track.confirmedEncUs = Math.max(track.confirmedEncUs, chunk.timestamp + (chunk.duration || 0));
      if (session === s) onAudioChunk(s, index, chunk);
    },
    error: fail,
  });
  enc.configure(cfg);
  track.enc = enc;
  track.fail = fail;
}

// Windows'ta MediaFoundation AAC kodlayıcı GPU sürecinde çalışır; GPU süreci çöktüğünde
// (exitCode 34) kodlayıcı ölür. Halka tampondaki PCM verisi korunduğu için yeni GPU
// süreci kalkar kalkmaz aynı kodekle yeni kodlayıcı açılır ve kayıt tek örnek bile
// kaybetmeden AYNI DOSYADA kesintisiz devam eder.
async function recoverAudioTrack(s, track, index, err) {
  if (!s || session !== s || track.recovering) return;
  track.recovering = true;
  const lostUs = Math.max(0, Math.min(900000, track.encTime - track.confirmedEncUs));
  const lostFrames = Math.round((lostUs * SR) / 1e6);
  if (track.mix.emitted !== null && lostFrames > 0) {
    const rewound = Math.max(track.mix.minKept, track.mix.emitted - lostFrames);
    const rewoundFrames = track.mix.emitted - rewound;
    if (rewoundFrames > 0) {
      track.mix.emitted = rewound;
      track.encTime = Math.max(track.confirmedEncUs, track.encTime - (rewoundFrames / SR) * 1e6);
    }
  }
  post('log', {
    level: 'error',
    message: `[kodlayıcı ${track.name}] hata (${(err && err.message) || err}); aynı dosyada kurtarılıyor…`,
  });
  for (const delay of [60, 180, 450, 1000, 2000]) {
    await waitMs(delay);
    if (session !== s) return;
    try {
      const r = await withTimeout(AudioEncoder.isConfigSupported(track.audioCfg), QUERY_TIMEOUT);
      if (r === 'timeout' || !r.supported) continue;
      openTrackEncoder(s, track, index, track.audioCfg);
      if (track.enc && track.enc.state === 'configured') {
        track.recovering = false;
        track.recoveries++;
        post('log', {
          level: 'info',
          message: `[kodlayıcı ${track.name}] kurtarıldı (kurtarma #${track.recoveries})`,
        });
        post('session-updated', { info: sessionInfo() });
        flushAudio(s, performance.now());
        return;
      }
    } catch {}
  }
  track.recovering = false;
  if (session === s) post('fatal', { message: `audio: ${(err && err.message) || 'encoder-lost'}` });
}

async function stopSession() {
  const s = session;
  if (!s) return;
  if (rec) await stopRec();
  session = null;
  replay.video = [];
  replay.audio = [];
  for (const a of s.audio) {
    try {
      a.enc.close();
    } catch {}
  }
  try {
    if (s.venc) s.venc.close();
  } catch {}
  updateOutSize();
}

function updateEncoding() {
  const s = session;
  if (!s) return;
  const next = replay.enabled || !!(rec && !rec.paused);
  if (next && !s.encoding) s.forceKey = true;
  // Ses: her başlatma/duraklatmada karıştırıcı sıfırdan, yeni bir segmentle başlar.
  if (next !== s.encoding) resetAudioTimeline(s);
  s.encoding = next;
}

// ------------------------------------------------------------------ ses: doğrudan yakalama + karıştırıcı
//
// Kayıt sesi Web Audio'dan GEÇMEZ. Mikrofon ve sistem sesi parçaları doğrudan buraya
// gelir; konumları yakalandıkları ana göre hesaplanır, ses düzeyi ve (Güçlü seviyede)
// RNNoise burada uygulanır, sonra bir tamponda karıştırılıp kodlanır.
// Eskiden kayıt sesi bir AudioContext'in çıktısından alınıyordu; o bağlamın saati
// (varsayılan hoparlör) gerçek kullanımda aksadığında kayıtların ~%35'i boşluk oluyordu.

const SR = 48000;
const RING = SR * 6; // karıştırma tamponu: 6 sn (1 sn geriye dönük kurtarma + 5 sn ileri tampon)
const KEEP_TAIL = SR; // kodlayıcı çökerse uçuşta kalan paketleri geri sarmak için tutulan kuyruk
const WRITE_HEAD = RING - KEEP_TAIL;
const BLOCK = 960; // kodlayıcıya 20 ms'lik bloklar
const LIVE_MS = 400; // bu kadar süre veri gelmeyen girdi "sessiz" sayılır, beklenmez
const RESYNC_FRAMES = Math.round(SR * 0.04); // 40 ms'den büyük sapmada yeniden hizala

const inputs = { mic: null, sys: null };
const gains = { mic: 1, sys: 1 };
let noiseStrong = false;
let rnnoiseEntry = null;
let rnnoiseLoading = null;
let healthProbe = null;

function newMix() {
  return {
    l: new Float32Array(RING),
    r: new Float32Array(RING),
    emitted: null,
    clearedTo: null,
    minKept: 0,
    filled: {},
    lastAt: {},
    segOpen: false,
  };
}

function advanceRingClear(mx) {
  if (mx.emitted === null) return;
  const target = mx.emitted + WRITE_HEAD;
  if (mx.clearedTo === null) {
    mx.clearedTo = target;
    mx.minKept = mx.emitted;
    return;
  }
  if (target <= mx.clearedTo) return;
  const span = target - mx.clearedTo;
  if (span >= RING) {
    mx.l.fill(0);
    mx.r.fill(0);
  } else {
    for (let p = mx.clearedTo; p < target; p++) {
      const idx = p % RING;
      mx.l[idx] = 0;
      mx.r[idx] = 0;
    }
  }
  mx.clearedTo = target;
  mx.minKept = Math.max(mx.minKept, target - RING);
}

function newDiag() {
  return {
    frames: 0, chunks: 0, resyncs: 0, gapFrames: 0, maxLagMs: 0,
    firstCapUs: null, lastCapUs: null, lastDurUs: 0, prevCapEndUs: null, maxPtsJumpMs: 0,
    since: performance.now(),
  };
}

function newEncDiag() {
  return {
    pkts: 0, audioS: 0, firstPts: null, lastPts: null, lastDur: 0, prevEnd: null, maxGapMs: 0,
    emittedFrames: 0, since: performance.now(),
  };
}

function resetAudioTimeline(s) {
  for (const track of s.audio) {
    const old = track.mix;
    track.mix = newMix();
    track.encDiag = newEncDiag();
    old.l = null;
    old.r = null;
  }
  for (const inp of Object.values(inputs)) {
    if (!inp) continue;
    inp.anchored = false;
    inp.diag = newDiag();
    inp.rateWinGotMs = 0;
    inp.rateWinSince = performance.now();
  }
}

// RNNoise'u AudioWorklet işleyicisinin kendisiyle, burada (worker'da) çalıştırırız.
function loadRnnoiseEntry() {
  if (rnnoiseEntry) return Promise.resolve(rnnoiseEntry);
  if (!rnnoiseLoading) {
    rnnoiseLoading = (async () => {
      const base = self.location.href;
      // Paketin ana dosyası AudioWorkletNode'a bağlı (worker'da yok); wasm'ı kendimiz yükleriz.
      const fetchWasm = async (name) => (await fetch(new URL(`rnnoise/${name}`, base).href)).arrayBuffer();
      let wasm = await fetchWasm('rnnoise_simd.wasm');
      if (!WebAssembly.validate(wasm)) wasm = await fetchWasm('rnnoise.wasm');
      let cls = null;
      self.AudioWorkletProcessor = class {
        constructor() {
          this.port = { addEventListener() {}, removeEventListener() {}, postMessage() {}, start() {} };
        }
      };
      self.registerProcessor = (_name, c) => { cls = c; };
      self.sampleRate = SR;
      const url = new URL('rnnoise/workletProcessor.js', base).href;
      await import(/* @vite-ignore */ url);
      if (!cls) throw new Error('işleyici yüklenemedi');
      rnnoiseEntry = { cls, wasm };
      return rnnoiseEntry;
    })().catch((err) => {
      post('log', { level: 'error', message: `[rnnoise] yüklenemedi: ${err && err.message}` });
      rnnoiseLoading = null;
      return null;
    });
  }
  return rnnoiseLoading;
}

function makeDenoiser(entry) {
  const proc = new entry.cls({ processorOptions: { wasmBinary: entry.wasm, maxChannels: 2 } });
  const fl = new Float32Array(128);
  const fr = new Float32Array(128);
  let fill = 0;
  return {
    get ready() {
      return !!proc.processor;
    },
    // Akışı 128 örneklik bloklarla işler; sabit (~15 ms) gecikmeyle aynı sayıda örnek döner.
    run(L, R) {
      const total = fill + L.length;
      const blocks = Math.floor(total / 128);
      const outL = new Float32Array(blocks * 128);
      const outR = new Float32Array(blocks * 128);
      let o = 0;
      for (let i = 0; i < L.length; i++) {
        fl[fill] = L[i];
        fr[fill] = R[i];
        fill++;
        if (fill === 128) {
          const ol = outL.subarray(o, o + 128);
          const or = outR.subarray(o, o + 128);
          if (proc.processor) proc.process([[fl, fr]], [[ol, or]]);
          else {
            ol.set(fl);
            or.set(fr);
          }
          o += 128;
          fill = 0;
        }
      }
      return [outL, outR];
    },
    destroy() {
      try {
        proc.destroy();
      } catch {}
    },
  };
}

function attachDenoiser(inp) {
  loadRnnoiseEntry().then((entry) => {
    if (!entry) {
      if (noiseStrong) post('noise-state', { strong: false, failed: true });
      return;
    }
    if (inp.dead || !noiseStrong || inp.ns) return;
    inp.ns = makeDenoiser(entry);
    post('noise-state', { strong: true });
  });
}

function detachDenoiser(inp) {
  if (inp && inp.ns) {
    inp.ns.destroy();
    inp.ns = null;
  }
  post('noise-state', { strong: false });
}

function setInput(kind, readable) {
  const old = inputs[kind];
  if (old) {
    old.dead = true;
    if (old.reader) old.reader.cancel().catch(() => {});
    if (old.ns) old.ns.destroy();
  }
  inputs[kind] = null;
  if (!readable) return;
  const now = performance.now();
  const inp = {
    kind, reader: null, dead: false, anchored: false, useCap: false, offset: 0, nextPos: 0,
    lastArrival: 0, ns: null, sampleRate: SR,
    rsHasPrev: false, rsPrevL: 0, rsPrevR: 0, rsPos: 0,
    hLastCapUs: null, hLastDurMs: 0, hLastAt: null,
    rateWinGotMs: 0, rateWinSince: now,
    diag: newDiag(),
  };
  inputs[kind] = inp;
  if (kind === 'mic' && noiseStrong) attachDenoiser(inp);
  pumpInput(inp, readable);
}

async function pumpInput(inp, readable) {
  const reader = readable.getReader();
  inp.reader = reader;
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (inp.dead) {
        value.close();
        break;
      }
      // Yalnızca test: yakalamada kayıp (her ~0.43 sn'de ~0.17 sn) taklit et.
      if (self.name === 'dropaudio' && inp.kind === 'mic' && ++count % 43 < 17) {
        value.close();
        continue;
      }
      try {
        handleInput(inp, value);
      } catch (err) {
        post('error', { message: `ses girdisi: ${err && err.message}` });
      } finally {
        value.close();
      }
    }
  } catch {
    // Girdi değişti ya da kapandı.
  }
}

// Faz-sürekli doğrusal örnekleme hızı dönüştürücü (ör. 44,1 kHz -> 48 kHz).
// Parça sınırlarında önceki örneği (rsPrevL/R) ve kesirli fazı (rsPos) korur;
// sınır çıtırtısı veya saat kayması üretmez.
function resample(inp, L, R, rate) {
  const N = L.length;
  if (!N) return [L, R];
  const ratio = rate / SR;
  if (!inp.rsHasPrev) {
    inp.rsPrevL = L[0];
    inp.rsPrevR = R[0];
    inp.rsHasPrev = true;
    inp.rsPos = 1;
  }
  const outCount = Math.max(0, Math.ceil((N - inp.rsPos) / ratio));
  const oL = new Float32Array(outCount);
  const oR = new Float32Array(outCount);
  let x = inp.rsPos;
  for (let i = 0; i < outCount; i++) {
    const j = Math.floor(x);
    const f = x - j;
    const l0 = j === 0 ? inp.rsPrevL : L[j - 1];
    const r0 = j === 0 ? inp.rsPrevR : R[j - 1];
    const l1 = L[j];
    const r1 = R[j];
    oL[i] = l0 + (l1 - l0) * f;
    oR[i] = r0 + (r1 - r0) * f;
    x += ratio;
  }
  inp.rsPrevL = L[N - 1];
  inp.rsPrevR = R[N - 1];
  inp.rsPos = x - N;
  return [oL, oR];
}

// Kayıt dışında da (ve kayıt öncesi 3–5 sn sağlık kontrolünde) gelen sesin gerçek saatle
// tutarlılığını ve zaman damgası sıçramalarını sürekli ölçer.
function recordInputHealth(inp, data, now) {
  const frames = data.numberOfFrames;
  const rate = data.sampleRate || SR;
  inp.sampleRate = rate;
  const durMs = (frames / rate) * 1000;
  const capUs = Number.isFinite(data.timestamp) ? data.timestamp : null;
  let jumpMs = 0;
  if (inp.hLastCapUs !== null && capUs !== null) {
    jumpMs = (capUs - inp.hLastCapUs) / 1000 - inp.hLastDurMs;
  } else if (inp.hLastAt !== null) {
    jumpMs = (now - inp.hLastAt) - inp.hLastDurMs;
  }
  inp.hLastCapUs = capUs;
  inp.hLastDurMs = durMs;
  inp.hLastAt = now;

  if (healthProbe && inp.kind === 'mic') {
    const hp = healthProbe;
    hp.chunks++;
    hp.gotMs += durMs;
    hp.sampleRate = rate;
    if (hp.firstCapUs === null && capUs !== null) hp.firstCapUs = capUs;
    if (capUs !== null) {
      hp.lastCapUs = capUs;
      hp.lastDurUs = durMs * 1000;
    }
    if (hp.chunks > 1) {
      if (jumpMs > hp.maxGapMs) hp.maxGapMs = jumpMs;
      if (jumpMs > 45) hp.gapCount++;
    }
  }
}

function softCeiling(v) {
  const a = Math.abs(v);
  if (a <= 0.95) return v;
  const s = 0.95 + 0.049 * Math.tanh((a - 0.95) / 0.049);
  return v < 0 ? -s : s;
}

function handleInput(inp, data) {
  const now = performance.now();
  inp.lastArrival = now;
  recordInputHealth(inp, data, now);
  const s = session;
  if (!s || !s.encoding) {
    inp.anchored = false;
    return;
  }
  const n0 = data.numberOfFrames;
  let L = new Float32Array(n0);
  data.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
  let R = L;
  if (data.numberOfChannels > 1) {
    R = new Float32Array(n0);
    data.copyTo(R, { planeIndex: 1, format: 'f32-planar' });
  }
  if (data.sampleRate !== SR) [L, R] = resample(inp, L, R, data.sampleRate);
  const n = L.length;
  const durUs = (n / SR) * 1e6;
  const cap = Number.isFinite(data.timestamp) ? data.timestamp : null;
  const arrivalUs = (now - s.t0) * 1000 - durUs;
  const dg = inp.diag;
  dg.chunks++;
  dg.frames += n;
  inp.rateWinGotMs += (n / SR) * 1000;
  if (cap !== null) {
    if (dg.firstCapUs === null) dg.firstCapUs = cap;
    if (dg.prevCapEndUs !== null) {
      dg.maxPtsJumpMs = Math.max(dg.maxPtsJumpMs, (cap - dg.prevCapEndUs) / 1000);
    }
    dg.prevCapEndUs = cap + durUs;
    dg.lastCapUs = cap;
    dg.lastDurUs = durUs;
  }

  if (!inp.anchored) {
    inp.useCap = cap !== null;
    inp.offset = inp.useCap ? arrivalUs - cap : 0;
    inp.nextPos = Math.max(0, Math.round((arrivalUs * SR) / 1e6));
    inp.anchored = true;
  } else {
    const capPos = Math.round((((inp.useCap ? cap + inp.offset : arrivalUs)) * SR) / 1e6);
    const diff = capPos - inp.nextPos;
    if (inp.useCap) dg.maxLagMs = Math.max(dg.maxLagMs, (arrivalUs - (cap + inp.offset)) / 1000);
    const limit = inp.useCap ? RESYNC_FRAMES : SR; // zaman damgası yoksa yalnızca büyük sapmada
    if (Math.abs(diff) > limit) {
      dg.resyncs++;
      if (diff > 0) {
        dg.gapFrames += diff;
        // Not: Windows masaüstü sesi (sys / WASAPI loopback) hiçbir uygulama ses çalmazken
        // doğal olarak paket göndermez ve ses başladığında zaman damgası sıçrar; bu normal
        // sessizliktir. Yalnızca mikrofondaki (mic) kopma gerçek ses kaybıdır.
        if (inp.kind === 'mic' && rec && !rec.paused && diff > Math.round(SR * 0.045)
            && now - (inp.lastGapPost || 0) > 2500) {
          inp.lastGapPost = now;
          post('audio-gap', { kind: 'pts-jump', ms: Math.round((diff / SR) * 1000), track: inp.kind });
        }
      }
      inp.nextPos = capPos;
    }
  }

  if (inp.ns) [L, R] = inp.ns.run(L, R);
  const m = L.length;
  const gain = gains[inp.kind];
  for (const track of s.audio) {
    if (track.sources.includes(inp.kind)) mixWrite(track, inp.kind, inp.nextPos, L, R, m, gain, now);
  }
  inp.nextPos += m;
  flushAudio(s, now);
}

function mixWrite(track, kind, pos, L, R, n, gain, now) {
  const mx = track.mix;
  if (mx.emitted === null) {
    mx.emitted = pos;
    mx.clearedTo = pos + RING;
    mx.minKept = pos;
  }
  advanceRingClear(mx);
  const limit = mx.emitted + WRITE_HEAD;
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    if (p < mx.emitted) continue; // çok geç geldi, o bölüm çoktan kodlandı
    if (p >= limit) break;
    const idx = p % RING;
    mx.l[idx] += L[i] * gain;
    mx.r[idx] += R[i] * gain;
  }
  mx.filled[kind] = Math.max(mx.filled[kind] ?? -Infinity, pos + n);
  mx.lastAt[kind] = now;
}

function flushAudio(s, now = performance.now(), forceFinal = false) {
  for (const track of s.audio) {
    const mx = track.mix;
    if (mx.emitted === null || track.recovering || !track.enc || track.enc.state !== 'configured') continue;
    let ready = forceFinal ? -Infinity : Infinity;
    for (const kind of track.sources) {
      if (!inputs[kind] || mx.filled[kind] === undefined) continue;
      if (forceFinal) {
        ready = Math.max(ready, mx.filled[kind]);
        continue;
      }
      if (now - (mx.lastAt[kind] || 0) > LIVE_MS) continue; // sessiz/kopmuş girdi beklenmez
      ready = Math.min(ready, mx.filled[kind]);
    }
    if (!Number.isFinite(ready) || ready <= mx.emitted) continue;
    while (ready - mx.emitted >= BLOCK) {
      if (!emitBlock(track, BLOCK)) break;
    }
    if (forceFinal && ready > mx.emitted) {
      emitBlock(track, ready - mx.emitted);
    }
  }
}

function emitBlock(track, n) {
  const mx = track.mix;
  const start = mx.emitted;
  const buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % RING;
    buf[i] = softCeiling(mx.l[idx]);
    buf[n + i] = softCeiling(mx.r[idx]);
  }
  const openedHere = !mx.segOpen;
  if (openedHere) {
    track.segments.push({ enc: track.encTime, wall: (start / SR) * 1e6 });
    if (track.segments.length > 32) track.segments.shift();
    mx.segOpen = true;
  }
  const out = new AudioData({
    format: 'f32-planar',
    sampleRate: SR,
    numberOfFrames: n,
    numberOfChannels: 2,
    timestamp: Math.round(track.encTime),
    data: buf,
  });
  try {
    track.enc.encode(out);
  } catch (err) {
    if (openedHere) {
      track.segments.pop();
      mx.segOpen = false;
    }
    if (track.fail) track.fail(err);
    return false;
  } finally {
    out.close();
  }
  track.encTime += (n / SR) * 1e6;
  track.emittedFrames += n;
  track.encDiag.emittedFrames += n;
  mx.emitted += n;
  advanceRingClear(mx);
  return true;
}

// Kayıt öncesi 3–5 sn otomatik ses sağlığı kontrolü: mikrofonun gerçek zamanlı örnek
// hızını, zaman damgası sürekliliğini, RNNoise hazırlığını ve ses kodlayıcıyı doğrular.
async function checkAudioHealth(msg) {
  const durationMs = Math.max(800, Math.min(8000, Number(msg.durationMs) || 3200));
  const micEnabled = !!msg.micEnabled;
  const audioOrder = msg.audioOrder || ['aac', 'opus'];
  const audioBitrate = Number(msg.audioBitrate) || 192000;

  let encoderCodec = null;
  let encoderOk = false;
  let encoderErr = null;
  try {
    const picked = await pickAudioConfig(audioOrder, audioBitrate);
    if (picked) {
      encoderCodec = picked.codec;
      let chunksOut = 0;
      const testEnc = new AudioEncoder({
        output() { chunksOut++; },
        error(e) { encoderErr = e && e.message; },
      });
      testEnc.configure(picked.cfg);
      // Windows MediaFoundation AAC en az 2 tam çerçeve (2x1024 örnek) olmadan flush() kabul etmez.
      for (let k = 0; k < 2; k++) {
        const silent = new AudioData({
          format: 'f32-planar',
          sampleRate: SR,
          numberOfFrames: 1024,
          numberOfChannels: 2,
          timestamp: Math.round((k * 1024 * 1e6) / SR),
          data: new Float32Array(1024 * 2),
        });
        try {
          testEnc.encode(silent);
        } finally {
          silent.close();
        }
      }
      const flushed = await withTimeout(testEnc.flush(), 2000);
      encoderOk = flushed !== 'timeout' && testEnc.state === 'configured' && chunksOut > 0;
      if (testEnc.state !== 'closed') testEnc.close();
    }
  } catch (err) {
    encoderErr = err && err.message;
    encoderOk = false;
  }

  if (!encoderOk) {
    post('log', { level: 'error', message: `[ses-kontrol] ses kodlayıcı doğrulanamadı (${encoderCodec}): ${encoderErr || 'bilinmiyor'}` });
    return { ok: false, code: 'audio-encoder-bad', encoderCodec };
  }

  if (!micEnabled) {
    post('log', { level: 'info', message: `[ses-kontrol] mikrofon kapalı, kodlayıcı=${encoderCodec} -> SAĞLAM` });
    return { ok: true, code: 'ok', micChecked: false, encoderCodec, ratioPct: 100 };
  }

  if (noiseStrong) {
    await loadRnnoiseEntry();
    if (inputs.mic && !inputs.mic.ns) attachDenoiser(inputs.mic);
  }

  const probe = {
    startedAt: performance.now(),
    chunks: 0,
    gotMs: 0,
    firstCapUs: null,
    lastCapUs: null,
    lastDurUs: 0,
    maxGapMs: 0,
    gapCount: 0,
    sampleRate: inputs.mic ? inputs.mic.sampleRate : SR,
    cancelled: false,
    cancelResolve: null,
  };
  healthProbe = probe;
  try {
    await Promise.race([
      waitMs(durationMs),
      new Promise((resolve) => { probe.cancelResolve = resolve; }),
    ]);
  } finally {
    if (healthProbe === probe) healthProbe = null;
  }

  if (probe.cancelled) return { ok: false, cancelled: true, code: 'cancelled' };

  const wallMs = Math.max(1, performance.now() - probe.startedAt);
  const ratio = probe.gotMs / wallMs;
  const ratioPct = Math.round(ratio * 1000) / 10;
  const tsSpanMs = probe.firstCapUs !== null && probe.lastCapUs !== null
    ? (probe.lastCapUs - probe.firstCapUs + probe.lastDurUs) / 1000
    : probe.gotMs;
  const maxGapMs = Math.round(probe.maxGapMs);
  const rnnoiseReady = noiseStrong ? !!(inputs.mic && inputs.mic.ns && inputs.mic.ns.ready) : null;

  let code = 'ok';
  if (!inputs.mic || probe.chunks < 5 || probe.gotMs < 200) code = 'mic-no-data';
  else if (ratio < 0.96) code = 'mic-rate-low';
  else if (maxGapMs > 65 || probe.gapCount > 1) code = 'mic-gaps';
  else if (noiseStrong && !rnnoiseReady) code = 'rnnoise-failed';

  const ok = code === 'ok';
  post('log', {
    level: ok ? 'info' : 'error',
    message: `[ses-kontrol] süre=${(wallMs / 1000).toFixed(2)}s örnek=${(probe.gotMs / 1000).toFixed(2)}s `
      + `(%${ratioPct}) tsAralık=${(tsSpanMs / 1000).toFixed(2)}s parça=${probe.chunks} `
      + `enBüyükBoşluk=${maxGapMs}ms boşlukSayısı=${probe.gapCount} sr=${probe.sampleRate}Hz `
      + `kodlayıcı=${encoderCodec}${noiseStrong ? ` rnnoise=${rnnoiseReady}` : ''} -> ${ok ? 'SAĞLAM' : code}`,
  });

  return {
    ok,
    code,
    ratioPct,
    gotMs: Math.round(probe.gotMs),
    wallMs: Math.round(wallMs),
    tsSpanMs: Math.round(tsSpanMs),
    chunks: probe.chunks,
    maxGapMs,
    gapCount: probe.gapCount,
    sampleRate: probe.sampleRate,
    encoderCodec,
    rnnoiseReady,
  };
}

// Bir girdi tamamen susarsa (ör. mikrofon kablosu) öbürünü bekletmemek için düzenli boşalt;
// açık mikrofondan 400 ms veri gelmezse ya da 2 sn'lik pencerede örnek hızı gerçek saatin
// %95'inin altına düşerse (ör. eski %65 hatası) kullanıcıyı anında uyar.
setInterval(() => {
  const s = session;
  if (!s || !s.encoding) return;
  const now = performance.now();
  flushAudio(s, now);
  const mic = inputs.mic;
  if (!rec || rec.paused) {
    if (mic) {
      mic.rateWinGotMs = 0;
      mic.rateWinSince = now;
    }
    return;
  }
  if (mic && gains.mic > 0) {
    if (mic.lastArrival && now - mic.lastArrival > LIVE_MS && now - (mic.lastGapPost || 0) > 2500) {
      mic.lastGapPost = now;
      post('audio-gap', { kind: 'stall', ms: Math.round(now - mic.lastArrival), track: 'mic' });
    }
    const winMs = now - (mic.rateWinSince || now);
    if (winMs >= 2000) {
      const ratio = mic.rateWinGotMs / winMs;
      if (ratio < 0.95 && now - (mic.lastGapPost || 0) > 2500) {
        mic.lastGapPost = now;
        post('audio-gap', {
          kind: 'rate',
          ratio: Math.round(ratio * 100),
          ms: Math.round(winMs - mic.rateWinGotMs),
          track: 'mic',
        });
      }
      mic.rateWinGotMs = 0;
      mic.rateWinSince = now;
    }
  }
}, 100);

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
  const ed = track.encDiag;
  ed.pkts++;
  ed.audioS += pkt.duration;
  if (ed.firstPts === null) ed.firstPts = pkt.timestamp;
  if (ed.prevEnd !== null) ed.maxGapMs = Math.max(ed.maxGapMs, (pkt.timestamp - ed.prevEnd) * 1000);
  ed.prevEnd = pkt.timestamp + pkt.duration;
  ed.lastPts = pkt.timestamp;
  ed.lastDur = pkt.duration;
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
    this.vLast = -1;
    this.aStarted = aSources.map(() => false);
    this.aLast = aSources.map(() => -1);
    this.pendingAudio = [];
    // Görüntüsüz (yalnızca ses) kayıt: anahtar kare beklenmez, zaman ilk ses paketinden başlar.
    this.audioOnly = !vSource;
    if (this.audioOnly) this.waitKey = false;
    this.resumeGap = false;
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
    if (ts < 0 || ts < this.vLast) return;
    this.vLast = ts + pkt.duration * 0.5;
    this.lastEnd = pkt.timestamp + pkt.duration;
    this.duration = ts + pkt.duration;
    const meta = this.vStarted ? undefined : { decoderConfig: this.s.vConfig };
    this.vStarted = true;
    const out = pkt.clone({ timestamp: ts });
    this.enqueue(() => this.vSource.add(out, meta));
  }

  pushAudio(index, pkt) {
    if (this.paused) return;
    if (this.audioOnly) {
      if (this.base === null) this.base = pkt.timestamp;
      if (this.resumeGap) {
        // Duraklatmadan sonra: kodlayıcının içinde kalmış, duraklatmadan hemen önceki
        // paketler önce gelir (zamanları kesintisiz). İlk gerçek sıçramada aradaki
        // süreyi kayıttan çıkar.
        const gap = pkt.timestamp - this.pauseAt;
        if (gap > 0.1) {
          this.pausedTotal += gap;
          this.resumeGap = false;
        } else {
          this.pauseAt = Math.max(this.pauseAt, pkt.timestamp + pkt.duration);
          if (++this.resumeSeen > 100) this.resumeGap = false;
        }
      }
      this.lastEnd = Math.max(this.lastEnd, pkt.timestamp + pkt.duration);
    }
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
    if (this.audioOnly) this.duration = Math.max(this.duration, ts + pkt.duration);
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
    if (this.audioOnly) {
      this.resumeGap = true;
      this.resumeSeen = 0;
      return;
    }
    this.waitKey = true;
    this.s.forceKey = true;
  }

  async finish() {
    await this.chain;
    if (this.failed) {
      // Kurtarma: dosyayı yine de düzgün kapatmayı dene (yazma hatasında başarısız
      // olabilir; o durumda o ana kadar yazılmış MKV kümeleri yine oynatılabilir).
      await withTimeout(this.output.finalize().catch(() => {}), 5000);
      throw this.failed;
    }
    if (!this.vStarted && !(this.audioOnly && this.aStarted.some(Boolean))) {
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
  if (container === 'm4a') format = new Mp4OutputFormat({ fastStart: false });
  else if (container === 'mkv') format = new MkvOutputFormat();
  else if (container === 'webm') format = new WebMOutputFormat();
  else format = new Mp4OutputFormat({ fastStart: crashSafe ? 'fragmented' : false });

  const file = makeFile(fileId);
  const streaming = (container !== 'mp4' && container !== 'm4a') || crashSafe;
  const output = new Output({
    format,
    target: new StreamTarget(file.writable, streaming ? {} : { chunked: true, chunkSize: 2 * 1024 * 1024 }),
  });
  let vSource = null;
  if (s.video) {
    vSource = new EncodedVideoPacketSource(MB_VIDEO[s.video.codec]);
    output.addVideoTrack(vSource, { frameRate: s.fps });
  }
  const aSources = s.audio.map((track) => {
    const source = new EncodedAudioPacketSource(s.aCodec);
    output.addAudioTrack(source, { name: track.name });
    return source;
  });
  await output.start();
  return new Sink(s, output, file, vSource, aSources);
}

async function flushEncoders(s) {
  // Kodlayıcı kuyruklarını boşaltmadan önce karıştırıcıda bekleyen son ses örneklerini akıt;
  // kurtarma sürüyorsa tamamlanmasını kısaca bekle.
  const deadline = performance.now() + 2500;
  while ((s.videoRecovering || s.audio.some((a) => a.recovering)) && performance.now() < deadline) {
    await waitMs(50);
  }
  flushAudio(s, performance.now(), true);
  const jobs = [];
  if (s.venc && s.venc.state === 'configured') jobs.push(s.venc.flush());
  for (const a of s.audio) if (a.enc && a.enc.state === 'configured') jobs.push(a.enc.flush());
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
  // Kayıt sürerken 10 saniyede bir ses zincirinin her düğümünü (1: yakalama, 2: karıştırıcı,
  // 3: kodlayıcı) gerçek saatle karşılaştırıp günlüğe yazar; kayıp olursa hangi düğümde
  // oluştuğu doğrudan görülür.
  setInterval(() => {
    const s = session;
    if (!s || !s.encoding || !rec || rec.paused) return;
    const now = performance.now();
    for (const inp of Object.values(inputs)) {
      if (!inp) continue;
      const dg = inp.diag;
      const wallS = (now - dg.since) / 1000;
      if (wallS < 1) continue;
      const got = dg.frames / SR;
      const tsSpanS = dg.firstCapUs !== null && dg.lastCapUs !== null
        ? (dg.lastCapUs - dg.firstCapUs + dg.lastDurUs) / 1e6
        : got;
      // Masaüstü sistem sesi (sys) hiçbir uygulama çalmazken paket göndermez; bu hata değildir.
      const isBad = inp.kind === 'mic' && gains.mic > 0 && (got < wallS * 0.97 || dg.gapFrames > SR * 0.045);
      post('log', {
        level: isBad ? 'error' : 'info',
        message: `[yakalama ${inp.kind}] duvar=${wallS.toFixed(2)}s örnek=${got.toFixed(2)}s `
          + `tsAralık=${tsSpanS.toFixed(2)}s parça=${dg.chunks} sr=${inp.sampleRate}Hz `
          + `enBüyükTsSıçraması=${Math.round(dg.maxPtsJumpMs)}ms hizalama=${dg.resyncs} `
          + `boşluk=${Math.round((dg.gapFrames / SR) * 1000)}ms gecikme=${Math.round(dg.maxLagMs)}ms`
          + `${inp.ns ? ' RNNoise=açık' : ''}`,
      });
      inp.diag = newDiag();
    }
    for (const track of s.audio) {
      const ed = track.encDiag;
      const wallS = (now - ed.since) / 1000;
      if (wallS < 1) continue;
      const emittedS = ed.emittedFrames / SR;
      const ptsSpanS = ed.firstPts !== null && ed.lastPts !== null
        ? (ed.lastPts - ed.firstPts + ed.lastDur)
        : ed.audioS;
      const q = track.enc && track.enc.state === 'configured' ? track.enc.encodeQueueSize : -1;
      const bad = ed.maxGapMs > 45 || q > 50;
      post('log', {
        level: bad ? 'error' : 'info',
        message: `[karıştırıcı->kodlayıcı ${track.name}] duvar=${wallS.toFixed(2)}s `
          + `karıştırıcıÇıkışı=${emittedS.toFixed(2)}s kodlananSes=${ed.audioS.toFixed(2)}s `
          + `ptsAralık=${ptsSpanS.toFixed(2)}s paket=${ed.pkts} enBüyükPtsBoşluk=${Math.round(ed.maxGapMs)}ms `
          + `kodek=${s.aCodec} kurtarma=${track.recoveries} kuyruk=${q}`,
      });
      track.encDiag = newEncDiag();
    }
  }, 10000);
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
      stats.queue = s.venc ? s.venc.encodeQueueSize : 0;
      stats.audioOnly = !!s.audioOnly;
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
  'audio-input'(msg) {
    setInput(msg.kind, msg.readable || null);
  },

  'audio-gains'(msg) {
    gains.mic = Number(msg.mic) || 0;
    gains.sys = Number(msg.sys) || 0;
  },

  'audio-noise'(msg) {
    noiseStrong = !!msg.strong;
    const mic = inputs.mic;
    if (noiseStrong) {
      if (mic && !mic.ns) attachDenoiser(mic);
      else if (!mic) loadRnnoiseEntry();
    } else {
      detachDenoiser(mic);
    }
  },

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
  'audio-health': checkAudioHealth,
  'audio-health-cancel'() {
    if (healthProbe) {
      healthProbe.cancelled = true;
      if (healthProbe.cancelResolve) healthProbe.cancelResolve();
    }
  },
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
