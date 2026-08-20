// Mapa de reclamos: fetch crudo, agrega en el cliente, Leaflet CDN.
// Se refresca cada vez que se entra a la solapa (main.js).

const CABA_CENTER = [-34.6037, -58.3816];
const CABA_ZOOM = 12;
// Negro reservado para ubicaciones con más de una temática (nunca para un tema).
const MIXED_PIN = { fill: '#000000', border: '#ffffff', text: '#ffffff' };

// Pares fondo/texto curados (WCAG AA ≥ 4.5:1). Negro reservado para MIXED_PIN.
const TEMATICA_THEMES = {
  bache: { bg: '#B45309', text: '#FFFFFF' },
  'poda de árboles': { bg: '#15803D', text: '#FFFFFF' },
  alumbrado: { bg: '#A16207', text: '#FFFFFF' },
  basura: { bg: '#57534E', text: '#FFFFFF' },
  inseguridad: { bg: '#DC2626', text: '#FFFFFF' },
  'semáforo roto': { bg: '#6D28D9', text: '#FFFFFF' },
  'ruidos molestos': { bg: '#A21CAF', text: '#FFFFFF' },
  'corte de luz': { bg: '#334155', text: '#F8FAFC' },
  agua: { bg: '#0369A1', text: '#FFFFFF' },
  transporte: { bg: '#4338CA', text: '#FFFFFF' },
  limpieza: { bg: '#0F766E', text: '#FFFFFF' },
  veredas: { bg: '#3F6212', text: '#FFFFFF' },
  inundación: { bg: '#0E7490', text: '#FFFFFF' },
  salud: { bg: '#BE123C', text: '#FFFFFF' },
  educación: { bg: '#1E40AF', text: '#FFFFFF' },
  estacionamiento: { bg: '#C2410C', text: '#FFFFFF' },
  otro: { bg: '#475569', text: '#FFFFFF' },
};

let claimsMap = null;
let claimsLayer = null;
let rawReclamos = [];
let allTematicas = [];
let selectedTematicas = new Set();

