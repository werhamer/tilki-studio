/*
 * Tilki Studio — arayüz
 */
import { Engine, micNoiseLevel } from './engine.js';
import { t, setLang, getLang, resolveLang, applyI18n } from './i18n.js';
import { icon, applyIcons } from './icons.js';
import { camRect, targetBitrate } from './geometry.js';

const api = window.tilki;
const $ = (id) => document.getElementById(id);
const SELFTEST = new URLSearchParams(location.search).has('selftest');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let settings = null;
let appInfo = null;
let engine = null;
let sources = [];
let codecSupport = null;
let codecProbe = null;

const ui = {
  state: 'idle', // idle | countdown | starting | recording | saving
  stats: null,
  cropEdit: null,
  countdownCancel: null,
  replayBusy: false,
  pickerTab: 'screen',
  closing: false,
  lastSource: null,
  diskWarned: false,
};

// ------------------------------------------------------------------ yardımcılar

async function save(patch) {
  settings = await api.setSettings(patch);
  if (engine) {
    engine.settings = settings;
    if (['codec', 'container', 'fps', 'quality', 'resolution'].some((key) => Object.hasOwn(patch, key))) {
      engine.pushConfig();
    }
  }
  return settings;
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function fmtShort(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? fmtTime(s) : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function fmtDate(ms) {
  return new Intl.DateTimeFormat(getLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function setSegmented(container, value) {
  for (const button of container.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.value === String(value));
  }
}

function bindSegmented(container, value, onChange) {
  setSegmented(container, value);
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || button.classList.contains('active')) return;
    setSegmented(container, button.dataset.value);
    onChange(button.dataset.value);
  });
}

function toast({ title, sub, kind = 'ok', action, timeout = 5200 }) {
  const node = el('div', `toast ${kind}`);
  const badge = el('div', 'toast-icon');
  badge.innerHTML = icon(kind === 'error' ? 'x' : kind === 'info' ? 'info' : 'check');
  const text = el('div', 'toast-text');
  text.append(el('div', 'toast-title', title));
  if (sub) text.append(el('div', 'toast-sub', sub));
  node.append(badge, text);
  if (action) {
    const button = el('button', 'btn small', action.label);
    button.addEventListener('click', () => {
      action.run();
      dismiss();
    });
    node.append(button);
  }
  const dismiss = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  $('toasts').append(node);
  setTimeout(dismiss, timeout);
}

function notifySystem(title, body) {
  if (document.hasFocus() || SELFTEST) return;
  try {
    new Notification(title, { body, silent: true });
  } catch {
    // Bildirim izni yoksa sessizce geç.
  }
}

// Ana süreçten gelen hatalar "Error invoking remote method 'x': Error: kod" diye sarılı gelir.
const ERROR_CODES = [
  'output-blocked', 'disk-full', 'output-missing', 'no-video-encoder', 'start-timeout',
  'empty-recording', 'no-source', 'replay-empty', 'nothing-to-record',
];

