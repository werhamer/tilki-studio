'use strict';
// SVG logolardan PNG ikonları üretir:  npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '..', 'assets');
const jobs = [
  ['icon.svg', 'icon.png', 512],
  ['logo.svg', 'tray.png', 32],
  ['logo.svg', 'tray@2x.png', 64],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  for (const [source, target, size] of jobs) {
    const svg = fs.readFileSync(path.join(assets, source)).toString('base64');
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = ${size};
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG yüklenemedi'));
      img.src = 'data:image/svg+xml;base64,${svg}';
    })`);
    fs.writeFileSync(path.join(assets, target), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${target} (${size}px)`);
  }
  app.quit();
});
