'use strict';
// Arayüz ile ana süreç arasındaki tek köprü. Arayüz Node'a doğrudan erişmez.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(['hotkey', 'window:visibility', 'app:closing', 'tray:action']);

contextBridge.exposeInMainWorld('tilki', {
  appInfo: invoke('app:info'),
  metrics: invoke('app:metrics'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),

  listSources: invoke('sources:list'),
  listMinimizedWindows: invoke('sources:minimized'),
  restoreWindow: invoke('window:restore'),

  openFile: invoke('file:open'),
  writeFile: invoke('file:write'),
  closeFile: invoke('file:close'),
  abortFile: invoke('file:abort'),
  salvageFile: invoke('file:salvage'),
  diskFree: invoke('disk:free'),
  checkPermissions: invoke('perm:check'),
  openSystemSettings: invoke('perm:open'),
  takeRescued: invoke('rescued:take'),
  log: (level, message) => ipcRenderer.send('log', level, String(message)),
  saveImage: invoke('file:save-image'),

  listLibrary: invoke('library:list'),
  trashItem: invoke('library:trash'),
  revealItem: invoke('library:reveal'),
  openItem: invoke('library:open'),
  openOutputDir: invoke('library:open-dir'),
  chooseDir: invoke('dialog:choose-dir'),

  applyHotkeys: invoke('hotkeys:apply'),
  updateState: invoke('state:update'),
  setTrayLabels: invoke('tray:labels'),
  openExternal: invoke('shell:external'),

  readyToClose: () => ipcRenderer.send('app:ready-to-close'),
  selftestDone: (result) => ipcRenderer.send('selftest:done', result),

  on(channel, callback) {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
});
