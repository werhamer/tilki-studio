/*
 * Tilki Studio — yakalama katmanı (arayüz iş parçacığı)
 * Ekranı, kamerayı ve sesi yakalar; kareleri worker'a aktarır; ses mikserini yönetir.
 */

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';

const api = window.tilki;

// Mikrofon gürültü engelleme seviyesi. Eski sürümlerde yalnızca açık/kapalı vardı.
export function micNoiseLevel(mic) {
  if (mic.noiseLevel === 'off' || mic.noiseLevel === 'standard' || mic.noiseLevel === 'strong') return mic.noiseLevel;
  return mic.noiseSuppression === false ? 'off' : 'standard';
}

const CODEC_ORDER = {
  mp4: { video: ['h264', 'hevc', 'av1', 'vp9'], audio: ['aac', 'opus'] },
  mkv: { video: ['h264', 'hevc', 'av1', 'vp9', 'vp8'], audio: ['aac', 'opus'] },
  webm: { video: ['vp9', 'av1', 'vp8'], audio: ['opus'] },
};

function stopStream(stream) {
  if (stream) for (const track of stream.getTracks()) track.stop();
}

async function createMixerContext(settings) {
  const test = settings.selftest && settings.selftest.sinkMatch;
  if (test) {
    // Yalnızca test: eski davranışı (belirli bir çıkış aygıtının saati) taklit et.
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const dev = devices.find((d) => d.kind === 'audiooutput' && d.label.includes(test));
    const ctx = new AudioContext({ sampleRate: 48000, ...(dev ? { sinkId: dev.deviceId } : {}) });
    ctx.__tilkiSink = dev ? `device:${dev.label}` : 'default';
    return ctx;
  }
  // Not: sinkId { type: 'none' } denendi; Chromium'un zamanlayıcılı sessiz çıkışı bu
  // makinede düzenli boşluk üretti (%2–7). Varsayılan çıkışın saati daha kararlı.
  const ctx = new AudioContext({ sampleRate: 48000 });
  ctx.__tilkiSink = 'default';
  return ctx;
}

