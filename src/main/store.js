'use strict';
// Ayarların diskte tutulduğu küçük JSON deposu.
const fs = require('node:fs');
const path = require('node:path');

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.data = defaults;
    try {
      this.data = merge(defaults, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // İlk açılış ya da bozuk dosya: varsayılanlarla devam.
    }
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = merge(this.data, patch);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('Ayarlar kaydedilemedi:', err.message);
    }
    return this.data;
  }
}

module.exports = { Store };