function errorCode(err) {
  const raw = String((err && err.message) || err);
  return ERROR_CODES.find((code) => raw.includes(code))
    || raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function errorToast(err) {
  const code = errorCode(err);
  ui.lastError = code;
  api.log('error', `hata: ${code}`);
  if (code === 'output-blocked') {
    toast({
      title: t('toast.outputBlocked'),
      sub: t('toast.outputBlockedSub'),
      kind: 'error',
      timeout: 15000,
      action: { label: t('perm.openSecurity'), run: () => api.openSystemSettings('cfa') },
    });
    notifySystem(t('toast.outputBlocked'), t('toast.outputBlockedSub'));
    return;
  }
  if (code === 'disk-full') {
    toast({ title: t('toast.diskFull'), sub: t('toast.diskFullSub'), kind: 'error', timeout: 12000 });
    notifySystem(t('toast.diskFull'), t('toast.diskFullSub'));
    return;
  }
  if (code === 'output-missing') {
    toast({ title: t('toast.outputMissing'), kind: 'error', timeout: 12000 });
    return;
  }
  const known = {
    'no-video-encoder': 'toast.noEncoder',
    'start-timeout': 'toast.startTimeout',
    'empty-recording': 'toast.empty',
    'no-source': 'toast.noSource',
    'nothing-to-record': 'mode.nothing',
    'replay-empty': 'replay.empty',
  };
  if (known[code]) toast({ title: t(known[code]), kind: 'error' });
  else toast({ title: t('toast.failed'), sub: code, kind: 'error', timeout: 8000 });
}

// ------------------------------------------------------------------ önizleme yerleşimi

function fitStage() {
  const stage = $('stage');
  const frame = $('stageFrame');
  const { outW, outH, srcW, srcH } = engine.dims;
  const editing = !!ui.cropEdit && srcW && srcH;
  const w = editing ? srcW : outW;
  const h = editing ? srcH : outH;
  if (!w || !h) return;
  const pad = 26;
  const availW = Math.max(100, stage.clientWidth - pad * 2);
  const availH = Math.max(100, stage.clientHeight - pad * 2);
  const scale = Math.min(availW / w, availH / h);
  const cssW = Math.round(w * scale);
  const cssH = Math.round(h * scale);
  frame.style.width = `${cssW}px`;
  frame.style.height = `${cssH}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.min(w, Math.round(cssW * dpr));
  engine.setPreviewSize(Math.max(2, pw), Math.max(2, Math.round((pw * h) / w)));
}

function renderSourceCard() {
  const src = engine.source;
  const { srcW, srcH, outW, outH } = engine.dims;
  $('stage').classList.toggle('empty', !src);
  $('sourceName').textContent = src ? src.name : t('source.none');
  const parts = [];
  if (src && srcW) parts.push(`${srcW}×${srcH}`);
  if (src && engine.crop) parts.push(t('source.cropped'));
  $('sourceSub').textContent = parts.join(' · ');
  const listed = src && sources.find((s) => s.id === src.id);
  $('sourceThumb').style.backgroundImage = listed && listed.thumbnail ? `url("${listed.thumbnail}")` : '';
  const badge = $('dimBadge');
  badge.hidden = !src || !outW;
  badge.textContent = `${outW}×${outH}`;
  $('btnCrop').classList.toggle('active', !!engine.crop || !!ui.cropEdit);
}

// ------------------------------------------------------------------ durum çizimi

function render() {
  const recording = ui.state === 'recording';
  const paused = recording && engine.paused;
  const busy = ui.state === 'starting' || ui.state === 'saving';
  const session = engine.sessionActive;
  const stats = ui.stats;
  const recStats = stats && stats.rec;

  const recBtn = $('btnRec');
  recBtn.classList.toggle('recording', recording || ui.state === 'countdown');
  recBtn.disabled = busy;
  $('stage').classList.toggle('audio-mode', settings.recordMode === 'audio');
  $('btnPause').disabled = !recording;
  $('btnPause').querySelector('i').innerHTML = icon(paused ? 'play' : 'pause');
  $('btnPause').classList.toggle('on', paused);
  $('btnReplaySave').disabled = !engine.replayOn || ui.replayBusy;
  $('btnReplaySave').classList.toggle('on', engine.replayOn);
  $('btnReplaySave2').disabled = !engine.replayOn || ui.replayBusy;
  $('btnShot').disabled = !engine.source;

  const timer = $('timer');
  timer.textContent = fmtTime(recording && recStats ? recStats.duration : 0);
  timer.classList.toggle('live', recording && !paused);
  timer.classList.toggle('paused', paused);

  let label = t(engine.source || settings.recordMode === 'audio' ? 'state.ready' : 'state.noSource');
  if (ui.state === 'starting' || ui.state === 'countdown') label = t('state.starting');
  if (ui.state === 'saving') label = t('state.saving');
  if (recording) label = `${t(paused ? 'state.paused' : 'state.recording')} · ${engine.recFile ? engine.recFile.name : ''}`;
  else if (ui.state === 'idle' && engine.replayOn) label = t('replay.on');
  $('stateLabel').textContent = label;

  // üst rozetler
  const recBadge = $('recBadge');
  recBadge.hidden = !recording;
  recBadge.classList.toggle('paused', paused);
  $('recBadgeText').textContent = paused ? 'PAUSE' : 'REC';
  const dim = recording && !paused && Math.floor(performance.now() / 600) % 2 === 1;
  recBadge.querySelector('.dot').classList.toggle('dim', dim);
  $('titleStatus').querySelector('.dot').classList.toggle('dim', dim);
  const title = $('titleStatus');
  title.hidden = !(recording || engine.replayOn);
  title.classList.toggle('paused', paused);
  title.classList.toggle('replay', !recording && engine.replayOn);
  $('titleStatusText').textContent = recording
    ? `${paused ? 'PAUSE' : 'REC'} ${fmtTime(recStats ? recStats.duration : 0)}`
    : 'REPLAY';

  // sağdaki bilgi etiketleri
  const info = engine.sessionInfo;
  const codecName = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8' };
  const audioMode = settings.recordMode === 'audio';
  $('chipFormat').textContent = audioMode
    ? `M4A · AAC ${settings.audioBitrate} kbps`
    : `${settings.container.toUpperCase()} · ${settings.fps} fps`;
  const chipEncoder = $('chipEncoder');
  chipEncoder.hidden = !info || info.audioOnly;
  if (info && !info.audioOnly) {
    chipEncoder.textContent = `${codecName[info.videoCodec] || info.videoCodec} · ${info.hardware ? 'GPU' : 'CPU'}`;
    chipEncoder.classList.toggle('good', info.hardware);
    chipEncoder.classList.toggle('warn', !info.hardware);
  }
  const chipRate = $('chipRate');
  chipRate.hidden = !(session && stats && stats.active);
  if (!chipRate.hidden) {
    chipRate.textContent = stats.audioOnly
      ? `${Math.round(stats.bitrate / 1e3)} kbps`
      : `${(stats.bitrate / 1e6).toFixed(1)} Mbps · ${Math.round(stats.fps)} fps`;
  }

  // kayıt türü
  $('stageAudio').hidden = !audioMode;
  setSegmented($('recMode'), settings.recordMode);
  for (const button of $('recMode').querySelectorAll('button')) button.disabled = session || ui.state !== 'idle';
  $('replayEnabled').disabled = audioMode;
  const chipSize = $('chipSize');
  chipSize.hidden = !(recording && recStats);
  if (!chipSize.hidden) chipSize.textContent = fmtSize(recStats.bytes);
  const chipDropped = $('chipDropped');
  chipDropped.hidden = !(session && stats && stats.dropped > 0);
  if (!chipDropped.hidden) chipDropped.textContent = t('unit.dropped', { n: stats.dropped });

  // anlık tekrar
  $('replayBody').hidden = !engine.replayOn;
  $('replayHint').hidden = engine.replayOn;
  $('replayEnabled').checked = engine.replayOn;
  const rp = stats && stats.replay;
  $('replayFill').style.width = rp ? `${Math.min(100, (rp.buffered / rp.seconds) * 100)}%` : '0%';
  $('btnReplaySave2').querySelector('span').textContent = t('replay.save', { n: settings.replaySeconds });

  // kilitler
  for (const card of document.querySelectorAll('[data-lockable]')) card.classList.toggle('locked', session);
  $('settingsLock').hidden = !session;
  $('btnCrop').disabled = session || !engine.source;
}

function pushAppState() {
  api.updateState({
    recording: ui.state === 'recording',
    paused: engine.paused,
    replay: engine.replayOn,
  });
}

// ------------------------------------------------------------------ kayıt akışı

function runCountdown(seconds) {
  return new Promise((resolve) => {
    const box = $('countdown');
    let left = seconds;
    let timer = null;
    const finish = (ok) => {
      clearInterval(timer);
      box.hidden = true;
      box.textContent = '';
      ui.countdownCancel = null;
      resolve(ok);
    };
    const show = () => {
      box.textContent = '';
      box.append(el('span', '', String(left)));
    };
    ui.countdownCancel = () => finish(false);
    box.hidden = false;
    show();
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) finish(true);
      else show();
    }, 1000);
  });
}

async function toggleRecord() {
  if (ui.state === 'recording') return stopRecord();
  if (ui.state === 'countdown') {
    if (ui.countdownCancel) ui.countdownCancel();
    return;
  }
  if (ui.state !== 'idle') return;
  const audioOnly = settings.recordMode === 'audio';
  if (!engine.source && !audioOnly) {
    toast({ title: t('toast.noSource'), kind: 'info' });
    return;
  }
  if (audioOnly) {
    // Mikrofon açık ama bağlı değilse (izin yeni verildiyse) bir kez daha dene.
    if (settings.mic.enabled && !engine.micStream) await engine.refreshMic();
    const micOn = settings.mic.enabled && !!engine.micStream;
    const sysOn = settings.system.enabled && engine.systemAvailable;
    if (!micOn && !sysOn) {
      toast({ title: t('mode.nothing'), kind: 'error', timeout: 8000 });
      return;
    }
  }
  if (ui.cropEdit) endCropEdit(false);
  engine.resumeAudio();

  if (settings.countdown > 0 && !SELFTEST) {
    engine.prepareVideo();
    ui.state = 'countdown';
    render();
    const ok = await runCountdown(settings.countdown);
    if (!ok) {
      ui.state = 'idle';
      render();
      return;
    }
  }

  ui.state = 'starting';
  render();
  try {
    await engine.startRecording();
    ui.state = 'recording';
    ui.diskWarned = false;
    api.log('info', `kayıt başladı ${engine.recFile && engine.recFile.name} ${JSON.stringify(engine.sessionInfo)}`);
    if (engine.sessionInfo && !engine.sessionInfo.audioOnly && !engine.sessionInfo.hardware && !ui.warnedSoft) {
      ui.warnedSoft = true;
      toast({ title: t('toast.softEncoder'), kind: 'info' });
    }
  } catch (err) {
    ui.state = 'idle';
    errorToast(err);
  }
  pushAppState();
  render();
}

async function stopRecord() {
  if (ui.state !== 'recording') return;
  ui.state = 'saving';
  render();
  try {
    const stats = ui.stats;
    const file = await engine.stopRecording();
    ui.lastFile = file;
    const sub = `${file.name} · ${fmtShort(file.duration)} · ${fmtSize(file.size)}`;
    api.log(file.partial ? 'error' : 'info', `kayıt bitti ${sub}${file.partial ? ` KISMİ: ${file.error}` : ''}`
      + ` · atlanan kare ${stats ? stats.dropped : '?'}`);
    if (file.partial) {
      toast({
        title: t('toast.partial'),
        sub,
        kind: 'error',
        timeout: 15000,
        action: { label: t('toast.show'), run: () => api.revealItem(file.path) },
      });
      notifySystem(t('toast.partial'), file.name);
    } else {
      toast({
        title: t('toast.saved'),
        sub,
        action: { label: t('toast.show'), run: () => api.revealItem(file.path) },
      });
      notifySystem(t('toast.saved'), file.name);
    }
    refreshLibrary();
  } catch (err) {
    errorToast(err);
  }
  ui.state = 'idle';
  pushAppState();
  render();
}

function togglePause() {
  if (ui.state !== 'recording') return;
  if (engine.paused) engine.resumeRecording();
  else engine.pauseRecording();
  pushAppState();
  render();
}

async function setReplay(enabled) {
  if (enabled && !engine.source) {
    toast({ title: t('toast.noSource'), kind: 'info' });
    render();
    return;
  }
  try {
    if (ui.cropEdit) endCropEdit(false);
    await engine.setReplay(enabled);
    await save({ replayEnabled: enabled });
  } catch (err) {
    errorToast(err);
  }
  pushAppState();
  render();
}

async function saveReplay() {
  if (!engine.replayOn || ui.replayBusy) return;
  ui.replayBusy = true;
  render();
  try {
    const file = await engine.saveReplay();
    toast({
      title: t('replay.saved'),
      sub: `${file.name} · ${fmtShort(file.duration)} · ${fmtSize(file.size)}`,
      action: { label: t('toast.show'), run: () => api.revealItem(file.path) },
    });
    notifySystem(t('replay.saved'), file.name);
    refreshLibrary();
  } catch (err) {
    errorToast(err);
  }
  ui.replayBusy = false;
  render();
}

async function takeShot() {
  if (!engine.source) return;
  try {
    const file = await engine.screenshot();
    toast({
      title: t('toast.shot'),
      sub: file.name,
      action: { label: t('toast.show'), run: () => api.revealItem(file.path) },
    });
    refreshLibrary();
  } catch (err) {
    errorToast(err);
  }
}

// ------------------------------------------------------------------ kaynak seçici

async function chooseSource(source, { quiet = false } = {}) {
  try {
    await engine.setSource({ id: source.id, name: source.name, type: source.type });
    await save({ lastSourceId: source.id });
  } catch (err) {
    if (!quiet) toast({ title: t('source.failed'), sub: String(err && err.message), kind: 'error' });
    return false;
  }
  return true;
}

function sourceLabel(source, index) {
  if (source.type !== 'screen') return source.name;
  const screens = sources.filter((s) => s.type === 'screen');
  return screens.length > 1 ? `${t('source.screen')} ${index + 1}` : t('source.screen');
}

function renderPicker() {
  const grid = $('pickerGrid');
  grid.textContent = '';
  setSegmented($('pickerTabs'), ui.pickerTab);
  const list = sources.filter((s) => s.type === ui.pickerTab);
  if (!list.length) {
    grid.append(el('div', 'picker-empty', t('picker.empty')));
    return;
  }
  list.forEach((source, index) => {
    const card = el('button', 'pick');
    if (engine.source && engine.source.id === source.id) card.classList.add('current');
    const thumb = el('div', 'pick-thumb');
    if (source.thumbnail) thumb.style.backgroundImage = `url("${source.thumbnail}")`;
    if (source.minimized) {
      // Küçültülmüş pencerenin önizlemesi yok: simgesini ve bir not göster.
      card.classList.add('minimized');
      if (source.icon) {
        const big = el('img', 'pick-min-icon');
        big.src = source.icon;
        big.alt = '';
        thumb.append(big);
      }
      thumb.append(el('span', 'pick-min-note', t('picker.minimized')));
    }
    const label = el('div', 'pick-label');
    if (source.icon) {
      const img = el('img');
      img.src = source.icon;
      img.alt = '';
      label.append(img);
    }
    const name = sourceLabel(source, index);
    label.append(el('span', '', name));
    if (source.width) label.append(el('small', '', `${source.width}×${source.height}`));
    card.append(thumb, label);
    card.addEventListener('click', async () => {
      $('pickerModal').hidden = true;
      if (source.minimized) {
        await chooseMinimizedWindow(source, name);
        return;
      }
      await chooseSource({ ...source, name });
    });
    grid.append(card);
  });
}

// Küçültülmüş pencereyi geri aç, Chromium listesinde görününce onu yakala.
async function chooseMinimizedWindow(source, name) {
  api.log('info', `küçültülmüş pencere seçildi: ${name}`);
  await api.restoreWindow(source.hwnd);
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait(350);
    try {
      sources = await api.listSources();
    } catch {
      continue;
    }
    const found = sources.find((s) => s.id === source.id)
      || sources.find((s) => s.type === 'window' && s.id.startsWith(`window:${source.hwnd}:`));
    if (found) {
      await chooseSource({ ...found, name: found.name || name });
      return;
    }
  }
  // Listede hâlâ yoksa doğrudan kimlikle dene.
  if (!(await chooseSource({ id: source.id, name, type: 'window' }, { quiet: true }))) {
    toast({ title: t('source.failed'), sub: name, kind: 'error' });
  }
}

async function loadSources() {
  try {
    sources = await api.listSources();
  } catch (err) {
    console.error('Kaynak listesi alınamadı', err);
    api.log('error', `kaynak listesi alınamadı: ${err && err.message}`);
  }
  renderPicker();
  // Küçültülmüş pencereler ayrı ve biraz daha yavaş gelir; listeyi bekletmeden ekle.
  const minimized = await api.listMinimizedWindows().catch(() => []);
  if ($('pickerModal').hidden) return;
  const known = new Set(sources.map((s) => s.id));
  for (const m of minimized) {
    const id = `window:${m.hwnd}:0`;
    if (known.has(id) || sources.some((s) => s.id.startsWith(`window:${m.hwnd}:`))) continue;
    sources.push({ id, hwnd: m.hwnd, name: m.title, type: 'window', thumbnail: null, icon: m.icon, minimized: true });
  }
  renderPicker();
}

async function openPicker() {
  if (ui.cropEdit) endCropEdit(false);
  $('pickerModal').hidden = false;
  renderPicker();
  await loadSources();
  renderSourceCard();
}

// ------------------------------------------------------------------ bölge seçimi

function renderCropBox() {
  const c = ui.cropEdit;
  if (!c) return;
  const box = $('cropBox');
  box.style.left = `${c.x * 100}%`;
  box.style.top = `${c.y * 100}%`;
  box.style.width = `${c.w * 100}%`;
  box.style.height = `${c.h * 100}%`;
  const { srcW, srcH } = engine.dims;
  const label = $('cropSize');
  label.textContent = `${Math.round(c.w * srcW)}×${Math.round(c.h * srcH)}`;
  label.classList.toggle('inside', c.y < 0.07);
}

function startCropEdit() {
  if (!engine.source || engine.sessionActive) return;
  ui.cropEdit = engine.crop ? { ...engine.crop } : { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };
  engine.setCropEditing(true);
  $('cropLayer').hidden = false;
  $('cropBar').hidden = false;
  renderCropBox();
  fitStage();
  renderSourceCard();
}

function endCropEdit(apply, reset = false) {
  const c = ui.cropEdit;
  ui.cropEdit = null;
  $('cropLayer').hidden = true;
  $('cropBar').hidden = true;
  if (reset) engine.setCrop(null);
  else if (apply && c) engine.setCrop(c.w > 0.985 && c.h > 0.985 ? null : c);
  else engine.setCropEditing(false);
  fitStage();
  renderSourceCard();
}

function bindCrop() {
  const layer = $('cropLayer');
  const MIN = 0.04;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let drag = null;

  const point = (event) => {
    const rect = layer.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  layer.addEventListener('pointerdown', (event) => {
    if (!ui.cropEdit || event.button !== 0) return;
    const p = point(event);
    const c = ui.cropEdit;
    const handle = event.target.dataset && event.target.dataset.handle;
    if (handle) {
      // Karşı köşe sabit kalır.
      drag = {
        mode: 'draw',
        ax: handle.includes('w') ? c.x + c.w : c.x,
        ay: handle.includes('n') ? c.y + c.h : c.y,
      };
    } else if (event.target.closest('#cropBox')) {
      drag = { mode: 'move', dx: p.x - c.x, dy: p.y - c.y };
    } else {
      drag = { mode: 'draw', ax: p.x, ay: p.y };
    }
    layer.setPointerCapture(event.pointerId);
  });

  layer.addEventListener('pointermove', (event) => {
    if (!drag || !ui.cropEdit) return;
    const p = point(event);
    const c = ui.cropEdit;
    if (drag.mode === 'move') {
      c.x = clamp(p.x - drag.dx, 0, 1 - c.w);
      c.y = clamp(p.y - drag.dy, 0, 1 - c.h);
    } else {
      const x1 = Math.min(drag.ax, p.x);
      const y1 = Math.min(drag.ay, p.y);
      c.w = Math.max(MIN, Math.abs(p.x - drag.ax));
      c.h = Math.max(MIN, Math.abs(p.y - drag.ay));
      c.x = clamp(x1, 0, 1 - c.w);
      c.y = clamp(y1, 0, 1 - c.h);
    }
    renderCropBox();
  });

  const release = () => {
    drag = null;
  };
  layer.addEventListener('pointerup', release);
  layer.addEventListener('pointercancel', release);

  $('cropApply').addEventListener('click', () => endCropEdit(true));
  $('cropCancel').addEventListener('click', () => endCropEdit(false));
  $('cropReset').addEventListener('click', () => endCropEdit(false, true));
  $('btnCrop').addEventListener('click', () => (ui.cropEdit ? endCropEdit(false) : startCropEdit()));
}

// ------------------------------------------------------------------ kamera

function bindCameraDrag() {
  const frame = $('stageFrame');
  let drag = null;

  const locate = (event) => {
    const rect = frame.getBoundingClientRect();
    const { outW, outH } = engine.dims;
    const x = ((event.clientX - rect.left) / rect.width) * outW;
    const y = ((event.clientY - rect.top) / rect.height) * outH;
    const r = camRect(settings.camera, outW, outH);
    const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    return { x, y, r, inside, outW, outH };
  };
  const active = () => settings.camera.enabled && !ui.cropEdit && engine.camStream;

  frame.addEventListener('pointerdown', (event) => {
    if (!active() || event.button !== 0) return;
    const p = locate(event);
    if (!p.inside) return;
    drag = { dx: p.x - p.r.cx, dy: p.y - p.r.cy };
    frame.setPointerCapture(event.pointerId);
    frame.classList.add('cam-drag');
  });

  frame.addEventListener('pointermove', (event) => {
    if (!active()) {
      frame.classList.remove('cam-hover');
      return;
    }
    const p = locate(event);
    if (!drag) {
      frame.classList.toggle('cam-hover', p.inside);
      return;
    }
    const half = { w: p.r.w / 2 / p.outW, h: p.r.h / 2 / p.outH };
    settings.camera.x = Math.min(1 - half.w, Math.max(half.w, (p.x - drag.dx) / p.outW));
    settings.camera.y = Math.min(1 - half.h, Math.max(half.h, (p.y - drag.dy) / p.outH));
    engine.pushLayout();
  });

  const release = () => {
    if (!drag) return;
    drag = null;
    frame.classList.remove('cam-drag');
    save({ camera: settings.camera });
  };
  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);

  let wheelSave = null;
  frame.addEventListener('wheel', (event) => {
    if (!active() || !locate(event).inside) return;
    event.preventDefault();
    const next = settings.camera.size * (event.deltaY < 0 ? 1.06 : 0.94);
    settings.camera.size = Math.min(0.6, Math.max(0.1, next));
    engine.pushLayout();
    $('camSize').value = Math.round(settings.camera.size * 100);
    setRangeFill($('camSize'));
    clearTimeout(wheelSave);
    wheelSave = setTimeout(() => save({ camera: settings.camera }), 400);
  }, { passive: false });
}

async function applyCamera(patch) {
  await save({ camera: { ...settings.camera, ...patch } });
  if ('enabled' in patch || 'deviceId' in patch) {
    const ok = await engine.refreshCamera();
    if (!ok && settings.camera.enabled) {
      await save({ camera: { ...settings.camera, enabled: false } });
      engine.pushLayout();
    }
    if (ok) populateDevices();
  } else {
    engine.pushLayout();
  }
  renderCameraCard();
}

function renderCameraCard() {
  const cam = settings.camera;
  $('camEnabled').checked = cam.enabled;
  $('camBody').hidden = !cam.enabled;
  setSegmented($('camShape'), cam.shape);
  $('camSize').value = Math.round(cam.size * 100);
  setRangeFill($('camSize'));
  $('camMirror').checked = cam.mirror;
}

// ------------------------------------------------------------------ ses

function renderAudioCard() {
  const { system, mic } = settings;
  const sysOff = !system.enabled || !engine.systemAvailable;
  $('sysMute').classList.toggle('muted', !system.enabled);
  $('sysMute').querySelector('i').innerHTML = icon(system.enabled ? 'volume' : 'volume-off');
  $('micMute').classList.toggle('muted', !mic.enabled);
  $('micMute').querySelector('i').innerHTML = icon(mic.enabled ? 'mic' : 'mic-off');
  $('stripSystem').classList.toggle('off', sysOff);
  $('stripMic').classList.toggle('off', !mic.enabled);
  $('sysVolume').value = Math.round(system.volume * 100);
  $('micVolume').value = Math.round(mic.volume * 100);
  setRangeFill($('sysVolume'));
  setRangeFill($('micVolume'));
  $('sysVal').textContent = !engine.source
    ? ''
    : !engine.systemAvailable
      ? t('audio.noSystem')
      : system.enabled ? `${Math.round(system.volume * 100)}%` : t('audio.muted');
  $('micVal').textContent = !mic.enabled
    ? t('audio.muted')
    : engine.micStream ? `${Math.round(mic.volume * 100)}%` : t('audio.noMic');
  setSegmented($('micNoiseLevel'), micNoiseLevel(mic));
  $('micEcho').checked = !!mic.echoCancellation;
}

async function populateDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const fill = (select, list, current, fallbackLabel) => {
    select.textContent = '';
    for (const item of list) {
      const option = el('option', '', item.label);
      option.value = item.value;
      select.append(option);
    }
    if (!list.length) {
      const option = el('option', '', fallbackLabel);
      option.value = '';
      select.append(option);
    }
    select.value = list.some((i) => i.value === current) ? current : (list[0] ? list[0].value : '');
  };
  const mics = devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d) => ({
      value: d.deviceId,
      label: d.deviceId === 'default' ? t('audio.default') : (d.label || t('audio.mic')),
    }));
  fill($('micDevice'), mics, settings.mic.deviceId, t('audio.default'));
  const cams = devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ value: d.deviceId, label: d.label || `${t('camera.title')} ${i + 1}` }));
  fill($('camDevice'), cams, settings.camera.deviceId, t('camera.none'));
}

function startMeters() {
  // Saniyede ~16 güncelleme göz için yeterli; her karede (60 fps) güncellemek
  // arayüzü sürekli yeniden çizdirip kayıt sırasında işlemciyi yorar.
  const shown = { system: 0, mic: 0 };
  const written = { system: '', mic: '' };
  const bars = { system: $('sysMeter'), mic: $('micMeter') };
  setInterval(() => {
    if (ui.hidden || !$('view-studio').classList.contains('active')) return;
    const levels = engine.levels();
    for (const key of ['system', 'mic']) {
      const db = levels[key] > 0 ? 20 * Math.log10(levels[key]) : -100;
      const value = Math.min(1, Math.max(0, (db + 54) / 54));
      shown[key] = value > shown[key] ? value : shown[key] * 0.72;
      const next = shown[key] < 0.01 ? '0' : shown[key].toFixed(2);
      if (next === written[key]) continue;
      written[key] = next;
      bars[key].style.transform = `scaleX(${next})`;
    }
  }, 60);
}

function bindAudio() {
  $('sysMute').addEventListener('click', async () => {
    await save({ system: { ...settings.system, enabled: !settings.system.enabled } });
    engine.applyVolumes();
    renderAudioCard();
  });
  $('micMute').addEventListener('click', async () => {
    await save({ mic: { ...settings.mic, enabled: !settings.mic.enabled } });
    await engine.refreshMic();
    engine.applyVolumes();
    renderAudioCard();
    populateDevices();
  });
  const volume = (input, key) => {
    let timer = null;
    input.addEventListener('input', () => {
      settings[key] = { ...settings[key], volume: Number(input.value) / 100 };
      engine.settings = settings;
      engine.applyVolumes();
      renderAudioCard();
      clearTimeout(timer);
      timer = setTimeout(() => save({ [key]: settings[key] }), 300);
    });
  };
  volume($('sysVolume'), 'system');
  volume($('micVolume'), 'mic');
  $('recMode').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || engine.sessionActive || ui.state !== 'idle') return;
    const mode = button.dataset.value;
    if (mode === settings.recordMode) return;
    if (mode === 'audio' && engine.replayOn) {
      await setReplay(false);
      toast({ title: t('mode.replayOff'), kind: 'info' });
    }
    await save({ recordMode: mode });
    api.log('info', `kayıt türü: ${mode}`);
    render();
  });
  $('micDevice').addEventListener('change', async (event) => {
    await save({ mic: { ...settings.mic, deviceId: event.target.value } });
    await engine.refreshMic();
  });
  $('micNoiseLevel').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const level = button.dataset.value;
    setSegmented($('micNoiseLevel'), level);
    await save({ mic: { ...settings.mic, noiseLevel: level, noiseSuppression: level !== 'off' } });
    api.log('info', `gürültü engelleme: ${level}`);
    await engine.refreshMic();
    renderAudioCard();
  });
  $('micEcho').addEventListener('change', async (event) => {
    await save({ mic: { ...settings.mic, echoCancellation: event.target.checked } });
    await engine.refreshMic();
  });
}

// ------------------------------------------------------------------ kütüphane

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const media = entry.target;
    thumbObserver.unobserve(media);
    media.src = media.dataset.src;
  }
}, { rootMargin: '200px' });

function openPlayer(item) {
  const body = $('playerBody');
  body.textContent = '';
  $('playerTitle').textContent = item.name;
  if (item.kind === 'video') {
    const video = el('video');
    video.src = item.url;
    video.controls = true;
    video.autoplay = true;
    body.append(video);
  } else if (item.kind === 'audio') {
    const audio = el('audio');
    audio.src = item.url;
    audio.controls = true;
    audio.autoplay = true;
    body.append(audio);
  } else {
    const img = el('img');
    img.src = item.url;
    img.alt = item.name;
    body.append(img);
  }
  $('playerModal').hidden = false;
}

function closeModals() {
  $('pickerModal').hidden = true;
  $('permModal').hidden = true;
  if (!$('playerModal').hidden) {
    $('playerModal').hidden = true;
    $('playerBody').textContent = '';
  }
}

async function refreshLibrary() {
  if (!$('view-library').classList.contains('active')) return;
  const { dir, items } = await api.listLibrary();
  $('libraryDir').textContent = dir;
  const grid = $('libraryGrid');
  grid.textContent = '';
  $('libraryEmpty').hidden = items.length > 0;
  grid.hidden = items.length === 0;

  for (const item of items) {
    const card = el('div', 'lib-card');
    const thumb = el('div', 'lib-thumb');
    const ext = item.name.split('.').pop();
    if (item.kind === 'video') {
      const video = el('video');
      video.muted = true;
      video.preload = 'metadata';
      video.dataset.src = `${item.url}#t=0.5`;
      const duration = el('span', 'lib-tag');
      duration.hidden = true;
      video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(video.duration)) {
          duration.textContent = fmtShort(video.duration);
          duration.hidden = false;
        }
      });
      thumbObserver.observe(video);
      thumb.append(video, duration);
    } else if (item.kind === 'audio') {
      const art = el('div', 'lib-audio');
      art.innerHTML = `<i class="icon">${icon('mic')}</i>`;
      const duration = el('span', 'lib-tag');
      duration.hidden = true;
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(probe.duration)) {
          duration.textContent = fmtShort(probe.duration);
          duration.hidden = false;
        }
      });
      probe.src = item.url;
      thumb.append(art, duration);
    } else {
      const img = el('img');
      img.alt = '';
      img.dataset.src = item.url;
      thumbObserver.observe(img);
      thumb.append(img);
    }
    thumb.append(el('span', 'lib-tag kind', ext));
    const play = el('div', 'lib-play');
    const playIcon = el('span');
    playIcon.innerHTML = `<i class="icon">${icon(item.kind === 'image' ? 'image' : 'play')}</i>`;
    play.append(playIcon);
    thumb.append(play);
    thumb.addEventListener('click', () => openPlayer(item));

    const infoRow = el('div', 'lib-info');
    const text = el('div', 'lib-text');
    text.append(el('div', 'lib-name', item.name), el('div', 'lib-meta', `${fmtDate(item.mtime)} · ${fmtSize(item.size)}`));
    const action = (name, title, run, extra = '') => {
      const button = el('button', `icon-btn ${extra}`);
      button.title = title;
      button.innerHTML = `<i class="icon">${icon(name)}</i>`;
      button.addEventListener('click', run);
      return button;
    };
    infoRow.append(
      text,
      action('external', t('library.external'), () => api.openItem(item.path)),
      action('folder', t('library.reveal'), () => api.revealItem(item.path)),
      action('trash', t('library.delete'), async () => {
        if (await api.trashItem(item.path)) {
          card.remove();
          toast({ title: t('library.deleted'), sub: item.name, kind: 'info', timeout: 3000 });
          if (!grid.children.length) refreshLibrary();
        }
      }, 'danger'),
    );
    card.append(thumb, infoRow);
    grid.append(card);
  }
}

