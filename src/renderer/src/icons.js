// Satır içi SVG ikonlar (24×24, çizgi tabanlı).
const stroke = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const solid = (body) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;

const ICONS = {
  studio: stroke('<rect x="2" y="5" width="14" height="14" rx="3"/><path d="M16 10.2l6-3.4v10.4l-6-3.4"/>'),
  library: stroke('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7.5 3v18M16.5 3v18M3 8h4.5M3 16h4.5M16.5 8H21M16.5 16H21M7.5 12h9"/>'),
  settings: stroke('<path d="M4 6h9M19 6h1M4 12h1M11 12h9M4 18h7M17 18h3"/><circle cx="16" cy="6" r="2.4"/><circle cx="8" cy="12" r="2.4"/><circle cx="14" cy="18" r="2.4"/>'),
  monitor: stroke('<rect x="2" y="3.5" width="20" height="13.5" rx="2.5"/><path d="M8 21h8M12 17v4"/>'),
  window: stroke('<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M2 9h20M5.5 6.6h.01M8.5 6.6h.01"/>'),
  camera: stroke('<circle cx="12" cy="10" r="7.2"/><circle cx="12" cy="10" r="2.6"/><path d="M7 21.5h10M12 17.2v4.3"/>'),
  mic: stroke('<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3"/>'),
  'mic-off': stroke('<path d="M9 9.5v2a3 3 0 0 0 4.6 2.5M15 10.5v-5a3 3 0 0 0-5.7-1.3"/><path d="M5 11.5a7 7 0 0 0 11.2 5.6M19 11.5a7 7 0 0 1-.5 2.6M12 18.5v3M3 3l18 18"/>'),
  volume: stroke('<path d="M11 5L6.2 9H3v6h3.2L11 19z"/><path d="M15.2 8.8a4.6 4.6 0 0 1 0 6.4M18.2 6a8.6 8.6 0 0 1 0 12"/>'),
  'volume-off': stroke('<path d="M11 5L6.2 9H3v6h3.2L11 19z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  crop: stroke('<path d="M6.5 2v13a2.5 2.5 0 0 0 2.5 2.5h13M2 6.5h13A2.5 2.5 0 0 1 17.5 9v13"/>'),
  folder: stroke('<path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.7l2.2 2.6h7.7A2.2 2.2 0 0 1 21 9.8v7.5a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.3z"/>'),
  image: stroke('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.8" cy="9.6" r="1.6"/><path d="M21 15.5l-4.6-4.6L7 20"/>'),
  replay: stroke('<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3.5 3.8v4.7h4.7"/><path d="M12 8v4.2l2.6 1.8"/>'),
  pause: solid('<rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/>'),
  play: solid('<path d="M8 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L9.2 4.1A.8.8 0 0 0 8 4.8z"/>'),
  trash: stroke('<path d="M4 7h16M10 11v6M14 11v6M6 7l.9 11.2A2 2 0 0 0 8.9 20h6.2a2 2 0 0 0 2-1.8L18 7M9 7V4.5h6V7"/>'),
  x: stroke('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: stroke('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  refresh: stroke('<path d="M20 11a8 8 0 0 0-14.4-4.2L4 8.6M4 4v4.6h4.6M4 13a8 8 0 0 0 14.4 4.2L20 15.4M20 20v-4.6h-4.6"/>'),
  download: stroke('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
  keyboard: stroke('<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  globe: stroke('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  info: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>'),
  external: stroke('<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  chip: stroke('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>'),
};

export function icon(name) {
  return ICONS[name] || '';
}

export function applyIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon);
    el.classList.add('icon');
  }
}
