// Tanıtım ekran görüntüleri için yapay kaynak: gerçek ekran yerine canlı bir demo
// sahnesi ve kamera yerine tilki logolu bir görüntü verir. Böylece README
// görsellerinde kimsenin kişisel ekranı görünmez.
// scripts/screenshots.py tarafından --screenshots modunda sayfaya enjekte edilir.
(async () => {
  const W = 1920;
  const H = 1080;
  const t0 = performance.now();

  // ------------------------------------------------------------ demo sahne
  const scene = document.createElement('canvas');
  scene.width = W;
  scene.height = H;
  const g = scene.getContext('2d');
  const horizon = 640;
  const stars = Array.from({ length: 140 }, (_, i) => ({
    x: (i * 7919) % W,
    y: (i * 104729) % (horizon - 60),
    r: (i % 3) * 0.6 + 0.6,
  }));

  function drawScene() {
    const t = (performance.now() - t0) / 1000;
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#0b0420');
    sky.addColorStop(0.55, '#2a0b45');
    sky.addColorStop(1, '#ff5d3a');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, horizon);

    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (const s of stars) {
      g.globalAlpha = 0.35 + 0.35 * Math.sin(t * 2 + s.x);
      g.beginPath();
      g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // güneş (yatay şeritli)
    const sun = g.createLinearGradient(0, horizon - 420, 0, horizon);
    sun.addColorStop(0, '#ffd36b');
    sun.addColorStop(1, '#ff3d7f');
    g.save();
    g.beginPath();
    g.arc(W / 2, horizon - 40, 260, Math.PI, 0);
    g.closePath();
    g.clip();
    g.fillStyle = sun;
    g.fillRect(W / 2 - 260, horizon - 300, 520, 300);
    g.fillStyle = '#2a0b45';
    for (let i = 0; i < 7; i++) {
      const y = horizon - 150 + i * 22 + ((t * 18) % 22);
      g.fillRect(W / 2 - 260, y, 520, 4 + i * 1.6);
    }
    g.restore();

    // dağlar
    g.fillStyle = '#1a0630';
    g.beginPath();
    g.moveTo(0, horizon);
    const peaks = [[0, 520], [180, 430], [360, 560], [520, 470], [700, 600], [1220, 600], [1380, 450], [1560, 540], [1740, 410], [1920, 520], [1920, horizon]];
    for (const [x, y] of peaks) g.lineTo(x, y);
    g.fill();

    // zemin ve perspektif ızgara
    const ground = g.createLinearGradient(0, horizon, 0, H);
    ground.addColorStop(0, '#16052a');
    ground.addColorStop(1, '#06010d');
    g.fillStyle = ground;
    g.fillRect(0, horizon, W, H - horizon);
    g.strokeStyle = 'rgba(255, 64, 196, 0.75)';
    g.lineWidth = 2;
    for (let i = -24; i <= 24; i++) {
      g.beginPath();
      g.moveTo(W / 2 + i * 40, horizon);
      g.lineTo(W / 2 + i * 260, H);
      g.stroke();
    }
    const phase = (t * 0.9) % 1;
    for (let k = 0; k < 14; k++) {
      const z = (k + phase) / 14;
      const y = horizon + (H - horizon) * z * z;
      g.globalAlpha = Math.min(1, z * 2);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    g.globalAlpha = 1;

    // araç
    const carX = W / 2 + Math.sin(t * 1.3) * 160;
    g.fillStyle = '#0d0d14';
    g.beginPath();
    g.moveTo(carX - 150, 960);
    g.lineTo(carX - 110, 900);
    g.lineTo(carX + 110, 900);
    g.lineTo(carX + 150, 960);
    g.closePath();
    g.fill();
    g.fillStyle = '#ff2d55';
    g.fillRect(carX - 140, 935, 70, 10);
    g.fillRect(carX + 70, 935, 70, 10);
    g.strokeStyle = '#3df0ff';
    g.lineWidth = 3;
    g.strokeRect(carX - 90, 908, 180, 24);

    // oyun arayüzü
    g.font = '700 46px "Segoe UI", sans-serif';
    g.fillStyle = '#ffffff';
    g.fillText('NEON RUN', 64, 96);
    g.font = '600 30px "Cascadia Mono", Consolas, monospace';
    g.fillStyle = '#3df0ff';
    g.fillText(`SKOR ${String(12480 + Math.floor(t * 137)).padStart(7, '0')}`, 64, 146);
    g.fillStyle = '#ffd36b';
    g.fillText(`${Math.round(212 + Math.sin(t) * 18)} km/s`, W - 270, 96);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fillRect(W - 270, 118, 206, 12);
    g.fillStyle = '#ff3d7f';
    g.fillRect(W - 270, 118, 206 * (0.62 + Math.sin(t * 0.7) * 0.2), 12);
  }

  // ------------------------------------------------------------ demo kamera
  const cam = document.createElement('canvas');
  cam.width = 640;
  cam.height = 480;
  const c = cam.getContext('2d');
  const logo = new Image();
  logo.src = 'assets/logo.svg';
  await logo.decode().catch(() => {});

  function drawCam() {
    const t = (performance.now() - t0) / 1000;
    const bg = c.createRadialGradient(320, 200, 40, 320, 240, 420);
    bg.addColorStop(0, '#2c3a4f');
    bg.addColorStop(1, '#0e141d');
    c.fillStyle = bg;
    c.fillRect(0, 0, 640, 480);
    const s = 300;
    c.drawImage(logo, 320 - s / 2, 245 - s / 2 + Math.sin(t * 2.2) * 8, s, s);
  }

  setInterval(() => {
    drawScene();
    drawCam();
  }, 1000 / 60);
  drawScene();
  drawCam();

  // ------------------------------------------------------------ bağla
  const { engine } = window.__tilki;
  const screenTrack = scene.captureStream(60).getVideoTracks()[0];
  const processor = new MediaStreamTrackProcessor({ track: screenTrack, maxBufferSize: 2 });
  engine.send('screen', { readable: processor.readable }, [processor.readable]);

  const id = engine.source ? engine.source.id : 'screen:demo';
  window.__tilki.setSources([{ id, name: 'Ekran', type: 'screen', thumbnail: scene.toDataURL('image/jpeg', 0.7) }]);

  engine.settings.camera = { ...engine.settings.camera, enabled: true, shape: 'circle', size: 0.27, x: 0.855, y: 0.755, mirror: false };
  engine.attachCamera(cam.captureStream(30));
  document.getElementById('camEnabled').checked = true;
  // Arayüz kendi durumunu yeniden çizse de kamera kartı açık görünsün.
  setInterval(() => {
    document.getElementById('camEnabled').checked = true;
    document.getElementById('camBody').hidden = false;
    document.getElementById('camMirror').checked = false;
  }, 50);
  // Gerçek kamera adını göstermemek için genel bir ad.
  const camSelect = document.getElementById('camDevice');
  camSelect.textContent = '';
  camSelect.append(new Option('HD Webcam', ''));
  return true;
})();