// ------------------------------------------------------------------ ayarlar

const CODECS_BY_CONTAINER = { mp4: ['h264', 'hevc', 'av1'], mkv: ['h264', 'hevc', 'av1'], webm: ['vp9', 'av1'] };

function renderCodecOptions() {
  const select = $('setCodec');
  const list = CODECS_BY_CONTAINER[settings.container];
  select.textContent = '';
  for (const codec of list) {
    const support = codecSupport && codecSupport[codec];
    let suffix = '';
    if (support) {
      suffix = support.hardware
        ? ` · ${t('codec.gpu')}`
        : support.software ? ` · ${t('codec.cpu')}` : ` · ${t('codec.unsupported')}`;
    }
    const option = el('option', '', t(`codec.${codec}`) + suffix);
    option.value = codec;
    option.disabled = !!support && !support.hardware && !support.software;
    select.append(option);
  }
  select.value = list.includes(settings.codec) ? settings.codec : list[0];
  const support = codecSupport && codecSupport[select.value];
  $('codecHint').textContent = support ? t(support.hardware ? 'codec.hintGpu' : 'codec.hintCpu') : '';
}

function renderQualityHint() {
  const width = engine.dims.srcW ? engine.dims.outW : 1920;
  const height = engine.dims.srcH ? engine.dims.outH : 1080;
  const bitrate = targetBitrate(width, height, settings.fps, settings.quality, settings.codec);
  $('qualityHint').textContent = t('quality.estimate', {
    width, height, fps: settings.fps,
    mbps: (bitrate / 1e6).toFixed(1),
    gb: ((bitrate * 3600) / 8 / 1e9).toFixed(1),
  });
}