function hslToHex(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const chroma = sat * Math.min(light, 1 - light);
  const hueChannel = (n) => {
    const k = (n + h / 30) % 12;
    const mix = light - chroma * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * mix)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${hueChannel(0)}${hueChannel(8)}${hueChannel(4)}`;
}

function hashTemaColor(name) {
  const key = String(name || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(31, hash) + key.charCodeAt(i);
  }
  return hslToHex(Math.abs(hash) % 360, 58, 46);
}

function temaTheme(name) {
  const known = TEMATICA_THEMES[name];
  if (known) return known;
  const bg = hashTemaColor(name);
  return { bg, text: contrastingText(bg) };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureClaimsMap() {
  if (claimsMap) return claimsMap;
  claimsMap = L.map('claims-map', { zoomControl: true }).setView(CABA_CENTER, CABA_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(claimsMap);
  claimsLayer = L.layerGroup().addTo(claimsMap);
  return claimsMap;
}

function syncChipSelectedState() {
  document.querySelectorAll('#claimsMapChips .claims-chip').forEach((btn) => {
    btn.classList.toggle('is-selected', selectedTematicas.has(btn.dataset.tematica));
  });
}

function setAllTematicas(on) {
  selectedTematicas = on ? new Set(allTematicas) : new Set();
  syncChipSelectedState();
  renderMarkers();
}

function hasMapLocation(row) {
  return row.lat != null && row.lng != null && Boolean(row.direccionNormalizada);
}

function countReclamosByTematica() {
  const counts = new Map(allTematicas.map((t) => [t, 0]));
  for (const row of rawReclamos) {
    if (!hasMapLocation(row)) continue;
    counts.set(row.tematica, (counts.get(row.tematica) || 0) + 1);
  }
  return counts;
}

function tematicasOnMap(reclamos) {
  const names = new Set();
  for (const row of reclamos) {
    if (hasMapLocation(row) && row.tematica) names.add(row.tematica);
  }
  return [...names].sort((a, b) => {
    if (a === 'otro') return 1;
    if (b === 'otro') return -1;
    return a.localeCompare(b, 'es');
  });
}

function renderChips(tematicas) {
  const host = document.getElementById('claimsMapChips');
  if (!host) return;
  allTematicas = tematicas;
  selectedTematicas = new Set(tematicas);
  const totals = countReclamosByTematica();
  const allBtn = document.getElementById('claimsSelectAllBtn');
  if (allBtn) {
    const total = [...totals.values()].reduce((sum, n) => sum + n, 0);
    allBtn.innerHTML = `Todas <span class="claims-chip-count">(${total})</span>`;
  }
  host.innerHTML = '';
  for (const tematica of tematicas) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'claims-chip is-selected';
    btn.dataset.tematica = tematica;
    const theme = temaTheme(tematica);
    btn.style.background = theme.bg;
    btn.style.borderColor = theme.bg;
    btn.style.color = theme.text;
    const count = totals.get(tematica) || 0;
    btn.innerHTML = `${escapeHtml(tematica)} <span class="claims-chip-count">(${count})</span>`;
    btn.addEventListener('click', () => {
      if (selectedTematicas.has(tematica)) selectedTematicas.delete(tematica);
      else selectedTematicas.add(tematica);
      btn.classList.toggle('is-selected', selectedTematicas.has(tematica));
      renderMarkers();
    });
    host.appendChild(btn);
  }
}

function clusterVisible() {
  const groups = new Map();
  for (const row of rawReclamos) {
    if (!hasMapLocation(row)) continue;
    if (!selectedTematicas.has(row.tematica)) continue;
    const key = row.direccionNormalizada;
    if (!groups.has(key)) {
      groups.set(key, {
        address: key,
        lat: row.lat,
        lng: row.lng,
        reclamos: [],
      });
    }
    groups.get(key).reclamos.push(row);
  }
  return [...groups.values()];
}

function tematicaCounts(reclamos) {
  const counts = new Map();
  for (const row of reclamos) {
    counts.set(row.tematica, (counts.get(row.tematica) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function temaPill(label, count, bg, text) {
  return `<span class="claims-tema-pill" style="background:${bg};color:${text}">${escapeHtml(label)} <span class="claims-chip-count">(${count})</span></span>`;
}

function tooltipHtml(group) {
  const total = temaPill('Total', group.reclamos.length, MIXED_PIN.fill, MIXED_PIN.text);
  const lines = tematicaCounts(group.reclamos)
    .map(([name, n]) => {
      const theme = temaTheme(name);
      return temaPill(name, n, theme.bg, theme.text);
    })
    .join('<br>');
  return `${escapeHtml(group.address)}<br>${total}<br>${lines}`;
}

function popupHtml(group) {
  const byTheme = new Map();
  for (const row of group.reclamos) {
    if (!byTheme.has(row.tematica)) byTheme.set(row.tematica, []);
    byTheme.get(row.tematica).push(row);
  }
  const sections = [...byTheme.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tematica, rows]) => {
      const items = rows
        .map((row) => {
          const user = escapeHtml(row.username || 'desconocido');
          const comment = escapeHtml(row.commentText || '');
          const url = row.postUrl || '#';
          return `<div class="claims-popup-item"><div class="claims-popup-user">@${user}</div><div class="claims-popup-comment">${comment}</div><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Ver posteo</a></div>`;
        })
        .join('');
      const theme = temaTheme(tematica);
      return `<h3 class="claims-tema-pill" style="background:${theme.bg};color:${theme.text}">${escapeHtml(tematica)}</h3>${items}`;
    })
    .join('');
  return `<div class="claims-popup"><h2>${escapeHtml(group.address)}</h2>${sections}</div>`;
}

function contrastingText(hex) {
  const raw = String(hex || '').replace('#', '');
  if (raw.length < 6) return '#0f172a';
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#0f172a' : '#f8fafc';
}

function setEmptyState(isEmpty) {
  const empty = document.getElementById('claimsMapEmpty');
  const mapEl = document.getElementById('claims-map');
  if (empty) empty.classList.toggle('hidden', !isEmpty);
  if (mapEl) mapEl.classList.toggle('is-empty', isEmpty);
}

function pinDiameter(count) {
  const n = Math.max(1, Number(count) || 1);
  if (n === 1) return 26;
  return Math.min(80, Math.round(26 + 10 * Math.sqrt(n - 1) + 6 * (n - 1)));
}

function renderMarkers() {
  if (!claimsLayer || !claimsMap) return;
  claimsLayer.clearLayers();
  const groups = clusterVisible();
  setEmptyState(groups.length === 0);

  for (const group of groups) {
    const count = group.reclamos.length;
    const diameter = pinDiameter(count);
    const radius = diameter / 2;
    const uniqueTemas = [...new Set(group.reclamos.map((r) => r.tematica))];
    const mixed = uniqueTemas.length > 1;
    const theme = mixed ? MIXED_PIN : temaTheme(uniqueTemas[0]);
    const fill = theme.fill || theme.bg;
    const border = mixed ? MIXED_PIN.border : '#000';
    const text = theme.text;
    const icon = L.divIcon({
      className: 'claims-pin-wrap',
      iconSize: [diameter, diameter],
      iconAnchor: [radius, radius],
      html: `<div class="claims-pin" style="width:${diameter}px;height:${diameter}px;background:${fill};border-color:${border};color:${text};font-size:${diameter >= 48 ? 15 : diameter >= 36 ? 13 : 11}px">${count}</div>`,
    });
    const marker = L.marker([group.lat, group.lng], { icon });
    marker.bindTooltip(tooltipHtml(group), { sticky: true, opacity: 0.95 });
    marker.bindPopup(popupHtml(group), { maxWidth: 360, maxHeight: 320 });
    claimsLayer.addLayer(marker);
  }

  claimsMap.setView(CABA_CENTER, CABA_ZOOM);
  if (groups.length > 0) {
    const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lng]));
    claimsMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }
}

async function refreshClaimsMap() {
  const errorEl = document.getElementById('claimsMapError');
  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  try {
    const resp = await fetch('/api/reclamos');
    if (!resp.ok) throw new Error('No se pudieron cargar los reclamos.');
    const data = await resp.json();
    rawReclamos = Array.isArray(data.reclamos) ? data.reclamos : [];
    renderChips(tematicasOnMap(rawReclamos));
    ensureClaimsMap();
    claimsMap.invalidateSize();
    renderMarkers();
  } catch (err) {
    rawReclamos = [];
    setEmptyState(true);
    if (errorEl) {
      errorEl.textContent = err.message || 'No se pudieron cargar los reclamos.';
      errorEl.classList.remove('hidden');
    }
  }
}

window.refreshClaimsMap = refreshClaimsMap;

document.getElementById('claimsSelectAllBtn')?.addEventListener('click', () => {
  setAllTematicas(true);
});
document.getElementById('claimsSelectNoneBtn')?.addEventListener('click', () => {
  setAllTematicas(false);
});
