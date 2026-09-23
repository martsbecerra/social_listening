// Mapa de reclamos: filtros (red, categoría, estado, barrio, comuna, fecha, texto)
// contra GET /api/reclamos, agrupado por dirección en el cliente. Leaflet CDN.
// Se refresca al cargar mapa.html.

const CABA_CENTER = [-34.6083, -58.4386];
const CABA_ZOOM = 12;
const CABA_MIN_ZOOM = 10;
const CLUSTER_FIT_MAX_ZOOM = 15;
// AMBA: limita el paneo para que no se pueda alejar a otro continente.
const AMBA_BOUNDS = [
  [-35.05, -58.9],
  [-34.2, -58.05],
];
const SEARCH_DEBOUNCE_MS = 350;

let claimsMap = null;
let claimsLayer = null;
let rawReclamos = [];
let allCategorias = [];
let allEstados = [];
let selectedCategorias = new Set();
let selectedEstados = new Set();
let categoriaMultiSelect = null;
let estadoMultiSelect = null;
let openFilterPanel = null;
let searchDebounceTimer = null;
let pinSteps = null;
// Árbol categoría -> subcategorías y conteo global, ambos del servidor.
let subcategoriasPorCategoria = {};
let conteoPorCategoria = {};
let allSubcategorias = [];
let selectedSubcategorias = new Set();
let subcategoriaMultiSelect = null;
let plataformaMultiSelect = null;
let allPlataformas = [];
let plataformaLabels = new Map();
let selectedPlataformas = new Set();

// -------------------------------------------------------------------------
// Colores por categoría
//
// Doce colores y no más: con 26 categorías no existen 26 tonos que el ojo
// separe de un vistazo. Pasando los diez, comparar dos pines se vuelve
// adivinanza. Entonces:
//   - Las 12 categorías más frecuentes DE TODA LA BASE se llevan un color fijo.
//     Fijo importa: si el ranking se recalculara con lo filtrado, los pines
//     cambiarían de color al mover un filtro y no se podría comparar nada.
//   - El resto va al gris, que además comunica "cola larga" mejor que un color
//     casi repetido.
//   - Excepción: si el filtro deja 12 o menos categorías seleccionadas, ahí sí
//     cada una toma color propio, porque ya no hay ambigüedad posible.
// -------------------------------------------------------------------------

const MAX_COLORES = 12;
const COLOR_OTRAS = '--cat-otras';
// Pin con reclamos de más de una categoría: negro, no el color de la más
// frecuente. El color dice "de qué es"; el negro, "acá hay cosas distintas".
const COLOR_VARIAS = '#111111';
const LABEL_VARIAS = 'Varias categorías';

/** categoría canónica -> nombre de la variable CSS con su color */
let paletaCategorias = new Map();

function rankingCategorias() {
  return Object.entries(conteoPorCategoria)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .map(([nombre]) => nombre);
}

/**
 * Recalcula qué categoría lleva qué color. Se llama al cargar datos y cada vez
 * que cambia la selección de categorías.
 */
function recalcularPaleta() {
  const conColorPropio =
    selectedCategorias.size > 0 && selectedCategorias.size <= MAX_COLORES
      ? [...selectedCategorias].sort((a, b) => a.localeCompare(b, 'es'))
      : rankingCategorias().slice(0, MAX_COLORES);

  paletaCategorias = new Map();
  conColorPropio.forEach((cat, i) => {
    paletaCategorias.set(cat, `--cat-${i + 1}`);
  });
}

function colorDeCategoria(categoria) {
  return cssVar(paletaCategorias.get(categoria) || COLOR_OTRAS);
}