function renderSettings() {
  $('setResolution').value = settings.resolution;
  setSegmented($('setFps'), settings.fps);
  setSegmented($('setQuality'), settings.quality);
  setSegmented($('setContainer'), settings.container);
  setSegmented($('setAudioBitrate'), settings.audioBitrate);
  setSegmented($('setCountdown'), settings.countdown);
  setSegmented($('setLanguage'), getLang());
  // MKV yapısı gereği kesintiye dayanıklıdır; bu ayar yalnızca MP4'ü parçalı yazar.
  const supportsCrashSafe = settings.container === 'mp4';
  $('setCrashSafe').checked = settings.crashSafe && supportsCrashSafe;
  $('setCrashSafe').disabled = !supportsCrashSafe;
  $('setSeparate').checked = settings.separateTracks;
  $('setHide').checked = settings.hideFromCapture;
  $('setMinimize').checked = settings.minimizeOnRecord;
  $('setFolderPath').textContent = settings.outputDir;
  renderCodecOptions();
  renderQualityHint();
  renderQualityHint();
  for (const button of document.querySelectorAll('.hotkey')) {
    button.textContent = settings.hotkeys[button.dataset.hotkey] || t('hotkey.none');
  }
}

function accelFromEvent(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  const code = event.code;
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  else {
    key = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Insert: 'Insert', Delete: 'Delete',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backquote: '`',
      BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backslash: '\\',
    }[code] || null;
  }
  if (!key) return null;
  if (!mods.length && !/^F\d/.test(key)) return null;
  return [...mods, key].join('+');
}

