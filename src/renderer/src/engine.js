/*
 * Tilki Studio — yakalama katmanı (arayüz iş parçacığı)
 * Ekranı, kamerayı ve sesi yakalar; kareleri worker'a aktarır; ses mikserini yönetir.
 */

const api = window.tilki;

const CODEC_ORDER = {
  mp4: { video: ['h264', 'hevc', 'av1', 'vp9'], audio: ['aac', 'opus'] },
  mkv: { video: ['h264', 'hevc', 'av1', 'vp9', 'vp8'], audio: ['aac', 'opus'] },
  webm: { video: ['vp9', 'av1', 'vp8'], audio: ['opus'] },
};

function stopStream(stream) {
  if (stream) for (const track of stream.getTracks()) track.stop();
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
    this.worker = new Worker('dist/worker.js', { name: hang ? 'hang' : 'tilki' });
    this.worker.onmessage = (event) => this.onWorkerMessage(event.data);
    this.worker.onerror = (event) => this.emit('error', { message: event.message || 'worker' });

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    this.pushConfig();
    this.pushLayout();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.audio = ctx;
    const dest = () => {
      const node = ctx.createMediaStreamDestination();
      node.channelCount = 2;
      node.channelCountMode = 'explicit';
      return node;
    };
    this.mixDest = dest();
    this.sysDest = dest();
    this.micDest = dest();
    const strip = (own) => {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(analyser);
      gain.connect(this.mixDest);
      gain.connect(own);
      return { gain, analyser, node: null, buffer: new Float32Array(analyser.fftSize) };
    };
    this.sys = strip(this.sysDest);
    this.mic = strip(this.micDest);
    this.applyVolumes();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
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
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxWidth: 7680,
        maxHeight: 4320,
        maxFrameRate: fps,
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
    this.send('screen', { readable: null });
  }

  // ---------------------------------------------------------------- ses

  applyVolumes() {
    const { system, mic } = this.settings;
    const now = this.audio.currentTime;
    this.sys.gain.gain.setTargetAtTime(system.enabled ? system.volume : 0, now, 0.015);
    this.mic.gain.gain.setTargetAtTime(mic.enabled ? mic.volume : 0, now, 0.015);
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

  async openMic({ quiet = false } = {}) {
    const cfg = this.settings.mic;
    if (this.mic.node) this.mic.node.disconnect();
    this.mic.node = null;
    stopStream(this.micStream);
    this.micStream = null;
    if (!cfg.enabled) {
      this.stopMicRetry();
      this.micLost = false;
      return true;
    }
    const constraints = (deviceId) => ({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: !!cfg.noiseSuppression,
        channelCount: { ideal: 2 },
      },
    });
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
      this.mic.node.connect(this.mic.gain);
      const track = stream.getAudioTracks()[0];
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
    const inputs = s.separateTracks
      ? [['System', this.sysDest], ['Microphone', this.micDest]]
      : [['Audio', this.mixDest]];
    const audio = inputs.map(([name, node]) => {
      const track = node.stream.getAudioTracks()[0].clone();
      this.sessionTracks.push(track);
      return { name, readable: new MediaStreamTrackProcessor({ track }).readable };
    });
    try {
      this.sessionInfo = await this.call(
        'session-start',
        { audioOrder: order.audio, audioBitrate: s.audioBitrate * 1000, audio, audioOnly },
        audio.map((a) => a.readable),
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