function tieneColorPropio(categoria) {
  return paletaCategorias.has(categoria);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ensureClaimsMap() {
  if (claimsMap) return claimsMap;
  claimsMap = L.map('claims-map', {
    zoomControl: true,
    minZoom: CABA_MIN_ZOOM,
    maxBounds: AMBA_BOUNDS,
    maxBoundsViscosity: 1.0,
  }).setView(CABA_CENTER, CABA_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(claimsMap);
  claimsLayer = L.layerGroup().addTo(claimsMap);
  wireGlobalPopupHandlers();
  return claimsMap;
}

// -------------------------------------------------------------------------
// Filtros
// -------------------------------------------------------------------------

function etiquetaPlataforma(id) {
  return plataformaLabels.get(id) || id || 'Red';
}

function joinRedes(ids) {
  const labels = ids.map(etiquetaPlataforma);
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} y ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

function redesDelGrupo(group) {
  const present = new Set(group.reclamos.map((row) => row.plataforma).filter(Boolean));
  const ordered = allPlataformas.map((item) => item.id).filter((id) => present.has(id));
  for (const id of present) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

function currentFilters() {
  return {
    categoria: [...selectedCategorias],
    // Sólo se manda si el usuario recortó algo: con todas seleccionadas el
    // filtro no aporta y además dejaría afuera las filas con subcategoría
    // vacía, que son reclamos válidos.
    subcategoria:
      selectedSubcategorias.size > 0 && selectedSubcategorias.size < allSubcategorias.length
        ? [...selectedSubcategorias]
        : [],
    estado: [...selectedEstados],
    plataforma: [...selectedPlataformas],
    barrio: document.getElementById('claimsBarrio')?.value || '',
    comuna: document.getElementById('claimsComuna')?.value || '',
    desde: document.getElementById('claimsDesde')?.value || '',
    hasta: document.getElementById('claimsHasta')?.value || '',
    q: document.getElementById('claimsBuscar')?.value.trim() || '',
  };
}

function isDefaultFilters(f) {
  return (
    f.categoria.length === allCategorias.length &&
    f.subcategoria.length === 0 &&
    f.estado.length === allEstados.length &&
    f.plataforma.length === allPlataformas.length &&
    !f.barrio &&
    !f.comuna &&
    !f.desde &&
    !f.hasta &&
    !f.q
  );
}

function buildQueryString(f) {
  const params = new URLSearchParams();
  if (f.plataforma.length > 0 && f.plataforma.length < allPlataformas.length) {
    params.set('plataforma', f.plataforma.join(','));
  }
  if (f.categoria.length > 0 && f.categoria.length < allCategorias.length) {
    params.set('categoria', f.categoria.join(','));
  }
  // currentFilters ya devuelve [] cuando están todas seleccionadas.
  if (f.subcategoria.length > 0) {
    params.set('subcategoria', f.subcategoria.join(','));
  }
  if (f.estado.length > 0 && f.estado.length < allEstados.length) {
    params.set('estado', f.estado.join(','));
  }
  if (f.barrio) params.set('barrio', f.barrio);
  if (f.comuna) params.set('comuna', f.comuna);
  if (f.desde) params.set('desde', f.desde);
  if (f.hasta) params.set('hasta', f.hasta);
  if (f.q) params.set('q', f.q);
  return params.toString();
}

async function applyFiltersAndReload() {
  const errorEl = document.getElementById('claimsMapError');

  // La paleta se recalcula ANTES de pedir datos: si el filtro dejó 12 o menos
  // categorías, cada una pasa a tener color propio.
  recalcularPaleta();

  // "Ninguna" categoría/estado tildado: no hay nada que mostrar, no hace
  // falta pegarle al servidor.
  if (selectedCategorias.size === 0 || selectedEstados.size === 0 || selectedPlataformas.size === 0) {
    rawReclamos = [];
    renderMarkers();
    return;
  }

  try {
    const qs = buildQueryString(currentFilters());
    const resp = await fetch(`/api/reclamos?${qs}`);
    if (!resp.ok) throw new Error('No se pudieron cargar los reclamos.');
    const data = await resp.json();
    rawReclamos = Array.isArray(data.reclamos) ? data.reclamos : [];
    if (errorEl) {
      errorEl.classList.add('hidden');
      errorEl.textContent = '';
    }
    renderMarkers();
  } catch (err) {
    rawReclamos = [];
    renderMarkers();
    if (errorEl) {
      errorEl.textContent = err.message || 'No se pudieron cargar los reclamos.';
      errorEl.classList.remove('hidden');
    }
  }
}

function resetOtherFilters() {
  for (const id of ['claimsBarrio', 'claimsComuna', 'claimsDesde', 'claimsHasta', 'claimsBuscar']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
}

function populateBarrioComunaOptions(reclamos) {
  const barrios = [...new Set(reclamos.map((r) => r.barrio).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
  const comunas = [...new Set(reclamos.map((r) => r.comuna).filter((c) => c != null))].sort((a, b) => a - b);

  const barrioSel = document.getElementById('claimsBarrio');
  if (barrioSel) {
    barrioSel.innerHTML = '<option value="">Barrio</option>';
    for (const b of barrios) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      barrioSel.appendChild(opt);
    }
  }

  const comunaSel = document.getElementById('claimsComuna');
  if (comunaSel) {
    comunaSel.innerHTML = '<option value="">Comuna</option>';
    for (const c of comunas) {
      const opt = document.createElement('option');
      opt.value = String(c);
      opt.textContent = `Comuna ${c}`;
      comunaSel.appendChild(opt);
    }
  }
}

// -------------------------------------------------------------------------
// Multi-select desplegable (categoría / estado): botón cerrado con contador
// + panel flotante con checkboxes. Tildar filtra al instante, sin botón
// "Aplicar". Mismo mecanismo de apertura/cierre que el dropdown de usuario
// del header (main.js: toggle de .hidden + click afuera), más Escape.
// -------------------------------------------------------------------------

function closeOpenFilterPanel() {
  if (!openFilterPanel) return;
  openFilterPanel.panel.classList.add('hidden');
  openFilterPanel = null;
}

document.addEventListener('click', (e) => {
  if (!openFilterPanel) return;
  const { btn, panel } = openFilterPanel;
  if (!btn.contains(e.target) && !panel.contains(e.target)) closeOpenFilterPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOpenFilterPanel();
});

/**
 * @param {{ containerId: string, label: string, options: string[], selectedSet: Set<string>, labelFor?: (value: string) => string }} config
 * @returns {{ selectAll: () => void, selectNone: () => void }}
 */
function createFilterMultiSelect({ containerId, label, options, selectedSet, labelFor }) {
  const host = document.getElementById(containerId);
  if (!host) return { selectAll() {}, selectNone() {} };
  const textOf = labelFor || ((value) => value);
  host.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'claims-filter-select';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'claims-filter-select-btn';

  const panel = document.createElement('div');
  panel.className = 'claims-filter-select-panel hidden';

  const actions = document.createElement('div');
  actions.className = 'claims-filter-select-actions';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.textContent = 'Seleccionar todas';
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.textContent = 'Ninguna';
  actions.append(allBtn, noneBtn);
  panel.appendChild(actions);

  const checkboxes = new Map();
  for (const value of options) {
    const optLabel = document.createElement('label');
    optLabel.className = 'claims-filter-select-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedSet.has(value);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedSet.add(value);
      else selectedSet.delete(value);
      updateLabel();
      // Tocar categorías repuebla el filtro de subcategoría: es dependiente.
      if (containerId === 'claimsCategoriaSelect') rebuildSubcategoriaFilter();
      applyFiltersAndReload();
    });
    optLabel.append(checkbox, document.createTextNode(textOf(value)));
    panel.appendChild(optLabel);
    checkboxes.set(value, checkbox);
  }

  function updateLabel() {
    const n = selectedSet.size;
    btn.textContent = n > 0 && n < options.length ? `${label} (${n})` : label;
  }

  function syncCheckboxes() {
    checkboxes.forEach((cb, value) => {
      cb.checked = selectedSet.has(value);
    });
    updateLabel();
  }

  allBtn.addEventListener('click', () => {
    options.forEach((v) => selectedSet.add(v));
    syncCheckboxes();
    applyFiltersAndReload();
  });
  noneBtn.addEventListener('click', () => {
    selectedSet.clear();
    syncCheckboxes();
    applyFiltersAndReload();
  });

  btn.addEventListener('click', () => {
    const willOpen = panel.classList.contains('hidden');
    closeOpenFilterPanel();
    if (willOpen) {
      panel.classList.remove('hidden');
      openFilterPanel = { btn, panel };
    }
  });

  wrap.append(btn, panel);
  host.appendChild(wrap);
  updateLabel();

  return {
    selectAll() {
      options.forEach((v) => selectedSet.add(v));
      syncCheckboxes();
    },
    selectNone() {
      selectedSet.clear();
      syncCheckboxes();
    },
  };
}

// -------------------------------------------------------------------------
// Agrupado + pines
// -------------------------------------------------------------------------

function hasMapLocation(row) {
  return row.x != null && row.y != null && Boolean(row.direccionNormalizada);
}

function clusterVisible() {
  const groups = new Map();
  for (const row of rawReclamos) {
    if (!hasMapLocation(row)) continue;
    const key = row.direccionNormalizada;
    if (!groups.has(key)) {
      groups.set(key, { address: key, lat: row.y, lng: row.x, reclamos: [] });
    }
    groups.get(key).reclamos.push(row);
  }
  const lista = [...groups.values()];
  // Categoría con la que se pinta el pin: la más frecuente del punto. El
  // desempate por nombre mantiene el color estable entre renders. Si el punto
  // mezcla categorías distintas, el pin va negro (esMixto): el color dice "de
  // qué es" y el negro dice "acá hay cosas distintas".
  for (const g of lista) {
    const counts = categoriaCounts(g.reclamos);
    g.categoriaDominante = counts[0][0];
    g.esMixto = counts.length > 1;
  }
  return lista;
}

function categoriaCounts(reclamos) {
  const counts = new Map();
  for (const row of reclamos) counts.set(row.categoria, (counts.get(row.categoria) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

/**
 * Leyenda de las categorías presentes en la vista actual, no de las 26.
 * Mostrar categorías que no están en pantalla sería ruido, y ocultar las que
 * sí están dejaría pines sin explicar.
 */
function renderLeyenda(groups) {
  const cont = document.getElementById('claimsLeyenda');
  if (!cont) return;
  cont.innerHTML = '';

  const presentes = new Map();
  for (const g of groups) {
    for (const [cat, n] of categoriaCounts(g.reclamos)) {
      presentes.set(cat, (presentes.get(cat) || 0) + n);
    }
  }
  if (presentes.size === 0) return;

  const ordenadas = [...presentes.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')
  );

  let hayGrises = false;
  for (const [cat, n] of ordenadas) {
    if (!tieneColorPropio(cat)) hayGrises = true;
    const item = document.createElement('span');
    item.className = 'claims-leyenda-item';

    const punto = document.createElement('span');
    punto.className = 'claims-leyenda-punto';
    punto.style.background = colorDeCategoria(cat);

    const nombre = document.createElement('span');
    nombre.textContent = cat;

    const cuenta = document.createElement('span');
    cuenta.className = 'claims-leyenda-n';
    cuenta.textContent = `(${n})`;

    item.append(punto, nombre, cuenta);
    cont.appendChild(item);
  }

  // El negro de los pines mixtos sólo se explica si hay al menos uno en la
  // vista actual; la cuenta es de PUNTOS (pines), no de reclamos.
  const puntosMixtos = groups.filter((g) => g.esMixto).length;
  if (puntosMixtos > 0) {
    const item = document.createElement('span');
    item.className = 'claims-leyenda-item';

    const punto = document.createElement('span');
    punto.className = 'claims-leyenda-punto';
    punto.style.background = COLOR_VARIAS;

    const nombre = document.createElement('span');
    nombre.textContent = LABEL_VARIAS;

    const cuenta = document.createElement('span');
    cuenta.className = 'claims-leyenda-n';
    cuenta.textContent = `(${puntosMixtos})`;

    item.append(punto, nombre, cuenta);
    cont.appendChild(item);
  }

  if (hayGrises) {
    const nota = document.createElement('span');
    nota.className = 'claims-leyenda-nota';
    nota.textContent =
      `En gris, las categorías fuera de las ${MAX_COLORES} más frecuentes. ` +
      'Filtrá a 12 o menos para que cada una tome su propio color.';
    cont.appendChild(nota);
  }
}

function tooltipHtml(group) {
  const lines = categoriaCounts(group.reclamos)
    .map(([name, n]) => `${escapeHtml(name)} (${n})`)
    .join('<br>');
  return `<strong>${escapeHtml(group.address)}</strong><br>${group.reclamos.length} reclamo(s)<br>${lines}`;
}

function estadoSelectHtml(reclamo) {
  const options = allEstados
    .map(
      (e) =>
        `<option value="${escapeHtml(e)}"${e === reclamo.estado ? ' selected' : ''}>${escapeHtml(e)}</option>`
    )
    .join('');
  return `<select class="claims-popup-estado" data-id="${escapeHtml(reclamo.id)}">${options}</select>`;
}

function popupHtml(group) {
  // Desglose por categoría del punto. El pin sólo puede mostrar un color (el de
  // la categoría dominante), así que acá va la composición completa — si no, un
  // punto con 3 categorías se leería como si fuera de una sola.
  const cuentas = categoriaCounts(group.reclamos);
  const desglose =
    cuentas.length > 1
      ? `<div class="claims-popup-desglose">${cuentas
          .map(
            ([cat, n]) =>
              `<span class="claims-leyenda-item"><span class="claims-leyenda-punto" style="background:${colorDeCategoria(
                cat
              )}"></span>${escapeHtml(cat)} <span class="claims-leyenda-n">(${n})</span></span>`
          )
          .join('')}</div>`
      : '';

  const aproximado = group.reclamos.every((r) => r.precision === 'aproximada');
  const avisoPrecision = aproximado
    ? '<div class="claims-popup-nota">Ubicación aproximada: es un lugar con nombre, no una altura exacta.</div>'
    : '';

  const redes = redesDelGrupo(group);
  const resumenRedes =
    redes.length > 1 ? `<p class="claims-popup-redes">${escapeHtml(joinRedes(redes))}</p>` : '';

  const items = group.reclamos
    .map((r) => {
      const user = escapeHtml(r.autor || 'desconocido');
      const comment = escapeHtml(r.textoOriginal || '');
      const url = r.postUrl || r.commentUrl || '#';
      const sub = r.subcategoria
        ? `<div class="claims-popup-sub">${escapeHtml(r.subcategoria)}</div>`
        : '';
      return `<div class="claims-popup-item">
        <div class="claims-popup-user">@${user} · ${escapeHtml(etiquetaPlataforma(r.plataforma))} · <span class="claims-tema-pill" style="background:${colorDeCategoria(
          r.categoria
        )};color:#fff">${escapeHtml(r.categoria)}</span></div>
        ${sub}
        <div class="claims-popup-comment">${comment}</div>
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Ver posteo</a>
        ${estadoSelectHtml(r)}
      </div>`;
    })
    .join('');
  return `<div class="claims-popup"><h2>${escapeHtml(group.address)}</h2>${resumenRedes}${desglose}${avisoPrecision}${items}</div>`;
}

function getPinSteps() {
  if (pinSteps) return pinSteps;
  pinSteps = [
    { min: 1, bg: cssVar('--jade-150'), text: cssVar('--jade-950') },
    { min: 2, bg: cssVar('--jade-300'), text: cssVar('--jade-950') },
    { min: 4, bg: cssVar('--jade-400'), text: '#ffffff' },
    { min: 7, bg: cssVar('--jade-500'), text: '#ffffff' },
    { min: 12, bg: cssVar('--jade-700'), text: '#ffffff' },
    { min: 20, bg: cssVar('--jade-900'), text: '#ffffff' },
  ];
  return pinSteps;
}

function pinTheme(count) {
  const steps = getPinSteps();
  let chosen = steps[0];
  for (const step of steps) {
    if (count >= step.min) chosen = step;
  }
  return chosen;
}

function pinDiameter(count) {
  const n = Math.max(1, Number(count) || 1);
  if (n === 1) return 26;
  return Math.min(80, Math.round(26 + 10 * Math.sqrt(n - 1) + 6 * (n - 1)));
}

function setEmptyState(isEmpty, filtered) {
  const empty = document.getElementById('claimsMapEmpty');
  const mapEl = document.getElementById('claims-map');
  const title = document.getElementById('claimsMapEmptyTitle');
  const text = document.getElementById('claimsMapEmptyText');
  if (empty) empty.classList.toggle('hidden', !isEmpty);
  if (mapEl) mapEl.classList.toggle('is-empty', isEmpty);
  if (!isEmpty || !title || !text) return;
  if (selectedPlataformas.size === 0) {
    title.textContent = 'Ninguna red activa';
    text.textContent = 'Activá al menos una red para ver reclamos.';
    return;
  }
  if (filtered) {
    title.textContent = 'Ningún reclamo coincide con los filtros';
    text.textContent = 'Probá ampliar el rango de fechas o tildar más categorías/estados.';
  } else {
    title.textContent = title.dataset.defaultTitle || 'Todavía no hay reclamos ubicados';
    text.textContent =
      text.dataset.defaultText ||
      'Cuando el análisis detecte comentarios con una dirección, van a aparecer acá.';
  }
}

function updateClearButtonState() {
  const btn = document.getElementById('claimsClearBtn');
  if (btn) btn.disabled = isDefaultFilters(currentFilters());
}

function renderMarkers() {
  if (!claimsLayer || !claimsMap) return;
  claimsLayer.clearLayers();
  const groups = clusterVisible();
  const filtered = !isDefaultFilters(currentFilters());
  setEmptyState(groups.length === 0, filtered);
  updateClearButtonState();

  for (const group of groups) {
    const count = group.reclamos.length;
    const diameter = pinDiameter(count);
    const radius = diameter / 2;

    // Un pin agrupa varios reclamos de la MISMA dirección. Si todos son de la
    // misma categoría lleva su color (sin importar cuántos sean); si mezcla
    // categorías va NEGRO — el desglose completo está en el popup. El borde
    // negro fino lo pone el CSS (.claims-pin), para todos por igual.
    const color = group.esMixto ? COLOR_VARIAS : colorDeCategoria(group.categoriaDominante);
    // Blanco sobre estos tonos: todos son medios u oscuros, ninguno claro.
    const texto = '#ffffff';
    // Si TODOS los reclamos del punto son aproximados, el pin va punteado. Con
    // uno solo exacto ya hay una ubicación precisa ahí y el pin va sólido.
    const aproximado = group.reclamos.every((r) => r.precision === 'aproximada');

    const icon = L.divIcon({
      className: 'claims-pin-wrap',
      iconSize: [diameter, diameter],
      iconAnchor: [radius, radius],
      html:
        `<div class="claims-pin${aproximado ? ' is-aproximada' : ''}" ` +
        `style="width:${diameter}px;height:${diameter}px;background:${color};color:${texto};` +
        `font-size:${diameter >= 48 ? 15 : diameter >= 36 ? 13 : 11}px">${count}</div>`,
    });
    const marker = L.marker([group.lat, group.lng], { icon });
    marker.bindTooltip(tooltipHtml(group), { sticky: true, opacity: 0.95 });
    marker.bindPopup(popupHtml(group), { maxWidth: 360, maxHeight: 340 });
    claimsLayer.addLayer(marker);
  }

  renderLeyenda(groups);

  if (groups.length > 0) {
    const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lng]));
    claimsMap.fitBounds(bounds, { padding: [24, 24], maxZoom: CLUSTER_FIT_MAX_ZOOM });
  } else {
    claimsMap.setView(CABA_CENTER, CABA_ZOOM);
  }
}