async function applyHotkeys() {
  const failed = await api.applyHotkeys(settings.hotkeys);
  for (const button of document.querySelectorAll('.hotkey')) {
    button.title = failed.includes(button.dataset.hotkey) ? t('toast.hotkeyFailed') : '';
  }
  return failed;
}

function bindHotkeys() {
  let capturing = null;

  const finish = async (value) => {
    const button = capturing;
    capturing = null;
    button.classList.remove('capturing');
    const name = button.dataset.hotkey;
    if (value !== undefined) {
      const hotkeys = { ...settings.hotkeys, [name]: value };
      // Aynı kısayol iki işe atanamaz.
      if (value) for (const other of Object.keys(hotkeys)) if (other !== name && hotkeys[other] === value) hotkeys[other] = '';
      await save({ hotkeys });
    }
    renderSettings();
    const failed = await applyHotkeys();
    if (value && failed.includes(name)) toast({ title: t('toast.hotkeyFailed'), sub: value, kind: 'error' });
  };

  for (const button of document.querySelectorAll('.hotkey')) {
    button.addEventListener('click', async () => {
      if (capturing) return;
      capturing = button;
      button.classList.add('capturing');
      button.textContent = t('hotkey.press');
      await api.applyHotkeys({}); // yakalarken mevcut kısayollar tetiklenmesin
    });
  }

  window.addEventListener('keydown', (event) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return finish(undefined);
    if (event.key === 'Backspace') return finish('');
    const accel = accelFromEvent(event);
    if (accel) finish(accel);
  }, true);

  window.addEventListener('blur', () => {
    if (capturing) finish(undefined);
  });
}

