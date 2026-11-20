'use strict';
/*
 * Tilki Studio — Copyright (C) 2026 Siber Tilki
 * GNU Genel Kamu Lisansı sürüm 3 (GPL-3.0-only) ile lisanslanmıştır; bkz. LICENSE.
 * "Tilki Studio" adı ve tilki logosu Siber Tilki'nin markasıdır; bkz. TRADEMARKS.md.
 *
 * Tilki Studio — ana süreç
 * Pencere, tepsi simgesi, genel kısayollar, kaynak listesi ve dosya yazımı burada.
 * Kayıt motorunun kendisi arayüz tarafında (src/renderer) çalışır.
 */
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut,
  Tray, Menu, shell, dialog, nativeImage, screen, protocol, systemPreferences,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Readable } = require('node:stream');
const { Store } = require('./store');

const fsp = fs.promises;
const SELFTEST = process.argv.includes('--selftest');
// Geliştirici aracı: --screenshots=<klasör> her sayfanın görüntüsünü kaydeder.
const SHOTS = (process.argv.find((a) => a.startsWith('--screenshots=')) || '').split('=')[1] || null;
const ISOLATED = SELFTEST || !!SHOTS;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm']);
const IMAGE_EXT = new Set(['.png']);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCEncoderSupport');
// Kaydedici arka planda ya da bir oyunun arkasında kalsa bile yavaşlatılmamalı.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([
  { scheme: 'tilki', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (ISOLATED) {
  // Otomatik test kullanıcının gerçek ayarlarına ve Videolar klasörüne dokunmaz.
  const tmp = process.env.TILKI_SELFTEST_DIR || path.join(os.tmpdir(), 'tilki-selftest');
  fs.mkdirSync(tmp, { recursive: true });
  app.setPath('userData', path.join(tmp, 'userData'));
}

// ---------------------------------------------------------------- günlük
// "Arada bir" çıkan sorunları sonradan görebilmek için hatalar diske de yazılır:
// %APPDATA%\Tilki Studio\logs\tilki-YYYY-MM-DD.log (son 10 gün tutulur).
let logStream = null;
function openLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const old = fs.readdirSync(dir).filter((n) => /^tilki-.*\.log$/.test(n)).sort();
    for (const name of old.slice(0, Math.max(0, old.length - 10))) fs.rmSync(path.join(dir, name), { force: true });
    logStream = fs.createWriteStream(path.join(dir, `tilki-${stamp().slice(0, 10)}.log`), { flags: 'a' });
  } catch {
    logStream = null;
  }
}
function log(level, ...parts) {
  if (!logStream) return;
  const text = parts
    .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  try {
    logStream.write(`${new Date().toISOString()} [${level}] ${text}\n`);
  } catch {}
}
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    log(level, ...args);
  };
}

// Dosya sistemi hatalarını arayüzün anlayacağı kısa kodlara çevirir.
// Windows Güvenliği'nin "Denetimli klasör erişimi" engeli EPERM/EACCES olarak gelir.
function fsErrorCode(err) {
  const code = err && err.code;
  if (code === 'EPERM' || code === 'EACCES') return 'output-blocked';
  if (code === 'ENOSPC') return 'disk-full';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'output-missing';
  return null;
}
function rethrowFs(err) {
  const mapped = fsErrorCode(err);
  console.error('[fs]', (err && err.code) || '', (err && err.message) || String(err));
  throw mapped ? new Error(mapped) : err;
}

async function freeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

const MIN_FREE_TO_START = 1024 ** 3; // 1 GB altında kayıt başlatılmaz

