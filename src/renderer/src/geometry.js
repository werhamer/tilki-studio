// Kamera kutusunun çıktı karesindeki yeri. Hem çizimde (worker) hem de
// fareyle sürüklemede (arayüz) aynı hesap kullanılır.
export function camRect(cam, W, H) {
  const base = Math.min(W, H);
  const h = Math.max(16, cam.size * base);
  const w = cam.shape === 'wide' ? (h * 16) / 9 : h;
  const cx = Math.min(W - w / 2, Math.max(w / 2, cam.x * W));
  const cy = Math.min(H - h / 2, Math.max(h / 2, cam.y * H));
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
    cx,
    cy,
    r: cam.shape === 'circle' ? h / 2 : h * 0.12,
  };
}

export const RESOLUTIONS = {
  source: null,
  '2160p': { w: 3840, h: 2160 },
  '1440p': { w: 2560, h: 1440 },
  '1080p': { w: 1920, h: 1080 },
  '720p': { w: 1280, h: 720 },
};

// Kalite ön ayarları: piksel başına bit (H.264 için). Verimli kodekler daha azıyla yetinir.
export const QUALITY_BPP = { low: 0.045, medium: 0.075, high: 0.115, ultra: 0.18 };
export const CODEC_EFFICIENCY = { h264: 1, hevc: 0.65, av1: 0.6, vp9: 0.7, vp8: 1.1 };

export function targetBitrate(width, height, fps, quality, codec) {
  const bpp = QUALITY_BPP[quality] || QUALITY_BPP.high;
  const raw = width * height * fps * bpp * (CODEC_EFFICIENCY[codec] || 1);
  return Math.round(Math.min(120e6, Math.max(1.5e6, raw)));
}