function bindSettings() {
  const resolution = $('setResolution');
  for (const [value, label] of [
    ['source', t('settings.resSource')],
    ['2160p', '4K · 2160p'],
    ['1440p', '1440p'],
    ['1080p', '1080p'],
    ['720p', '720p'],
  ]) {
    const option = el('option', '', label);
    option.value = value;
    resolution.append(option);
  }
  resolution.addEventListener('change', async () => {
    await save({ resolution: resolution.value });
    render();
  });

  bindSegmented($('setFps'), settings.fps, async (value) => {
    await save({ fps: Number(value) });
    // Yakalama kare hızı kaynağa bağlandığı için kaynağı yeniden aç.
    if (engine.source && !engine.sessionActive) {
      const crop = engine.crop;
      await engine.setSource(engine.source).catch(() => {});
      if (crop) engine.setCrop(crop);
    }
    renderQualityHint();
    render();
  });
  bindSegmented($('setQuality'), settings.quality, async (value) => {
    await save({ quality: value });
    renderQualityHint();
  });
  bindSegmented($('setContainer'), settings.container, async (value) => {
    const allowed = CODECS_BY_CONTAINER[value];
    await save({ container: value, codec: allowed.includes(settings.codec) ? settings.codec : allowed[0] });
    renderSettings();
    render();
  });
  $('setCodec').addEventListener('change', async (event) => {
    await save({ codec: event.target.value });
    renderCodecOptions();
    renderQualityHint();
  });
  bindSegmented($('setAudioBitrate'), settings.audioBitrate, (value) => save({ audioBitrate: Number(value) }));
  bindSegmented($('setCountdown'), settings.countdown, (value) => save({ countdown: Number(value) }));
  bindSegmented($('setLanguage'), getLang(), async (value) => {
    if (engine.sessionActive) {
      renderSettings();
      return;
    }
    await save({ language: value });
    location.reload();
  });

  const toggle = (id, key) => $(id).addEventListener('change', (event) => save({ [key]: event.target.checked }));
  toggle('setCrashSafe', 'crashSafe');
  toggle('setSeparate', 'separateTracks');
  toggle('setHide', 'hideFromCapture');
  toggle('setMinimize', 'minimizeOnRecord');

  $('setFolderBtn').addEventListener('click', async () => {
    const dir = await api.chooseDir();
    if (!dir) return;
    await save({ outputDir: dir });
    renderSettings();
    // Yeni klasöre gerçekten yazılabiliyor mu? Sorun varsa hemen söyle.
    runPermissionCheck();
  });
  $('setPermBtn').addEventListener('click', () => runPermissionCheck({ show: true, retry: true }));
  $('permRecheck').addEventListener('click', () => runPermissionCheck({ show: true, retry: true }));
  $('permDone').addEventListener('click', () => {
    $('permModal').hidden = true;
  });

  for (const button of $('setCountdown').querySelectorAll('button')) {
    if (button.dataset.value !== '0') button.textContent = `${button.dataset.value} ${t('unit.sec')}`;
  }
  for (const button of $('replaySeconds').querySelectorAll('button')) {
    const n = Number(button.dataset.value);
    button.textContent = n >= 120 ? `${n / 60} ${t('unit.min')}` : `${n} ${t('unit.sec')}`;
  }
}

// ------------------------------------------------------------------ gezinme ve bağlama