// Kayıt klasörüne gerçekten yazılabiliyor mu? (izin, Denetimli klasör erişimi, disk)
async function checkOutput() {
  const dir = outputDir();
  const result = { dir, ok: false, code: null, free: null };
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.tilki-yazma-testi-${process.pid}.tmp`);
    const handle = await fsp.open(probe, 'w');
    try {
      await handle.write(Buffer.from('tilki'));
    } finally {
      await handle.close();
    }
    await fsp.unlink(probe).catch(() => {});
    result.ok = true;
  } catch (err) {
    result.code = fsErrorCode(err) || String((err && err.code) || err);
    console.error('[output-check]', dir, (err && err.code) || '', (err && err.message) || '');
  }
  result.free = await freeBytes(dir);
  return result;
}

// Windows ayar sayfaları (yalnızca bu liste açılabilir).
const SETTINGS_PAGES = {
  mic: 'ms-settings:privacy-microphone',
  camera: 'ms-settings:privacy-webcam',
  screen: 'ms-settings:privacy-graphicsCaptureProgrammatic',
  cfa: 'windowsdefender://ransomwareprotection/',
  sound: 'ms-settings:sound',
};

let win = null;
let tray = null;
let store = null;
let forceClose = false;
let appState = { recording: false, paused: false, replay: false };
let trayLabels = { show: 'Göster', start: 'Kaydı başlat', stop: 'Kaydı durdur', quit: 'Çıkış' };
const openFiles = new Map();
const rescuedFiles = []; // arayüz çökerse yarım kalan kayıtlar (yeniden yüklenince bildirilir)
let fileCounter = 0;

function defaults() {
  return {
    language: 'auto',
    outputDir: path.join(app.getPath('videos'), 'Tilki Studio'),
    container: 'mp4',
    codec: 'h264',
    resolution: 'source',
    fps: 60,
    quality: 'high',
    crashSafe: false,
    audioBitrate: 192,
    separateTracks: false,
    countdown: 0,
    hideFromCapture: false,
    minimizeOnRecord: false,
    replayEnabled: false,
    replaySeconds: 30,
    hotkeys: {
      // Alt+F tuşları: yazılım ve tarayıcılardaki yaygın kısayollarla çakışmaz.
      record: 'Alt+F9',
      pause: 'Alt+F10',
      replay: 'Alt+F11',
      screenshot: 'Alt+F12',
    },
    system: { enabled: true, volume: 1 },
    mic: { enabled: true, deviceId: 'default', volume: 1, noiseSuppression: true },
    camera: { enabled: false, deviceId: '', shape: 'circle', size: 0.28, x: 0.86, y: 0.78, mirror: true },
    lastSourceId: null,
    // İzin/klasör kontrol penceresi ilk açılışta bir kez gösterilir.
    permissionsShown: false,
  };
}

function outputDir() {
  if (ISOLATED) return process.env.TILKI_SELFTEST_DIR || path.join(os.tmpdir(), 'tilki-selftest');
  return store.get().outputDir;
}

function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}_${i}.${ext}`);
  return candidate;
}

// ---------------------------------------------------------------- protokol

