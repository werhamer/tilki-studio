// Renderer ve worker paketlerini esbuild ile üretir.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options = {
  absWorkingDir: root,
  entryPoints: {
    app: 'src/renderer/src/app.js',
    worker: 'src/renderer/src/worker.js',
  },
  outdir: 'src/renderer/dist',
  bundle: true,
  format: 'iife',
  target: 'chrome130',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

// RNNoise gürültü engelleme dosyaları (AudioWorklet + wasm) arayüzün yanına kopyalanır.
const nsSrc = path.join(root, 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist');
const nsDst = path.join(root, 'src', 'renderer', 'dist', 'rnnoise');
fs.mkdirSync(nsDst, { recursive: true });
for (const [from, to] of [
  ['rnnoise/workletProcessor.js', 'workletProcessor.js'],
  ['rnnoise.wasm', 'rnnoise.wasm'],
  ['rnnoise_simd.wasm', 'rnnoise_simd.wasm'],
]) {
  fs.copyFileSync(path.join(nsSrc, from), path.join(nsDst, to));
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