function showView(name) {
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${name}`);
  for (const button of document.querySelectorAll('.rail-btn')) button.classList.toggle('active', button.dataset.view === name);
  if (name === 'library') refreshLibrary();
  if (name === 'studio') requestAnimationFrame(fitStage);
  if (name === 'settings' && !codecSupport && !codecProbe) {
    codecProbe = engine.probe().then((support) => {
      codecSupport = support;
      renderCodecOptions();
    }).catch(() => {}).finally(() => { codecProbe = null; });
  }
}

function bindUi() {
  for (const button of document.querySelectorAll('.rail-btn')) {
    button.addEventListener('click', () => showView(button.dataset.view));
  }
  $('btnRec').addEventListener('click', toggleRecord);
  $('btnRec').addEventListener('pointerenter', () => engine.prepareVideo());
  $('btnRec').addEventListener('focus', () => engine.prepareVideo());
  $('btnPause').addEventListener('click', togglePause);
  $('btnShot').addEventListener('click', takeShot);
  $('btnReplaySave').addEventListener('click', saveReplay);
  $('btnReplaySave2').addEventListener('click', saveReplay);
  $('btnFolder').addEventListener('click', () => api.openOutputDir());
  $('libOpenDir').addEventListener('click', () => api.openOutputDir());
  $('libRefresh').addEventListener('click', refreshLibrary);

  $('btnPick').addEventListener('click', openPicker);
  $('emptyPick').addEventListener('click', openPicker);
  $('sourceRow').addEventListener('click', openPicker);
  bindSegmented($('pickerTabs'), ui.pickerTab, (value) => {
    ui.pickerTab = value;
    renderPicker();
  });

  for (const modal of document.querySelectorAll('.modal')) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal || event.target.closest('[data-close]')) closeModals();
    });
  }
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (ui.countdownCancel) ui.countdownCancel();
    else if (!$('pickerModal').hidden || !$('playerModal').hidden) closeModals();
    else if (ui.cropEdit) endCropEdit(false);
  });

  $('camEnabled').addEventListener('change', (event) => applyCamera({ enabled: event.target.checked }));
  $('camDevice').addEventListener('change', (event) => applyCamera({ deviceId: event.target.value }));
  bindSegmented($('camShape'), settings.camera.shape, (value) => applyCamera({ shape: value }));
  $('camMirror').addEventListener('change', (event) => applyCamera({ mirror: event.target.checked }));
  $('camSize').addEventListener('input', (event) => {
    settings.camera.size = Number(event.target.value) / 100;
    setRangeFill(event.target);
    engine.pushLayout();
  });
  $('camSize').addEventListener('change', () => save({ camera: settings.camera }));

  $('replayEnabled').addEventListener('change', (event) => setReplay(event.target.checked));
  bindSegmented($('replaySeconds'), settings.replaySeconds, async (value) => {
    await save({ replaySeconds: Number(value) });
    engine.setReplaySeconds(settings.replaySeconds);
    render();
  });

  new ResizeObserver(fitStage).observe($('stage'));
  window.addEventListener('pointerdown', () => engine.resumeAudio(), { once: true });
  navigator.mediaDevices.addEventListener('devicechange', populateDevices);
}

function bindEngine() {
  engine.addEventListener('dims', () => {
    fitStage();
    renderSourceCard();
    renderQualityHint();
  });
  engine.addEventListener('stats', (event) => {
    ui.stats = event.detail;
    render();
  });
  engine.addEventListener('source', (event) => {
    if (event.detail && event.detail.source) ui.lastSource = event.detail.source;
    renderSourceCard();
    renderAudioCard();
    render();
  });
  engine.addEventListener('source-ended', async () => {
    renderSourceCard();
    renderAudioCard();
    render();
    const lost = ui.lastSource;
    api.log('error', `kaynak kapandı: ${lost && lost.id} (durum: ${ui.state})`);
    if (ui.state === 'recording' && lost) {
      // Kayıt sürerken ekran yakalaması koptuysa (ekran kartı sürücüsü, çözünürlük
      // değişimi vb.) aynı kaynağı sessizce yeniden yakalamayı dene.
      for (const delay of [300, 1500, 4000]) {
        await wait(delay);
        if (engine.source || ui.state !== 'recording') break;
        if (await chooseSource(lost, { quiet: true })) {
          toast({ title: t('toast.sourceBack'), kind: 'info' });
          api.log('info', 'kaynak yeniden yakalandı');
          return;
        }
      }
      if (!engine.source && ui.state === 'recording') {
        toast({ title: t('toast.sourceLostRec'), kind: 'error', timeout: 15000 });
        notifySystem(t('toast.sourceLostRec'), lost.name || '');
      }
      return;
    }
    toast({ title: t('source.ended'), kind: 'info' });
  });
  engine.addEventListener('session', () => render());
  engine.addEventListener('mic-error', (event) => {
    api.log('error', `mikrofon hatası: ${event.detail.name} ${event.detail.message}`);
    if (event.detail.name === 'NotAllowedError') {
      toast({
        title: t('audio.micDenied'),
        sub: t('perm.micDenied'),
        kind: 'error',
        timeout: 15000,
        action: { label: t('perm.openSettings'), run: () => api.openSystemSettings('mic') },
      });
    } else if (event.detail.name !== 'NotFoundError') {
      // Mikrofonu olmayan bilgisayarda her açılışta uyarı çıkarmak gereksiz.
      toast({ title: t('audio.micError'), sub: event.detail.name, kind: 'error', timeout: 9000 });
    }
    renderAudioCard();
  });
  engine.addEventListener('mic-lost', () => {
    api.log('error', `mikrofon koptu (durum: ${ui.state})`);
    toast({ title: t('audio.micLost'), kind: 'error', timeout: 15000 });
    notifySystem(t('audio.micLost'), '');
    renderAudioCard();
  });
  engine.addEventListener('mic-restored', () => {
    api.log('info', 'mikrofon yeniden bağlandı');
    toast({ title: t('audio.micRestored'), kind: 'ok' });
    notifySystem(t('audio.micRestored'), '');
    renderAudioCard();
  });
  engine.addEventListener('noise-fallback', () => {
    api.log('error', 'güçlü gürültü engelleme yüklenemedi, mikrofon engellemesiz çalışıyor');
    toast({ title: t('audio.noiseFallback'), kind: 'error', timeout: 9000 });
  });
  engine.addEventListener('mic-fallback', (event) => {
    api.log('info', `seçili mikrofon yok, varsayılan: ${event.detail.label}`);
    toast({ title: t('audio.micFallback'), sub: event.detail.label, kind: 'info', timeout: 8000 });
  });
  engine.addEventListener('camera-error', () => toast({ title: t('camera.error'), kind: 'error' }));
  engine.addEventListener('error', (event) => console.error('[engine]', event.detail.message));
  const restarts = [];
  engine.addEventListener('fatal', async (event) => {
    const message = event.detail.message;
    console.error('[engine fatal]', message);
    api.log('error', `motor hatası: ${message} (durum: ${ui.state})`);
    toast({ title: t('toast.fatal'), sub: message, kind: 'error', timeout: 9000 });
    const wasRecording = ui.state === 'recording';
    if (wasRecording) await stopRecord();
    if (engine.replayOn) await setReplay(false);
    // Oyun oynarken uyarıyı görmeyebilirsin: kodlayıcı hatasından sonra kayıt yeni
    // bir dosyada kendiliğinden sürer (10 dakikada en fazla 3 kez; disk/klasör
    // hatasında denenmez çünkü yeni dosya da yazılamaz).
    const now = Date.now();
    while (restarts.length && now - restarts[0] > 600000) restarts.shift();
    const storage = /disk-full|output-blocked|output-missing/.test(message);
    if (wasRecording && !storage && engine.source && restarts.length < 3 && !ui.closing) {
      restarts.push(now);
      await wait(1000);
      if (ui.state === 'idle') {
        await toggleRecord();
        if (ui.state === 'recording') {
          toast({ title: t('toast.autoRestart'), kind: 'info', timeout: 9000 });
          notifySystem(t('toast.autoRestart'), '');
          api.log('info', 'kayıt hatadan sonra yeni dosyada yeniden başlatıldı');
        }
      }
    } else if (wasRecording) {
      notifySystem(t('toast.fatal'), message);
    }
  });

  api.on('hotkey', (name) => {
    if (name === 'record') toggleRecord();
    else if (name === 'pause') togglePause();
    else if (name === 'replay') saveReplay();
    else if (name === 'screenshot') takeShot();
  });
  api.on('tray:action', (name) => {
    if (name === 'record') toggleRecord();
  });
  api.on('window:visibility', (visible) => {
    ui.hidden = !visible;
    engine.setPreviewVisible(visible);
  });
  api.on('app:closing', async () => {
    if (ui.closing) return;
    ui.closing = true;
    try {
      if (ui.state === 'recording') await stopRecord();
      if (engine.replayOn) await engine.setReplay(false);
    } finally {
      api.readyToClose();
    }
  });
}

// ------------------------------------------------------------------ izinler ve kayıt kontrolü

function permRow({ state, title, text, buttons = [] }) {
  const row = el('div', `perm-row ${state}`);
  const dot = el('div', 'perm-dot');
  dot.innerHTML = icon(state === 'ok' ? 'check' : state === 'wait' ? 'info' : state === 'warn' ? 'info' : 'x');
  const body = el('div', 'perm-text');
  body.append(el('b', '', title), el('small', '', text));
  if (buttons.length) {
    const box = el('div', 'perm-btns');
    for (const b of buttons) {
      const button = el('button', 'btn small', b.label);
      button.addEventListener('click', b.run);
      box.append(button);
    }
    body.append(box);
  }
  row.append(dot, body);
  return row;
}

async function chooseFolderAndRecheck() {
  const dir = await api.chooseDir();
  if (!dir) return;
  await save({ outputDir: dir });
  renderSettings();
  refreshLibrary();
  runPermissionCheck({ show: true });
}

let permRun = null;

// Ekran, mikrofon ve kayıt klasörü erişimini kontrol eder. Windows masaüstü
// uygulamalarına izin penceresi göstermez; izin kapalıysa kullanıcıya nedenini
// ve hangi ayarı açacağını söyleriz. Sorun varsa (ya da show) pencere açılır.
function runPermissionCheck(opts = {}) {
  if (!permRun) permRun = checkPermissionsNow(opts).finally(() => { permRun = null; });
  return permRun;
}

async function checkPermissionsNow({ show = false, retry = false } = {}) {
  const list = $('permList');
  if (show) {
    list.textContent = '';
    list.append(permRow({ state: 'wait', title: t('perm.checking'), text: '' }));
    $('permSummary').textContent = '';
    $('permModal').hidden = false;
  }
  if (retry) {
    // "Tekrar kontrol et": kullanıcı ayarı düzelttiyse mikrofonu ve ekranı yeniden aç.
    if (settings.mic.enabled && !engine.micStream) await engine.refreshMic({ quiet: true });
    if (!engine.source) {
      try {
        sources = await api.listSources();
        const screens = sources.filter((x) => x.type === 'screen');
        const target = screens.find((x) => x.primary) || screens[0];
        if (target) await chooseSource({ ...target, name: sourceLabel(target, screens.indexOf(target)) }, { quiet: true });
      } catch {}
    }
    renderAudioCard();
    populateDevices();
  }

  let res;
  try {
    res = await api.checkPermissions();
  } catch (err) {
    res = { mic: 'unknown', output: { ok: false, code: errorCode(err), free: null } };
  }
  const rows = [];

  const screenOk = !!engine.source;
  rows.push({
    state: screenOk ? 'ok' : 'bad',
    title: t('perm.screen'),
    text: screenOk ? t('perm.screenOk') : t('perm.screenBad'),
    buttons: screenOk ? [] : [{ label: t('perm.openSettings'), run: () => api.openSystemSettings('screen') }],
  });

  const micErr = engine.micError && engine.micError.name;
  const micSettings = { label: t('perm.openSettings'), run: () => api.openSystemSettings('mic') };
  let mic;
  if (!settings.mic.enabled) mic = { state: 'warn', text: t('perm.micOff') };
  else if (engine.micStream) {
    const track = engine.micStream.getAudioTracks()[0];
    mic = { state: 'ok', text: t('perm.micOk', { name: (track && track.label) || t('audio.default') }) };
  } else if (res.mic === 'denied' || micErr === 'NotAllowedError') {
    mic = { state: 'bad', text: t('perm.micDenied'), buttons: [micSettings] };
  } else if (micErr === 'NotFoundError') {
    mic = { state: 'bad', text: t('perm.micNone'), buttons: [{ label: t('perm.openSettings'), run: () => api.openSystemSettings('sound') }] };
  } else {
    mic = { state: 'bad', text: t('perm.micBusy'), buttons: [micSettings] };
  }
  rows.push({ title: t('perm.mic'), ...mic });

  const out = res.output || {};
  const folderBtn = { label: t('perm.chooseFolder'), run: chooseFolderAndRecheck };
  let output;
  if (out.ok) {
    const free = out.free;
    if (free !== null && free !== undefined && free < 10e9) {
      output = { state: 'warn', text: t('perm.diskLow', { free: fmtSize(free) }), buttons: [folderBtn] };
    } else {
      output = { state: 'ok', text: t('perm.outputOk', { free: free == null ? '?' : fmtSize(free) }) };
    }
  } else if (out.code === 'output-blocked') {
    output = {
      state: 'bad',
      text: t('perm.outputBlocked'),
      buttons: [{ label: t('perm.openSecurity'), run: () => api.openSystemSettings('cfa') }, folderBtn],
    };
  } else if (out.code === 'output-missing') {
    output = { state: 'bad', text: t('perm.outputMissing'), buttons: [folderBtn] };
  } else {
    output = { state: 'bad', text: t('perm.outputOther', { code: out.code || '?' }), buttons: [folderBtn] };
  }
  rows.push({ title: `${t('perm.output')} · ${out.dir || settings.outputDir}`, ...output });

  const bad = rows.some((r) => r.state === 'bad');
  api.log(bad ? 'error' : 'info', `izin kontrolü: ${rows.map((r) => `${r.title}=${r.state}`).join(' | ')}`);
  list.textContent = '';
  for (const row of rows) list.append(permRow(row));
  $('permSummary').textContent = bad ? t('perm.someBad') : t('perm.allOk');
  $('permSummary').classList.toggle('bad', bad);
  if (show || bad) $('permModal').hidden = false;
  return { bad, rows };
}

// Kayıt sürerken disk dolarsa dosya bozulmadan önce kaydı kendimiz kapatırız.
function startDiskMonitor() {
  setInterval(async () => {
    if (ui.state !== 'recording') return;
    const free = await api.diskFree().catch(() => null);
    if (free === null) return;
    if (free < 600 * 1024 ** 2) {
      api.log('error', `disk doldu (${free} bayt), kayıt durduruluyor`);
      toast({ title: t('toast.diskStop'), kind: 'error', timeout: 15000 });
      notifySystem(t('toast.diskStop'), '');
      await stopRecord();
    } else if (free < 3 * 1024 ** 3 && !ui.diskWarned) {
      ui.diskWarned = true;
      toast({ title: t('toast.diskLow', { free: fmtSize(free) }), kind: 'error', timeout: 12000 });
      notifySystem(t('toast.diskLow', { free: fmtSize(free) }), '');
    }
  }, 15000);
}

// ------------------------------------------------------------------ otomatik test

async function selftest() {
  const result = { ok: false };
  // Senkron işareti: aynı anda beyaz parlama + kısık bir bip. Kayıtta ikisinin
  // zamanı karşılaştırılarak ses-görüntü kayması ölçülür.
  const beepCtx = new AudioContext();
  const marker = async () => {
    // silent: kullanıcı başka bir kayıt alırken test bip sesi ve parlama üretmez.
    if ((settings.selftest || {}).silent) return wait(300);
    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    gain.gain.value = 0.06;
    osc.frequency.value = 880;
    osc.connect(gain).connect(beepCtx.destination);
    const flash = el('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:999';
    document.body.append(flash);
    osc.start();
    await wait(300);
    osc.stop();
    flash.remove();
  };
  try {
    await wait(1500);
    result.source = engine.source && engine.source.name;
    result.dims = engine.dims;
    result.systemAudio = engine.systemAvailable;
    result.mic = !!engine.micStream;
    result.micNoise = engine.micNoiseActive;
    result.micTrackSettings = engine.micTrackSettings;
    result.outputLatencyMs = Math.round((beepCtx.outputLatency || 0) * 1000);

    const opts = settings.selftest || {};
    if (opts.noPreview) engine.setPreviewVisible(false);
    if (opts.css) {
      const style = document.createElement('style');
      style.textContent = opts.css;
      document.head.append(style);
    }
    if (opts.window) {
      const target = sources.find((s) => s.type === 'window');
      if (target) await chooseSource(target);
      await wait(1000);
      result.windowSource = engine.source && engine.source.type;
      result.windowDims = engine.dims;
    }
    if (opts.fakeCam) {
      // Gerçek kamerayı açmadan kamera kutusunu denemek için yapay görüntü akışı.
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const g = canvas.getContext('2d');
      let n = 0;
      setInterval(() => {
        n += 1;
        g.fillStyle = `hsl(${(n * 3) % 360} 70% 45%)`;
        g.fillRect(0, 0, 640, 480);
        g.fillStyle = '#fff';
        g.font = 'bold 120px sans-serif';
        g.fillText('CAM', 185, 280);
      }, 33);
      settings.camera = { ...settings.camera, enabled: true, shape: opts.fakeCam, mirror: false };
      engine.settings = settings;
      engine.attachCamera(canvas.captureStream(30));
      await wait(500);
    }
    if (opts.crop) {
      engine.setCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
      await wait(600);
      result.cropDims = engine.dims;
    }
    if (opts.audioOnly) {
      settings.recordMode = 'audio';
      engine.settings = settings;
    }
    await toggleRecord(); // arayüzdeki kayıt düğmesiyle aynı yol
    if (ui.state !== 'recording') throw new Error(`kayıt başlamadı: ${ui.lastError}`);
    result.session = engine.sessionInfo;
    if (opts.micDrop && engine.micStream) {
      // Mikrofonun kayıt ortasında kopmasını taklit et; otomatik geri bağlanmalı.
      result.micEvents = [];
      for (const type of ['mic-lost', 'mic-restored']) {
        engine.addEventListener(type, () => result.micEvents.push(type));
      }
      engine.micStream.getAudioTracks()[0].dispatchEvent(new Event('ended'));
      await wait(4500);
      result.micAfterDrop = !!engine.micStream;
    }
    await wait(1500);
    await marker(); // ~1.5 sn
    await wait(1200);
    engine.pauseRecording();
    await wait(1500);
    engine.resumeRecording();
    await wait(1500);
    if (opts.hold) {
      // hold: uzun kayıt testi; bu aralıkta süreç bazında işlemci kullanımı ölçülür
      const before = await api.metrics();
      const started = performance.now();
      await wait(opts.hold);
      const seconds = (performance.now() - started) / 1000;
      const after = await api.metrics();
      const cpu = {};
      let total = 0;
      after.forEach((m, i) => {
        const used = ((m.cpuSeconds - (before[i] ? before[i].cpuSeconds : 0)) / seconds) * 100;
        cpu[m.type] = Math.round(((cpu[m.type] || 0) + used) * 10) / 10;
        total += used;
      });
      result.cpu = {
        perProcessPercentOfOneCore: cpu,
        totalPercentOfOneCore: Math.round(total * 10) / 10,
        totalPercentOfMachine: Math.round((total / navigator.hardwareConcurrency) * 10) / 10,
        memoryMB: after.reduce((sum, m) => sum + m.memoryMB, 0),
      };
    }
    await marker(); // duraklatmadan sonra, kayıtta ~4.5 sn (+hold)
    await wait(1200);
    result.stats = ui.stats;
    await stopRecord();
    result.recording = ui.lastFile;
    if (!result.recording) throw new Error(`kayıt kapanmadı: ${ui.lastError}`);
    if (opts.audioOnly) {
      settings.recordMode = 'video';
      engine.settings = settings;
    }

    await engine.setReplay(true);
    await wait(6000);
    result.replayStats = ui.stats;
    result.replay = await engine.saveReplay();
    await engine.setReplay(false);

    result.shot = await engine.screenshot();
    result.sessionEnded = !engine.sessionActive;
    result.codecs = await engine.probe();
    result.ok = true;
  } catch (err) {
    result.error = String((err && err.stack) || err);
  }
  api.selftestDone(result);
}

// ------------------------------------------------------------------ başlangıç

async function boot() {
  [settings, appInfo] = await Promise.all([api.getSettings(), api.appInfo()]);
  setLang(resolveLang(settings.language, appInfo.locale));
  applyIcons();
  applyI18n();
  $('railVersion').textContent = `v${appInfo.version}`;
  $('aboutVersion').textContent = `v${appInfo.version}`;
  $('aboutMeta').textContent = `Electron ${appInfo.electron} · Chromium ${appInfo.chrome} · GPL-3.0 · © Siber Tilki`;
  api.setTrayLabels({ show: t('tray.show'), start: t('tray.start'), stop: t('tray.stop'), quit: t('tray.quit') });

  engine = new Engine($('preview'));
  await engine.init(settings);
  if (appInfo.selftest) {
    // Test ve tanıtım görüntüsü düzeneği için (yalnızca test modlarında).
    window.__tilki = {
      engine,
      ui,
      setSources(list) {
        sources = list;
        renderSourceCard();
      },
    };
  }

  bindUi();
  bindSettings();
  bindHotkeys();
  bindAudio();
  bindCrop();
  bindCameraDrag();
  bindEngine();
  renderSettings();
  renderCameraCard();
  renderAudioCard();
  renderSourceCard();
  render();
  startMeters();
  applyHotkeys();

  // Son kullanılan kaynağı (yoksa ana ekranı) kendiliğinden aç.
  try {
    sources = await api.listSources();
    const screens = sources.filter((s) => s.type === 'screen');
    const preferred = sources.find((s) => s.id === settings.lastSourceId && s.type === 'screen')
      || screens.find((s) => s.primary)
      || screens[0];
    if (preferred) {
      await chooseSource({ ...preferred, name: sourceLabel(preferred, screens.indexOf(preferred)) }, { quiet: true });
    }
  } catch (err) {
    console.error('Kaynak listesi alınamadı', err);
  }

  await engine.refreshMic();
  if (settings.camera.enabled) await engine.refreshCamera();
  await populateDevices();
  renderAudioCard();
  renderCameraCard();

  startDiskMonitor();

  if (SELFTEST) {
    selftest();
    return;
  }

  // Arayüz bir önceki çalışmada çöktüyse yarım kalan kayıt korunmuştur; haber ver.
  try {
    for (const file of await api.takeRescued()) {
      toast({
        title: t('toast.rescued'),
        sub: `${file.name} · ${fmtSize(file.size)}`,
        kind: 'info',
        timeout: 15000,
        action: { label: t('toast.show'), run: () => api.revealItem(file.path) },
      });
    }
  } catch {}

  // İlk açılışta izin/klasör kontrolünü göster; sonraki açılışlarda yalnızca sorun varsa.
  const firstRun = !settings.permissionsShown;
  await runPermissionCheck({ show: firstRun }).catch((err) => console.error('izin kontrolü', err));
  if (firstRun) await save({ permissionsShown: true });

  if (settings.replayEnabled && engine.source) await setReplay(true);
}

boot().catch((err) => {
  console.error(err);
  if (SELFTEST) api.selftestDone({ ok: false, error: String((err && err.stack) || err) });
});