async function serveApp(url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const isAsset = rel.startsWith('/assets/');
  const base = isAsset ? ASSETS_DIR : RENDERER_DIR;
  const file = path.join(base, isAsset ? rel.slice('/assets/'.length) : rel);
  if (!isInside(base, file)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await fsp.readFile(file);
    return new Response(data, {
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function serveMedia(request, url) {
  const file = path.resolve(url.searchParams.get('path') || '');
  if (!isInside(outputDir(), file)) return new Response('Forbidden', { status: 403 });
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(0, stat.size - Number(range[2]));
    }
    status = 206;
  }
  if (start > end || start >= stat.size) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
  }
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    'cache-control': 'no-store',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
}

function registerProtocol() {
  protocol.handle('tilki', (request) => {
    const url = new URL(request.url);
    if (url.host === 'app') return serveApp(url);
    if (url.host === 'media') return serveMedia(request, url);
    return new Response('Not found', { status: 404 });
  });
}

// ---------------------------------------------------------------- pencere

function iconPath(name) {
  return path.join(ASSETS_DIR, name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#0c0d10',
    title: 'Tilki Studio',
    icon: iconPath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d10', symbolColor: '#9aa1ad', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Pencere küçültülse de kayıt motoru tam hızda çalışmaya devam etmeli.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`tilki://app/index.html${SELFTEST ? '?selftest=1' : ''}`);

  win.once('ready-to-show', () => {
    if (!ISOLATED) return win.show();
    // Test modları odağı asla çalmaz; TILKI_TEST_HIDDEN ile pencere hiç açılmaz.
    if (process.env.TILKI_TEST_HIDDEN) return;
    if (SELFTEST) win.setAlwaysOnTop(true); // senkron testi için pencere kayıtta görünmeli
    win.showInactive();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('tilki://app/')) event.preventDefault();
  });

  const visibility = () => {
    if (win && !win.isDestroyed()) win.webContents.send('window:visibility', win.isVisible() && !win.isMinimized());
  };
  for (const ev of ['minimize', 'restore', 'show', 'hide']) win.on(ev, visibility);

  win.on('close', (event) => {
    if (forceClose || !(appState.recording || appState.replay)) return;
    // Kayıt sürüyorsa önce dosya düzgünce kapatılır, sonra pencere kapanır.
    event.preventDefault();
    win.webContents.send('app:closing');
    setTimeout(() => {
      forceClose = true;
      if (win && !win.isDestroyed()) win.close();
    }, 20000);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[render-process-gone] ${JSON.stringify(details)}`);
    // Arayüz çökerse donmuş bir pencere bırakma: yeniden yükle.
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
      // Yarım kalan kayıt dosyaları silinmez; yalnızca kapatılır (MKV yine oynatılabilir).
      for (const [id, entry] of openFiles) {
        openFiles.delete(id);
        entry.handle.close().catch(() => {});
        console.error(`[render-process-gone] yarım dosya korundu: ${entry.path} (${entry.size} bayt)`);
        if (entry.kind === 'recording' && entry.size > 0) {
          rescuedFiles.push({ path: entry.path, name: path.basename(entry.path), size: entry.size });
        }
      }
      appState = { recording: false, paused: false, replay: false };
      refreshTray();
      setTimeout(() => win && !win.isDestroyed() && win.reload(), 500);
    }
  });
  win.webContents.on('unresponsive', () => console.error('[unresponsive]'));
  win.webContents.on('console-message', (event) => {
    const level = event.level;
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) {
      console.error(`[renderer ${level}] ${event.message}`);
    }
  });

  win.on('closed', () => {
    win = null;
  });

  applyContentProtection();
}

function applyContentProtection() {
  if (win && !win.isDestroyed()) win.setContentProtection(!!store.get().hideFromCapture);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function captureViews() {
  const wc = win.webContents;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (wc.isLoading()) await new Promise((resolve) => wc.once('did-finish-load', resolve));
  await pause(3500);
  fs.mkdirSync(SHOTS, { recursive: true });
  const steps = (process.env.TILKI_SHOT_STEPS ? JSON.parse(process.env.TILKI_SHOT_STEPS) : null) || [
    ['studio', "document.querySelector('[data-view=studio]').click()"],
    ['library', "document.querySelector('[data-view=library]').click()"],
    ['settings', "document.querySelector('[data-view=settings]').click()"],
  ];
  for (const [name, script] of steps) {
    if (script === '@crash') {
      // Arayüz sürecini zorla çökert; pencere kendini yeniden yüklemeli.
      wc.forcefullyCrashRenderer();
      await pause(6000);
      continue;
    }
    if (script === '@close') {
      // Kullanıcının pencereyi kapatmasını taklit eder ve kapanmasını bekler.
      const closed = new Promise((resolve) => win.once('closed', resolve));
      win.close();
      await Promise.race([closed, pause(15000)]);
      return;
    }
    if (name.startsWith('!')) {
      // Yalnızca çalıştır ve sonucu yaz; ekran görüntüsü alma.
      const value = await wc.executeJavaScript(script, true);
      console.log(`[step ${name.slice(1)}] ${JSON.stringify(value)}`);
      continue;
    }
    await wc.executeJavaScript(script, true);
    await pause(1200);
    // Görünmez pencerede yalnızca değişen bölgeler çizilir; tam kare için zorla.
    wc.invalidate();
    await pause(300);
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
  }
}

// ---------------------------------------------------------------- tepsi

function buildTray() {
  try {
    const image = nativeImage.createFromPath(iconPath('tray.png'));
    if (image.isEmpty()) return;
    tray = new Tray(image);
    tray.on('click', showWindow);
    refreshTray();
  } catch (err) {
    console.error('Tepsi simgesi oluşturulamadı:', err.message);
  }
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(appState.recording ? 'Tilki Studio — REC' : 'Tilki Studio');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayLabels.show, click: showWindow },
    {
      label: appState.recording ? trayLabels.stop : trayLabels.start,
      click: () => win && win.webContents.send('tray:action', 'record'),
    },
    { type: 'separator' },
    { label: trayLabels.quit, click: () => (win ? win.close() : app.quit()) },
  ]));
}

// ---------------------------------------------------------------- kısayollar

function applyHotkeys(map) {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [name, accelerator] of Object.entries(map || {})) {
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => win && win.webContents.send('hotkey', name));
      if (!ok) failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    locale: app.getLocale(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    selftest: ISOLATED,
  }));

  // Süreç bazında işlemci süresi ve bellek (otomatik testte performans ölçümü için).
  ipcMain.handle('app:metrics', () => app.getAppMetrics().map((m) => ({
    type: m.serviceName || m.name || m.type,
    cpuSeconds: m.cpu.cumulativeCPUUsage || 0,
    memoryMB: Math.round(m.memory.workingSetSize / 1024),
  })));

  ipcMain.handle('settings:get', () => store.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const data = store.set(patch);
    if (patch && 'hideFromCapture' in patch) applyContentProtection();
    return data;
  });

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 384, height: 216 },
      fetchWindowIcons: true,
    });
    const displays = screen.getAllDisplays();
    const ownId = win ? win.getMediaSourceId() : null;
    return sources
      .filter((s) => s.id !== ownId)
      .map((s) => {
        const isScreen = s.id.startsWith('screen:');
        const display = isScreen ? displays.find((d) => String(d.id) === s.display_id) : null;
        return {
          id: s.id,
          name: s.name,
          type: isScreen ? 'screen' : 'window',
          thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
          width: display ? Math.round(display.size.width * display.scaleFactor) : null,
          height: display ? Math.round(display.size.height * display.scaleFactor) : null,
          primary: display ? display.id === screen.getPrimaryDisplay().id : false,
        };
      });
  });

  // --- dosya yazımı: arayüzdeki muxer parçaları konumlarıyla birlikte gönderir
  ipcMain.handle('file:open', async (_e, { kind, ext }) => {
    const safeExt = ['mp4', 'mkv', 'webm'].includes(ext) ? ext : 'mp4';
    const dir = outputDir();
    let handle;
    let file;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const free = await freeBytes(dir);
      if (free !== null && free < MIN_FREE_TO_START) throw Object.assign(new Error('disk-full'), { code: 'ENOSPC' });
      const base = kind === 'replay' ? `Tilki_Replay_${stamp()}` : `Tilki_${stamp()}`;
      file = await uniquePath(dir, base, safeExt);
      handle = await fsp.open(file, 'w');
    } catch (err) {
      rethrowFs(err);
    }
    const id = ++fileCounter;
    openFiles.set(id, { handle, path: file, size: 0, kind });
    console.log(`[file] açıldı ${file}`);
    return { id, path: file, name: path.basename(file) };
  });

  // Test kancası: TILKI_TEST_FAIL_WRITE_AFTER bayttan sonra yazmalar "disk dolu" hatası verir.
  const failAfter = ISOLATED ? Number(process.env.TILKI_TEST_FAIL_WRITE_AFTER || 0) : 0;
  ipcMain.handle('file:write', async (_e, id, data, position) => {
    const entry = openFiles.get(id);
    if (!entry) throw new Error('Dosya açık değil');
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (failAfter && entry.kind === 'recording' && position + buffer.length > failAfter) {
      rethrowFs(Object.assign(new Error('test: ENOSPC'), { code: 'ENOSPC' }));
    }
    try {
      await entry.handle.write(buffer, 0, buffer.length, position);
    } catch (err) {
      rethrowFs(err);
    }
    entry.size = Math.max(entry.size, position + buffer.length);
  });

  // Kayıt bir hatayla bittiğinde dosyayı silmek yerine korur. Yalnızca neredeyse
  // boş dosyalar (64 KB altı) silinir. Dönen değer: korunan dosya ya da null.
  ipcMain.handle('file:salvage', async (_e, id) => {
    const entry = openFiles.get(id);
    if (!entry) return null;
    openFiles.delete(id);
    await entry.handle.close().catch(() => {});
    if (entry.size < 64 * 1024) {
      await fsp.unlink(entry.path).catch(() => {});
      return null;
    }
    console.error(`[file] hata sonrası korundu ${entry.path} (${entry.size} bayt)`);
    return { path: entry.path, name: path.basename(entry.path), size: entry.size };
  });

  ipcMain.handle('disk:free', async () => freeBytes(outputDir()));

  ipcMain.handle('perm:check', async () => {
    const status = (type) => {
      try {
        return systemPreferences.getMediaAccessStatus(type);
      } catch {
        return 'unknown';
      }
    };
    return {
      mic: status('microphone'),
      camera: status('camera'),
      screen: status('screen'),
      output: await checkOutput(),
    };
  });

  ipcMain.handle('perm:open', (_e, key) => {
    const target = SETTINGS_PAGES[key];
    if (target) shell.openExternal(target).catch((err) => console.error('[perm:open]', err.message));
  });

  ipcMain.handle('rescued:take', () => rescuedFiles.splice(0));

  ipcMain.on('log', (_e, level, message) => {
    if (typeof message === 'string') log(level === 'error' ? 'error' : 'info', `[ui] ${message.slice(0, 2000)}`);
  });

  ipcMain.handle('file:close', async (_e, id) => {
    const entry = openFiles.get(id);
    if (!entry) return null;
    openFiles.delete(id);
    await entry.handle.close();
    console.log(`[file] kapandı ${entry.path} (${entry.size} bayt)`);
    return { path: entry.path, name: path.basename(entry.path), size: entry.size };
  });

  ipcMain.handle('file:abort', async (_e, id) => {
    const entry = openFiles.get(id);
    if (!entry) return;
    openFiles.delete(id);
    await entry.handle.close().catch(() => {});
    await fsp.unlink(entry.path).catch(() => {});
  });

  ipcMain.handle('file:save-image', async (_e, data) => {
    const dir = outputDir();
    await fsp.mkdir(dir, { recursive: true });
    const file = await uniquePath(dir, `Tilki_Shot_${stamp()}`, 'png');
    await fsp.writeFile(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return { path: file, name: path.basename(file) };
  });

  // --- kütüphane
  ipcMain.handle('library:list', async () => {
    const dir = outputDir();
    const busy = new Set([...openFiles.values()].map((f) => f.path));
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return { dir, items: [] };
    }
    const items = [];
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null;
      const file = path.join(dir, name);
      if (!kind || busy.has(file)) continue;
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size === 0) continue;
        items.push({
          name,
          path: file,
          kind,
          size: stat.size,
          mtime: stat.mtimeMs,
          url: `tilki://media/?path=${encodeURIComponent(file)}&v=${Math.round(stat.mtimeMs)}`,
        });
      } catch {
        // Listeleme sırasında silinmiş olabilir.
      }
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { dir, items };
  });

  const guarded = (fn) => async (_e, file) => {
    if (typeof file !== 'string' || !isInside(outputDir(), file)) return false;
    await fn(path.resolve(file));
    return true;
  };
  ipcMain.handle('library:trash', guarded((file) => shell.trashItem(file)));
  ipcMain.handle('library:reveal', guarded(async (file) => shell.showItemInFolder(file)));
  ipcMain.handle('library:open', guarded((file) => shell.openPath(file)));
  ipcMain.handle('library:open-dir', async () => {
    const dir = outputDir();
    await fsp.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle('dialog:choose-dir', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.get().outputDir,
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('hotkeys:apply', (_e, map) => applyHotkeys(map));

  ipcMain.handle('state:update', (_e, next) => {
    const wasRecording = appState.recording;
    appState = { ...appState, ...next };
    refreshTray();
    if (win && !win.isDestroyed()) {
      win.setTitle(appState.recording ? 'Tilki Studio — REC' : 'Tilki Studio');
      if (!wasRecording && appState.recording && store.get().minimizeOnRecord) win.minimize();
    }
  });

  ipcMain.handle('tray:labels', (_e, labels) => {
    trayLabels = { ...trayLabels, ...labels };
    refreshTray();
  });

  ipcMain.handle('shell:external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });

  ipcMain.on('app:ready-to-close', () => {
    forceClose = true;
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('selftest:done', (_e, result) => {
    const line = JSON.stringify(result, null, 2);
    console.log(`SELFTEST_RESULT ${line}`);
    try {
      fs.writeFileSync(path.join(outputDir(), 'selftest-result.json'), line);
    } catch {
      // Sonuç zaten konsola yazıldı.
    }
    if (process.env.TILKI_SELFTEST_KEEP_OPEN) return;
    forceClose = true;
    app.exit(result && result.ok ? 0 : 1);
  });
}

// ---------------------------------------------------------------- yaşam döngüsü

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Uygulama ikinci kez açılırsa var olan pencereyi öne getir; pencere yoksa
  // (örneğin önceki kapanış yarım kaldıysa) yenisini aç.
  app.on('second-instance', () => (win && !win.isDestroyed() ? showWindow() : createWindow()));
  app.on('child-process-gone', (_e, details) => console.error(`[child-process-gone] ${JSON.stringify(details)}`));

  app.whenReady().then(() => {
    openLog();
    console.log(`[start] Tilki Studio ${app.getVersion()} · Electron ${process.versions.electron} · ${process.execPath}`);
    app.setAppUserModelId('com.sibertilki.tilkistudio');
    store = new Store(path.join(app.getPath('userData'), 'settings.json'), defaults());
    if (ISOLATED) {
      // Her test temiz varsayılanlarla başlar; istenirse ortam değişkeniyle ayar verilir.
      store.data = defaults();
      if (process.env.TILKI_SELFTEST_SETTINGS) store.set(JSON.parse(process.env.TILKI_SELFTEST_SETTINGS));
    }

    const allowed = ['media', 'display-capture', 'notifications'];
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowed.includes(permission));
    });
    // navigator.permissions sorguları da aynı yanıtı versin (aksi halde "prompt" görünür).
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));

    registerProtocol();
    registerIpc();
    createWindow();
    if (!ISOLATED) buildTray();
    if (SHOTS) captureViews().catch((err) => console.error(err)).finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    app.quit();
    // Asılı kalan bir alt süreç (örneğin yanıt vermeyen GPU) kapanışı engellerse
    // arka planda penceresiz bir Tilki Studio kalmasın.
    setTimeout(() => app.exit(0), 4000);
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    for (const entry of openFiles.values()) entry.handle.close().catch(() => {});
  });
}