// -------------------------------------------------------------------------
// Estado editable desde el popup (PATCH /api/reclamos/:id)
// -------------------------------------------------------------------------

function wireGlobalPopupHandlers() {
  claimsMap.on('popupopen', (e) => {
    const root = e.popup.getElement();
    if (!root) return;
    root.querySelectorAll('.claims-popup-estado').forEach((select) => {
      select.dataset.previous = select.value;
      select.addEventListener('change', async () => {
        const id = select.dataset.id;
        const nuevoEstado = select.value;
        const previous = select.dataset.previous;
        select.disabled = true;
        try {
          const resp = await fetch(`/api/reclamos/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: nuevoEstado }),
          });
          if (!resp.ok) throw new Error('No se pudo actualizar el estado.');
          const row = rawReclamos.find((r) => r.id === id);
          if (row) row.estado = nuevoEstado;
          select.dataset.previous = nuevoEstado;
        } catch (err) {
          select.value = previous;
          window.alert(err.message || 'No se pudo actualizar el estado.');
        } finally {
          select.disabled = false;
        }
      });
    });
  });
}

// -------------------------------------------------------------------------
// Carga inicial
// -------------------------------------------------------------------------

/**
 * El filtro de subcategoría depende del de categoría: se puebla sólo con las
 * subcategorías de las categorías seleccionadas. Con las 26 marcadas serían 85
 * opciones, una lista imposible de usar; y ofrecer subcategorías de categorías
 * que el usuario filtró afuera devolvería siempre cero resultados.
 *
 * Se llama al cargar y cada vez que cambia la selección de categorías.
 */
function rebuildSubcategoriaFilter() {
  const cats = selectedCategorias.size > 0 ? [...selectedCategorias] : allCategorias;

  const subs = new Set();
  for (const c of cats) {
    for (const s of subcategoriasPorCategoria[c] || []) subs.add(s);
  }
  allSubcategorias = [...subs].sort((a, b) => a.localeCompare(b, 'es'));

  // Se conserva lo que el usuario ya había elegido y sigue siendo válido; el
  // resto se descarta solo, sin dejar un filtro activo invisible.
  const previas = [...selectedSubcategorias].filter((s) => subs.has(s));
  selectedSubcategorias = new Set(previas.length > 0 ? previas : allSubcategorias);

  subcategoriaMultiSelect = createFilterMultiSelect({
    containerId: 'claimsSubcategoriaSelect',
    label: 'Subcategoría',
    options: allSubcategorias,
    selectedSet: selectedSubcategorias,
  });
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

    allCategorias = Array.isArray(data.categorias) ? data.categorias : [];
    allEstados = Array.isArray(data.estados) ? data.estados : [];
    allPlataformas = Array.isArray(data.plataformas) ? data.plataformas : [];
    plataformaLabels = new Map(allPlataformas.map((item) => [item.id, item.label]));
    subcategoriasPorCategoria = data.subcategoriasPorCategoria || {};
    conteoPorCategoria = data.conteoPorCategoria || {};
    selectedCategorias = new Set(allCategorias);
    selectedEstados = new Set(allEstados);
    selectedPlataformas = new Set(allPlataformas.map((item) => item.id));
    rawReclamos = Array.isArray(data.reclamos) ? data.reclamos : [];

    recalcularPaleta();

    closeOpenFilterPanel();
    plataformaMultiSelect = createFilterMultiSelect({
      containerId: 'claimsPlataformaSelect',
      label: 'Red',
      options: allPlataformas.map((item) => item.id),
      selectedSet: selectedPlataformas,
      labelFor: etiquetaPlataforma,
    });
    categoriaMultiSelect = createFilterMultiSelect({
      containerId: 'claimsCategoriaSelect',
      label: 'Categoría',
      options: allCategorias,
      selectedSet: selectedCategorias,
    });
    estadoMultiSelect = createFilterMultiSelect({
      containerId: 'claimsEstadoSelect',
      label: 'Estado',
      options: allEstados,
      selectedSet: selectedEstados,
    });
    rebuildSubcategoriaFilter();
    populateBarrioComunaOptions(rawReclamos);
    resetOtherFilters();

    ensureClaimsMap();
    claimsMap.invalidateSize();
    renderMarkers();
  } catch (err) {
    rawReclamos = [];
    setEmptyState(true, false);
    if (errorEl) {
      errorEl.textContent = err.message || 'No se pudieron cargar los reclamos.';
      errorEl.classList.remove('hidden');
    }
  }
}

window.refreshClaimsMap = refreshClaimsMap;

if (document.getElementById('claims-map') && !document.querySelector('.tab-btn[data-tab="claims-map"]')) {
  refreshClaimsMap();
}

for (const id of ['claimsBarrio', 'claimsComuna', 'claimsDesde', 'claimsHasta']) {
  document.getElementById(id)?.addEventListener('change', () => applyFiltersAndReload());
}
document.getElementById('claimsBuscar')?.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => applyFiltersAndReload(), SEARCH_DEBOUNCE_MS);
});
document.getElementById('claimsClearBtn')?.addEventListener('click', () => {
  plataformaMultiSelect?.selectAll();
  categoriaMultiSelect?.selectAll();
  estadoMultiSelect?.selectAll();
  rebuildSubcategoriaFilter();
  subcategoriaMultiSelect?.selectAll();
  resetOtherFilters();
  applyFiltersAndReload();
});