export class Engine extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.settings = null;
    this.worker = null;
    this.calls = new Map();
    this.callId = 0;

    this.source = null; // { id, name, type }
    this.screenStream = null;
    this.camStream = null;
    this.micStream = null;
    this.systemAvailable = false;

    this.dims = { outW: 0, outH: 0, srcW: 0, srcH: 0 };
    this.crop = null;
    this.cropEditing = false;

    this.sessionInfo = null;
    this.sessionPromise = null;
    this.sessionClosing = null;
    this.recordingTransition = false;
    this.sessionTracks = [];
    this.recFile = null;
    this.recording = false;
    this.paused = false;
    this.replayOn = false;
    this.busy = false;
    this.recDuration = 0;
    this.micLost = false;
    this.micRetry = null;
    this.micBusy = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------------------------------------------------------------- kurulum

  async init(settings) {
    this.settings = settings;
    // Test kancası: "hang" adlı worker ekran kartı sorgularının yanıtsız kaldığını taklit eder.
    const hang = !!(settings.selftest && settings.selftest.hangQueries);
    // Test kancası: "stall" adlı worker, ekran kartı çöktükten sonraki gibi düzenli takılır.
    const stall = !!(settings.selftest && settings.selftest.stallWorker);
    const drop = !!(settings.selftest && settings.selftest.dropAudio);
    this.worker = new Worker('dist/worker.js', { name: hang ? 'hang' : stall ? 'stall' : drop ? 'dropaudio' : 'tilki' });
    this.worker.onmessage = (event) => this.onWorkerMessage(event.data);
    this.worker.onerror = (event) => this.emit('error', { message: event.message || 'worker' });

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    this.pushConfig();
    this.pushLayout();

    // Ses karıştırıcısı varsayılan çıkış aygıtının saatiyle çalışır. Bu saat aksarsa
    // (gerçek kullanımda görüldü: gerçek zamanın ~%65'i) startRenderWatch ve worker'daki
    // boşluk denetimi kayıt sırasında büyük uyarı gösterir.
    const ctx = await createMixerContext(settings);
    this.audio = ctx;
    this.audioSink = ctx.__tilkiSink || 'none';
    this.startRenderWatch();
    const dest = () => {
      const node = ctx.createMediaStreamDestination();
      node.channelCount = 2;
      node.channelCountMode = 'explicit';
      return node;
    };
    // Web Audio artık yalnızca seviye göstergeleri için; kayıt sesi doğrudan
    // yakalanıp worker'da karıştırılıyor (bkz. worker.js "ses: doğrudan yakalama").
    void dest;
    const strip = () => {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(analyser);
      return { gain, analyser, node: null, buffer: new Float32Array(analyser.fftSize) };
    };
    this.sys = strip();
    this.mic = strip();
    this.inputClones = { mic: null, sys: null };
    this.applyVolumes();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  // Karıştırıcının gerçek zamanlı çalıştığını izle: 10 sn'de ilerleyen ses saati duvar
  // saatinin %97'sinden azsa ses eksik üretiliyordur. Kayıt sırasında bu bir hatadır.
  startRenderWatch() {
    let last = { ct: this.audio.currentTime, pn: performance.now() };
    setInterval(() => {
      const now = { ct: this.audio.currentTime, pn: performance.now() };
      const wall = (now.pn - last.pn) / 1000;
      const ratio = wall > 0 ? (now.ct - last.ct) / wall : 1;
      last = now;
      this.renderRatio = ratio;
      if (!this.recording) return;
      const ok = ratio > 0.97 && ratio < 1.03;
      api.log(ok ? 'info' : 'error',
        `[karıştırıcı] hız ${(ratio * 100).toFixed(1)}% (çıkış: ${this.audioSink}, durum: ${this.audio.state})`);
      // Kayıt sesi artık bu saate bağlı değil; yalnızca bilgi olarak yazılır.
    }, 10000);
  }

  resumeAudio() {
    if (this.audio && this.audio.state !== 'running') this.audio.resume().catch(() => {});
  }

  call(type, data = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.callId;
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...data }, transfer);
    });
  }

  send(type, data = {}, transfer = []) {
    this.worker.postMessage({ type, ...data }, transfer);
  }

  onWorkerMessage(msg) {
    switch (msg.type) {
      case 'reply': {
        const pending = this.calls.get(msg.id);
        if (!pending) return;
        this.calls.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
        break;
      }
      case 'file-write':
        api.writeFile(msg.fileId, msg.data, msg.position).then(
          () => this.send('file-ack', { seq: msg.seq }),
          (err) => this.send('file-ack', { seq: msg.seq, error: String(err && err.message) }),
        );
        break;
      case 'dims':
        this.dims = { outW: msg.outW, outH: msg.outH, srcW: msg.srcW, srcH: msg.srcH };
        this.emit('dims', this.dims);
        break;
      case 'log':
        api.log(msg.level || 'info', msg.message);
        break;
      case 'noise-state':
        this.rnnoiseActive = !!msg.strong;
        break;
      case 'audio-gap':
        this.emit('audio-problem', { kind: 'gap', ms: msg.ms, track: msg.track });
        break;
      case 'stats':
        if (msg.stats && msg.stats.rec) this.recDuration = msg.stats.rec.duration;
        this.emit('stats', msg.stats);
        break;
      case 'fatal':
        this.emit('fatal', { message: msg.message });
        break;
      case 'error':
        this.emit('error', { message: msg.message });
        break;
    }
  }

  pushConfig() {
    const { codec, container, fps, quality, resolution } = this.settings;
    const { video } = CODEC_ORDER[container] || CODEC_ORDER.mp4;
    const videoOrder = video.includes(codec) ? [codec, ...video.filter((item) => item !== codec)] : video;
    this.send('config', { config: { fps, resolution, quality, videoOrder } });
  }

  prepareVideo() {
    this.send('prepare-video');
  }

  pushLayout() {
    this.send('layout', {
      layout: { cam: this.settings.camera, crop: this.crop, cropEditing: this.cropEditing },
    });
  }

  setPreviewSize(width, height) {
    this.send('preview', { width, height });
  }

  setPreviewVisible(visible) {
    this.send('preview', { visible });
  }

  get sessionActive() {
    return !!this.sessionInfo;
  }

  // ---------------------------------------------------------------- ekran kaynağı

  async setSource(source) {
    const fps = this.settings.fps;
    // Sadece ses modunda görüntü kaydedilmez; ekran yakalama yalnızca sistem sesi için
    // açık tutulur ve en küçük boyuta / 1 fps'e indirilir. Böylece ekran kartı (ve onun
    // çökmeleri) ses kaydını etkilemez.
    const audioMode = this.settings.recordMode === 'audio';
    this.sourceMode = audioMode ? 'audio' : 'video';
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxWidth: audioMode ? 320 : 7680,
        maxHeight: audioMode ? 180 : 4320,
        maxFrameRate: audioMode ? 1 : fps,
      },
    };
    let stream;
    let withAudio = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video,
      });
    } catch {
      // Sistem sesi alınamadıysa yalnızca görüntüyle devam et.
      withAudio = false;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    }

    const old = this.screenStream;
    this.screenStream = stream;
    this.source = source;
    if (!this.sessionActive) this.crop = null;

    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => {
      if (this.screenStream !== stream) return;
      this.clearSource();
      this.emit('source-ended', {});
    });
    const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 2 });
    this.send('screen', { readable: processor.readable }, [processor.readable]);
    this.pushLayout();

    if (this.sys.node) this.sys.node.disconnect();
    this.sys.node = null;
    this.systemAvailable = withAudio && stream.getAudioTracks().length > 0;
    if (this.systemAvailable) {
      this.sys.node = this.audio.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      this.sys.node.connect(this.sys.gain);
    }
    this.sendInput('sys', this.systemAvailable ? stream.getAudioTracks()[0] : null);
    stopStream(old);
    this.emit('source', { source, systemAvailable: this.systemAvailable });
  }

  clearSource() {
    stopStream(this.screenStream);
    this.screenStream = null;
    this.source = null;
    if (this.sys.node) this.sys.node.disconnect();
    this.sys.node = null;
    this.systemAvailable = false;
    this.sendInput('sys', null);
    this.send('screen', { readable: null });
  }

  // ---------------------------------------------------------------- ses

  applyVolumes() {
    const { system, mic } = this.settings;
    const now = this.audio.currentTime;
    this.sys.gain.gain.setTargetAtTime(system.enabled ? system.volume : 0, now, 0.015);
    this.mic.gain.gain.setTargetAtTime(mic.enabled ? mic.volume : 0, now, 0.015);
    this.send('audio-gains', { mic: mic.enabled ? mic.volume : 0, sys: system.enabled ? system.volume : 0 });
  }

  // Kayıt için ses girdisini (mikrofon / sistem sesi) worker'a doğrudan bağla.
  sendInput(kind, track) {
    const old = this.inputClones[kind];
    if (old) old.stop();
    this.inputClones[kind] = null;
    if (!track || track.readyState === 'ended') {
      this.send('audio-input', { kind, readable: null });
      return;
    }
    const clone = track.clone();
    this.inputClones[kind] = clone;
    const processor = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 500 });
    this.send('audio-input', { kind, readable: processor.readable }, [processor.readable]);
  }

  // Aynı anda birden fazla mikrofon yenilemesi çalışmasın (yeniden bağlanma + kullanıcı).
  refreshMic(opts = {}) {
    const run = (this.micBusy || Promise.resolve()).then(() => this.openMic(opts));
    this.micBusy = run.catch(() => false);
    return run;
  }

  stopMicRetry() {
    clearInterval(this.micRetry);
    this.micRetry = null;
  }

  // Mikrofon kaydın ortasında koparsa (USB çıktı, sürücü sıfırlandı, başka uygulama
  // aygıtı kilitledi) sessizce yorumsuz kayıt almak yerine uyar ve geri bağlanmayı dene.
  onMicLost() {
    if (this.micLost) return;
    this.micLost = true;
    if (this.mic.node) this.mic.node.disconnect();
    this.mic.node = null;
    this.micStream = null;
    this.sendInput('mic', null);
    this.emit('mic-lost', {});
    this.stopMicRetry();
    this.micRetry = setInterval(async () => {
      if (!this.settings.mic.enabled) {
        this.stopMicRetry();
        this.micLost = false;
        return;
      }
      if (await this.refreshMic({ quiet: true })) {
        this.stopMicRetry();
        this.emit('mic-restored', {});
      }
    }, 3000);
  }

  // RNNoise (güçlü gürültü engelleme) bir kez yüklenir. Yüklenemezse null döner ve
  // mikrofon normal gürültü engellemeyle çalışmaya devam eder; kayıt gecikmez.
  loadRnnoise() {
    if (!this.rnnoiseReady) {
      this.rnnoiseReady = (async () => {
        const wasm = await loadRnnoise({ url: 'dist/rnnoise/rnnoise.wasm', simdUrl: 'dist/rnnoise/rnnoise_simd.wasm' });
        await this.audio.audioWorklet.addModule('dist/rnnoise/workletProcessor.js');
        return wasm;
      })().catch((err) => {
        console.error('[rnnoise]', err);
        this.rnnoiseReady = null;
        return null;
      });
    }
    return this.rnnoiseReady;
  }

  async openMic({ quiet = false } = {}) {
    const cfg = this.settings.mic;
    if (this.mic.node) this.mic.node.disconnect();
    this.mic.node = null;
    if (this.mic.fx) {
      this.mic.fx.disconnect();
      try {
        this.mic.fx.destroy();
      } catch {}
      this.mic.fx = null;
    }
    stopStream(this.micStream);
    this.micStream = null;
    if (!cfg.enabled) {
      this.stopMicRetry();
      this.micLost = false;
      this.sendInput('mic', null);
      return true;
    }
    const level = micNoiseLevel(cfg);
    // Güçlü seviyede RNNoise tek başına çalışır (Chromium'unkiyle üst üste binince ses bozulur).
    const constraints = (deviceId) => ({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: !!cfg.echoCancellation,
        autoGainControl: false,
        noiseSuppression: level === 'standard',
        channelCount: { ideal: 2 },
      },
    });
    // Güçlü seviyede RNNoise kayıt motorunda (worker) uygulanır.
    this.send('audio-noise', { strong: level === 'strong' });
    try {
      let stream;
      let fallback = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(cfg.deviceId));
      } catch (err) {
        if (!cfg.deviceId || cfg.deviceId === 'default') throw err;
        // İzin reddi varsayılan aygıtta da aynı olur; yalnızca aygıt bulunamadıysa dene.
        if (err && err.name === 'NotAllowedError') throw err;
        stream = await navigator.mediaDevices.getUserMedia(constraints('default'));
        fallback = true;
      }
      this.micStream = stream;
      this.mic.node = this.audio.createMediaStreamSource(stream);
      this.micNoiseActive = level;
      this.mic.node.connect(this.mic.gain);
      const track = stream.getAudioTracks()[0];
      this.sendInput('mic', track);
      // Uygulanan mikrofon ayarlarını günlüğe yaz (gürültü/yankı engelleme gerçekten açık mı?).
      if (track) {
        const st = track.getSettings();
        this.micTrackSettings = {
          label: track.label,
          noiseSuppression: st.noiseSuppression,
          echoCancellation: st.echoCancellation,
          autoGainControl: st.autoGainControl,
          sampleRate: st.sampleRate,
          channelCount: st.channelCount,
          rnnoise: level === 'strong',
        };
        api.log('info', `mikrofon açıldı: seviye=${level} uygulanan=${JSON.stringify(this.micTrackSettings)}`);
      }
      if (track) {
        track.addEventListener('ended', () => {
          if (this.micStream === stream) this.onMicLost();
        });
      }
      this.micLost = false;
      this.micError = null;
      if (fallback) this.emit('mic-fallback', { label: track ? track.label : '' });
      return true;
    } catch (err) {
      this.micError = { name: err && err.name, message: String(err && err.message) };
      this.sendInput('mic', null);
      if (!quiet) this.emit('mic-error', this.micError);
      return false;
    }
  }

  levels() {
    const peak = (strip) => {
      if (!strip.node) return 0;
      strip.analyser.getFloatTimeDomainData(strip.buffer);
      let max = 0;
      for (let i = 0; i < strip.buffer.length; i++) {
        const v = Math.abs(strip.buffer[i]);
        if (v > max) max = v;
      }
      return max;
    };
    return { system: peak(this.sys), mic: peak(this.mic) };
  }

  // ---------------------------------------------------------------- kamera

  async refreshCamera() {
    const cfg = this.settings.camera;
    stopStream(this.camStream);
    this.camStream = null;
    if (!cfg.enabled) {
      this.send('cam', { readable: null });
      this.pushLayout();
      return true;
    }
    const constraints = (deviceId) => ({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(cfg.deviceId));
      } catch (err) {
        if (!cfg.deviceId) throw err;
        stream = await navigator.mediaDevices.getUserMedia(constraints(''));
      }
      this.attachCamera(stream);
      return true;
    } catch (err) {
      this.send('cam', { readable: null });
      this.emit('camera-error', { message: String(err && err.message) });
      return false;
    }
  }

  attachCamera(stream) {
    this.camStream = stream;
    const processor = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0], maxBufferSize: 2 });
    this.send('cam', { readable: processor.readable }, [processor.readable]);
    this.pushLayout();
  }

  // ---------------------------------------------------------------- bölge

  setCropEditing(on) {
    this.cropEditing = on;
    this.pushLayout();
  }

  setCrop(crop) {
    this.crop = crop;
    this.cropEditing = false;
    this.pushLayout();
  }

  // ---------------------------------------------------------------- oturum

  async ensureSession() {
    if (this.sessionClosing) await this.sessionClosing;
    if (this.sessionInfo) return this.sessionInfo;
    if (!this.screenStream && this.settings.recordMode !== 'audio') throw new Error('no-source');
    if (!this.sessionPromise) {
      this.sessionPromise = this.openSession().finally(() => { this.sessionPromise = null; });
    }
    return this.sessionPromise;
  }

  async openSession() {
    this.resumeAudio();
    const s = this.settings;
    const audioOnly = s.recordMode === 'audio';
    // Sadece ses kaydı her yerde açılan .m4a (AAC) dosyasına yazılır.
    const container = audioOnly ? 'm4a' : s.container;
    const order = audioOnly ? CODEC_ORDER.mp4 : CODEC_ORDER[s.container] || CODEC_ORDER.mp4;
    const outputs = s.separateTracks
      ? [{ name: 'System', sources: ['sys'] }, { name: 'Microphone', sources: ['mic'] }]
      : [{ name: 'Audio', sources: ['mic', 'sys'] }];
    try {
      this.sessionInfo = await this.call(
        'session-start',
        {
          // Sadece seste Opus: işlemcide kodlanır. Windows'ta AAC ekran kartı sürecinde
          // çalışıyor; o süreç çökünce ses kodlayıcı da ölüp kaydı bölüyordu.
          audioOrder: audioOnly ? ['opus', 'aac'] : order.audio,
          audioBitrate: s.audioBitrate * 1000,
          outputs,
          audioOnly,
        },
      );
    } catch (err) {
      this.releaseSessionTracks();
      throw err;
    }
    this.sessionContainer = container;
    this.emit('session', this.sessionInfo);
    return this.sessionInfo;
  }

  releaseSessionTracks() {
    for (const track of this.sessionTracks) track.stop();
    this.sessionTracks = [];
  }

  async endSessionIfIdle() {
    if (this.sessionClosing) return this.sessionClosing;
    if (!this.sessionInfo || this.recordingTransition || this.recording || this.replayOn) return;
    this.sessionClosing = this.call('session-stop').catch(() => {}).then(() => {
      this.sessionInfo = null;
      this.releaseSessionTracks();
      this.emit('session', null);
    }).finally(() => { this.sessionClosing = null; });
    return this.sessionClosing;
  }

  // ---------------------------------------------------------------- kayıt

  async startRecording() {
    if (this.recording || this.recordingTransition) return;
    this.recordingTransition = true;
    let file;
    try {
      // Son güvenlik: kodlayıcı hiçbir şekilde hazırlanamazsa kullanıcı sonsuza
      // kadar "Başlatılıyor…" ekranında kalmasın.
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('start-timeout')), 25000);
      });
      try {
        await Promise.race([this.ensureSession(), timeout]);
      } catch (err) {
        if (err.message === 'start-timeout') this.sessionPromise = null;
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const container = this.sessionContainer;
      file = await api.openFile({ kind: 'recording', ext: container });
      await this.call('rec-start', {
        fileId: file.id,
        container,
        crashSafe: !!this.settings.crashSafe,
      });
      this.recFile = file;
      this.recording = true;
      this.paused = false;
    } catch (err) {
      if (file) await api.abortFile(file.id);
      throw err;
    } finally {
      this.recordingTransition = false;
      await this.endSessionIfIdle();
    }
  }

  pauseRecording() {
    if (!this.recording || this.paused) return;
    this.paused = true;
    this.send('rec-pause');
  }

  resumeRecording() {
    if (!this.recording || !this.paused) return;
    this.paused = false;
    this.send('rec-resume');
  }

  async stopRecording() {
    if (!this.recording) return null;
    const file = this.recFile;
    this.recordingTransition = true;
    this.recording = false;
    this.paused = false;
    this.recFile = null;
    let result = null;
    let failure = null;
    try {
      result = await this.call('rec-stop');
    } catch (err) {
      failure = err;
    } finally {
      this.recordingTransition = false;
      await this.endSessionIfIdle();
    }
    if (failure || !result) {
      const err = failure || new Error('empty-recording');
      if (err.message === 'empty-recording') {
        await api.abortFile(file.id);
        throw err;
      }
      // Eskiden burada dosya siliniyordu: bir yazma/kodlayıcı hatası dakikalarca
      // süren kaydı yok ediyordu. Artık o ana kadar yazılan kısım korunur.
      const kept = await api.salvageFile(file.id).catch(() => null);
      if (!kept) throw err;
      return { ...kept, duration: this.recDuration, partial: true, error: err.message };
    }
    const info = await api.closeFile(file.id);
    return { ...info, duration: result.duration };
  }

  // ---------------------------------------------------------------- anlık tekrar

  async setReplay(enabled) {
    if (enabled) {
      await this.ensureSession();
      this.replayOn = true;
      this.send('replay', { enabled: true, seconds: this.settings.replaySeconds });
    } else {
      this.replayOn = false;
      this.send('replay', { enabled: false });
      await this.endSessionIfIdle();
    }
  }

  setReplaySeconds(seconds) {
    if (this.replayOn) this.send('replay', { enabled: true, seconds });
  }

  async saveReplay() {
    if (!this.replayOn) throw new Error('replay-off');
    const container = this.sessionContainer;
    const file = await api.openFile({ kind: 'replay', ext: container });
    try {
      const result = await this.call('replay-save', { fileId: file.id, container });
      const info = await api.closeFile(file.id);
      return { ...info, duration: result.duration };
    } catch (err) {
      await api.abortFile(file.id);
      throw err;
    }
  }

  // ---------------------------------------------------------------- diğer

  async screenshot() {
    if (!this.screenStream) throw new Error('no-source');
    const result = await this.call('screenshot');
    return api.saveImage(new Uint8Array(result.buffer));
  }

  probe() {
    return this.call('probe');
  }
}
