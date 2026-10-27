// Mapa de reclamos: filtros (categoría, subcategoría, barrio, comuna, fecha,
// texto) contra GET /api/reclamos, agrupado por dirección en el cliente.
// Leaflet CDN. Se refresca cada vez que se entra a la solapa (main.js).
// Desde la fase G el estado de los reclamos (Pendiente, En tratamiento…) no
// se muestra ni se edita acá (decisión del dueño); la columna y la API
// (PATCH /api/reclamos/:id) siguen como estaban.
// Fase H (openspec/changes/geo-pro): el pin según la precisión (dirección o
// cruce, sólido; lugar con nombre, con halo; villa, con halo grande), la
// vista "Por comunas" (GET /api/geo/comunas: los ubicados más las menciones
// de solo un barrio), el filtro "Precisión" y la tarjeta "Sin ubicar" por
// motivo, con "Corregir dirección" (POST /api/reclamos/:id/corregir) y
// "Descartar". Todo dato entra por textContent; los textos de la precisión
// y los motivos vienen del servidor (src/geo/etiquetas.js), los mismos del CSV.

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

function currentPlatform() {
  return document.body?.dataset?.platform === 'x' ? 'x' : 'instagram';
}

let claimsMap = null;
let claimsLayer = null;
let rawReclamos = [];
let claimsPedido = 0; // el número del último pedido de /api/reclamos
let allCategorias = [];
let selectedCategorias = new Set();
let categoriaMultiSelect = null;
let openFilterPanel = null;
let searchDebounceTimer = null;
// Árbol categoría -> subcategorías y conteo global, ambos del servidor.
let subcategoriasPorCategoria = {};
let conteoPorCategoria = {};
let allSubcategorias = [];
let selectedSubcategorias = new Set();
let subcategoriaMultiSelect = null;
// Fase H: la precisión, sus textos y la vista.
const PRECISIONES = ['puntual', 'cruce', 'lugar', 'area', 'ninguna'];
let selectedPrecisiones = new Set(PRECISIONES);
let precisionMultiSelect = null;
let etiquetas = {
  PRECISION: { puntual: 'Dirección exacta', cruce: 'Cruce de calles', lugar: 'Lugar con nombre · ubicación aproximada', area: 'Villa o asentamiento · ubicación del área', ninguna: 'Sin punto' },
  MOTIVO: {},
  TIPO: {},
};
let vistaMapa = 'puntos'; // 'puntos' | 'comunas'
let comunasGeo = null; // el GeoJSON de las comunas (se pide una vez)
let comunasLayer = null;
let comunaElegida = null;

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

// -------------------------------------------------------------------------
// Mosaicos (fase G, decisión del dueño): los de Google, como el panel de El
// Niño, con el selector Mapa / Satélite (recordado en sl.mapa.capa),
// aceptando el riesgo de usarlos sin su API. Respaldo automático: si los de
// Google no cargan (TILE_FALLAS_RESPALDO fallas antes de que llegue uno
// bueno, o más fallas que buenos después), el mapa pasa solo a
// OpenStreetMap, lo dice en el selector y lo deja apagado.
// -------------------------------------------------------------------------

const TILES_GOOGLE = {
  mapa: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
  satelite: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
};
const TILES_OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_FALLAS_RESPALDO = 4;
const CAPA_KEY = 'sl.mapa.capa';

let capaActual = null; // la tileLayer a la vista
let capaElegida = 'mapa'; // 'mapa' | 'satelite'
let enRespaldo = false; // Google no cargó: OpenStreetMap
let capaControl = null; // el contenedor del selector

function leerCapa() {
  try {
    return localStorage.getItem(CAPA_KEY) === 'satelite' ? 'satelite' : 'mapa';
  } catch {
    return 'mapa';
  }
}

function guardarCapa(capa) {
  try {
    localStorage.setItem(CAPA_KEY, capa);
  } catch {
    /* sin almacenamiento: vale para esta visita */
  }
}

function ponerCapa(capa) {
  if (capaActual) claimsMap.removeLayer(capaActual);
  if (enRespaldo) {
    capaActual = L.tileLayer(TILES_OSM, { attribution: '&copy; OpenStreetMap', maxZoom: 19 });
  } else {
    capaActual = L.tileLayer(TILES_GOOGLE[capa], { subdomains: ['0', '1', '2', '3'], attribution: 'Mapa &copy; Google', maxZoom: 20 });
    // El respaldo: se cuentan los mosaicos buenos y los que fallan de esta capa.
    let buenos = 0;
    let fallas = 0;
    const esta = capaActual;
    esta.on('tileload', () => {
      buenos += 1;
    });
    esta.on('tileerror', () => {
      fallas += 1;
      if (capaActual !== esta || enRespaldo) return;
      if ((buenos === 0 && fallas >= TILE_FALLAS_RESPALDO) || (fallas >= TILE_FALLAS_RESPALDO * 3 && fallas > buenos)) pasarARespaldo();
    });
  }
  capaActual.addTo(claimsMap);
  capaActual.bringToBack();
  pintarSelectorCapa();
}

function pasarARespaldo() {
  enRespaldo = true;
  console.warn('[mapa] los mosaicos de Google no cargan: el mapa pasa a OpenStreetMap');
  ponerCapa(capaElegida);
}

function pintarSelectorCapa() {
  if (!capaControl) return;
  capaControl.querySelectorAll('button[data-capa]').forEach((b) => {
    const on = !enRespaldo && b.dataset.capa === capaElegida;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    // aria-disabled, no disabled: sigue con el foco y dice por qué.
    b.setAttribute('aria-disabled', String(enRespaldo));
  });
  const nota = capaControl.querySelector('.nota');
  nota.textContent = enRespaldo ? 'Google no respondió: OpenStreetMap' : '';
  nota.hidden = !enRespaldo;
}

function agregarSelectorCapa() {
  const Selector = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-control map-capa');
      const seg = L.DomUtil.create('div', 'seg', box);
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Tipo de mapa');
      for (const [capa, texto] of [
        ['mapa', 'Mapa'],
        ['satelite', 'Satélite'],
      ]) {
        const b = L.DomUtil.create('button', '', seg);
        b.type = 'button';
        b.dataset.capa = capa;
        b.textContent = texto;
      }
      const nota = L.DomUtil.create('div', 'nota', box);
      nota.hidden = true;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-capa]');
        if (!b || enRespaldo || b.dataset.capa === capaElegida) return;
        capaElegida = b.dataset.capa;
        guardarCapa(capaElegida);
        ponerCapa(capaElegida);
      });
      capaControl = box;
      return box;
    },
  });
  new Selector().addTo(claimsMap);
}

function ensureClaimsMap() {
  if (claimsMap) return claimsMap;
  claimsMap = L.map('claims-map', {
    zoomControl: true,
    minZoom: CABA_MIN_ZOOM,
    maxBounds: AMBA_BOUNDS,
    maxBoundsViscosity: 1.0,
  }).setView(CABA_CENTER, CABA_ZOOM);
  capaElegida = leerCapa();
  agregarSelectorCapa();
  ponerCapa(capaElegida);
  claimsLayer = L.layerGroup().addTo(claimsMap);
  return claimsMap;
}

// -------------------------------------------------------------------------
// Filtros
// -------------------------------------------------------------------------

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
    // Con todas tildadas no se manda (y así entran también los pendientes).
    precision: selectedPrecisiones.size < PRECISIONES.length ? [...selectedPrecisiones] : [],
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
    f.precision.length === 0 &&
    !f.barrio &&
    !f.comuna &&
    !f.desde &&
    !f.hasta &&
    !f.q
  );
}

function buildQueryString(f) {
  const params = new URLSearchParams();
  params.set('plataforma', currentPlatform());
  if (f.categoria.length > 0 && f.categoria.length < allCategorias.length) {
    params.set('categoria', f.categoria.join(','));
  }
  // currentFilters ya devuelve [] cuando están todas seleccionadas.
  if (f.subcategoria.length > 0) {
    params.set('subcategoria', f.subcategoria.join(','));
  }
  if (f.precision.length > 0) params.set('precision', f.precision.join(','));
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

  // Solo vale la respuesta del último pedido: dos cambios seguidos de un
  // filtro ("Ninguna" y después una casilla) mandan dos, y el primero puede
  // volver último.
  const pedido = ++claimsPedido;

  // "Ninguna" categoría o precisión tildada: no hay nada que mostrar, no
  // hace falta pegarle al servidor.
  if (selectedCategorias.size === 0 || selectedPrecisiones.size === 0) {
    rawReclamos = [];
    renderMarkers();
    return;
  }

  try {
    const qs = buildQueryString(currentFilters());
    const resp = await fetch(`/api/reclamos?${qs}`);
    if (!resp.ok) throw new Error('No se pudieron cargar los reclamos.');
    const data = await resp.json();
    if (pedido !== claimsPedido) return;
    rawReclamos = Array.isArray(data.reclamos) ? data.reclamos : [];
    if (errorEl) {
      errorEl.classList.add('hidden');
      errorEl.textContent = '';
    }
    renderMarkers();
  } catch (err) {
    if (pedido !== claimsPedido) return;
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
// Multi-select desplegable (categoría / subcategoría): botón cerrado con contador
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
 * @param {{ containerId: string, label: string, options: string[], selectedSet: Set<string>,
 *   labelOf?: (value: string) => string }} config labelOf: el texto de cada
 *   opción, si no es el valor (la precisión).
 * @returns {{ selectAll: () => void, selectNone: () => void }}
 */
function createFilterMultiSelect({ containerId, label, options, selectedSet, labelOf = (v) => v }) {
  const host = document.getElementById(containerId);
  if (!host) return { selectAll() {}, selectNone() {} };
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
    optLabel.append(checkbox, document.createTextNode(labelOf(value)));
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

// El (0,0) no es una ubicación: lo deja una respuesta de USIG sin
// coordenadas, y el pin quedaría en el golfo de Guinea, fuera del AMBA. La
// misma regla cuenta "reclamos en el mapa" del login (db.countReclamosEnMapa).
// Desde la fase H los de fuera de la Ciudad y los descartados también llegan
// (para "Sin ubicar"), y nunca tienen pin.
function hasMapLocation(row) {
  return (
    row.x != null &&
    row.y != null &&
    !(row.x === 0 && row.y === 0) &&
    Boolean(row.direccionNormalizada) &&
    row.geoStatus !== 'fuera_caba' &&
    row.motivoSinUbicar !== 'descartado'
  );
}

// La precisión de antes de la fase H (exacta | aproximada), por si queda
// alguna fila sin migrar.
const precisionDe = (r) => (r.precision === 'aproximada' ? 'lugar' : r.precision === 'exacta' ? 'puntual' : r.precision);

// La precisión de un pin: con un reclamo de dirección o cruce ahí, el punto
// es preciso; si no, la del lugar o la del área.
function precisionDelGrupo(reclamos) {
  const ps = reclamos.map(precisionDe);
  if (ps.some((p) => p === 'puntual' || p === 'cruce')) return 'puntual';
  if (ps.includes('lugar')) return 'lugar';
  if (ps.includes('area')) return 'area';
  return 'puntual';
}

function textoPrecision(reclamos) {
  const ps = [...new Set(reclamos.map(precisionDe).filter((p) => p && p !== 'ninguna'))];
  return ps.map((p) => etiquetas.PRECISION[p] || p).join(' · ');
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
  for (const g of lista) g.precision = precisionDelGrupo(g.reclamos);
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
  const lugar = group.reclamos.find((r) => r.nombreLugar);
  const titulo = lugar && lugar.nombreLugar !== group.address ? `${escapeHtml(lugar.nombreLugar)}<br>${escapeHtml(group.address)}` : escapeHtml(group.address);
  return `<strong>${titulo}</strong><br><span class="claims-tip-prec">${escapeHtml(textoPrecision(group.reclamos))}</span><br>${group.reclamos.length} reclamo(s)<br>${lines}`;
}

// "Ver posteo" de un reclamo: adónde lleva lo dice el servidor (verPosteo,
// reclamosRoutes.js). El análisis se abre en esta pestaña por su hash
// (analysis.js lo atiende); el del Monitoreo abre el pop-up de la
// publicación encima del Mapa (claimsVerPosteoClick; si no está en la
// tabla, el link sigue y abre la red); la red, en otra pestaña. Sin link
// (el panel El Niño), no hay nada que ver.
function linkVerPosteo(v) {
  if (!v || !v.url) return '';
  if (v.tipo === 'analisis' && Number.isFinite(v.analisisId)) {
    return `<a href="#analisis-${v.analisisId}">Ver el análisis</a>`;
  }
  const postId = v.tipo === 'monitoreo' && /^\d{1,30}$/.test(String(v.postId)) ? ` data-post-id="${v.postId}"` : '';
  return `<a href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer"${postId}>Ver posteo</a>`;
}

// En captura: el pop-up de Leaflet no tiene que ver el clic antes.
document.addEventListener(
  'click',
  function claimsVerPosteoClick(e) {
    const a = e.target.closest && e.target.closest('.claims-popup a[data-post-id]');
    if (!a || typeof openFeedPopList !== 'function') return;
    if (openFeedPopList([a.dataset.postId], a.dataset.postId, a)) e.preventDefault();
  },
  true
);

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

  // La precisión en una línea ("Lugar con nombre · ubicación aproximada").
  const avisoPrecision = `<div class="claims-popup-nota">${escapeHtml(textoPrecision(group.reclamos))}</div>`;
  const lugar = group.reclamos.find((r) => r.nombreLugar && r.nombreLugar !== group.address);
  const subtitulo = lugar ? `<div class="claims-popup-sub">${escapeHtml(lugar.nombreLugar)}</div>` : '';

  const items = group.reclamos
    .map((r) => {
      // Uno importado sin autor (el panel El Niño) dice de dónde vino.
      const user = r.autor ? `@${escapeHtml(r.autor)}` : escapeHtml(r.importOrigen || '@desconocido');
      const comment = escapeHtml(r.textoOriginal || '');
      const sub = r.subcategoria
        ? `<div class="claims-popup-sub">${escapeHtml(r.subcategoria)}</div>`
        : '';
      return `<div class="claims-popup-item">
        <div class="claims-popup-user">${user} · <span class="claims-tema-pill" style="background:${colorDeCategoria(
          r.categoria
        )};color:#fff">${escapeHtml(r.categoria)}</span></div>
        ${sub}
        <div class="claims-popup-comment">${comment}</div>
        ${linkVerPosteo(r.verPosteo)}
      </div>`;
    })
    .join('');
  return `<div class="claims-popup"><h2>${escapeHtml(group.address)}</h2>${subtitulo}${desglose}${avisoPrecision}${items}</div>`;
}

function pinDiameter(count) {
  const n = Math.max(1, Number(count) || 1);
  if (n === 1) return 26;
  return Math.min(80, Math.round(26 + 10 * Math.sqrt(n - 1) + 6 * (n - 1)));
}

function setEmptyState(isEmpty, filtered, sinUbicar = 0) {
  const empty = document.getElementById('claimsMapEmpty');
  const mapEl = document.getElementById('claims-map');
  const title = document.getElementById('claimsMapEmptyTitle');
  const text = document.getElementById('claimsMapEmptyText');
  if (empty) empty.classList.toggle('hidden', !isEmpty);
  if (mapEl) mapEl.classList.toggle('is-empty', isEmpty);
  if (!isEmpty || !title || !text) return;
  if (sinUbicar > 0) {
    // Hay reclamos, pero ninguno con punto: no es "todavía no hay".
    title.textContent = filtered ? 'Ningún reclamo con punto coincide con los filtros' : 'Ningún reclamo tiene punto todavía';
    text.textContent = `${sinUbicar === 1 ? 'Hay 1 sin ubicar' : `Hay ${sinUbicar} sin ubicar`}: están en la lista de abajo, donde se pueden corregir.`;
  } else if (filtered) {
    title.textContent = 'Ningún reclamo coincide con los filtros';
    text.textContent = 'Probá ampliar el rango de fechas o tildar más categorías.';
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
  const sinUbicar = renderSinUbicar();
  updateClearButtonState();
  if (vistaMapa === 'comunas') {
    setEmptyState(false, filtered);
    renderLeyenda(groups);
    renderComunas();
    return;
  }
  if (comunasLayer) claimsMap.removeLayer(comunasLayer);
  setEmptyState(groups.length === 0, filtered, sinUbicar);

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
    // La precisión (fase H): dirección o cruce, sólido; un lugar con nombre,
    // con halo y borde punteado (el centroide del lugar, no una altura); una
    // villa, con un halo grande (es un área). Con un reclamo preciso en el
    // punto, el pin va sólido.
    const icon = L.divIcon({
      className: 'claims-pin-wrap',
      iconSize: [diameter, diameter],
      iconAnchor: [radius, radius],
      html:
        `<div class="claims-pin p-${group.precision}" ` +
        `style="width:${diameter}px;height:${diameter}px;--pin:${color};background:${color};color:${texto};` +
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

function mostrarError(mensaje) {
  const errorEl = document.getElementById('claimsMapError');
  if (!errorEl) return;
  errorEl.textContent = mensaje;
  errorEl.classList.remove('hidden');
}

// dd/mm/aaaa en hora de Argentina (a mano: Intl es-AR da "25/9").
function fechaCorta(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.day}/${p.month}/${p.year}`;
}

function el(tag, clase, texto) {
  const e = document.createElement(tag);
  if (clase) e.className = clase;
  if (texto != null) e.textContent = texto;
  return e;
}

const RECORTE_TEXTO = 240;

/** Un reclamo en una lista (la comuna elegida o "Sin ubicar"), todo por textContent. */
function itemReclamo(r, { acciones = false } = {}) {
  const item = el('article', 'claims-su-item');
  const cab = el('div', 'claims-su-cab');
  const pill = el('span', 'claims-tema-pill', r.categoria);
  pill.style.background = colorDeCategoria(r.categoria);
  pill.style.color = '#fff';
  const meta = [r.autor ? `@${r.autor}` : null, fechaCorta(r.fecha || r.detectedAt)].filter(Boolean).join(' · ');
  cab.append(pill, el('span', 'claims-su-meta', meta));
  const textoCompleto = String(r.textoOriginal || '').replace(/\s+/g, ' ').trim();
  const texto = el('p', 'claims-su-texto', textoCompleto.length > RECORTE_TEXTO ? `${textoCompleto.slice(0, RECORTE_TEXTO - 1).trimEnd()}…` : textoCompleto);
  if (textoCompleto.length > RECORTE_TEXTO) texto.title = textoCompleto;
  const leido = el('p', 'claims-su-leido');
  if (hasMapLocation(r)) {
    leido.textContent = `${r.nombreLugar ? `${r.nombreLugar} · ` : ''}${r.direccionNormalizada} · ${etiquetas.PRECISION[r.precision] || ''}`;
  } else if (r.motivoSinUbicar === 'descartado') {
    leido.textContent = `Descartado${r.descarteMotivo ? `: ${r.descarteMotivo}` : ''}`;
  } else if (r.ubicacionTipo === 'barrio' && r.barrio) {
    leido.textContent = `Solo el barrio: ${r.barrio}${r.comuna != null ? ` · comuna ${r.comuna}` : ''}`;
  } else if (r.ubicacionTipo === 'barrio' && r.comuna != null) {
    leido.textContent = `Solo la comuna ${r.comuna}`;
  } else {
    // `leido`: lo que extrajo el modelo (o la dirección de antes); lo arma el servidor.
    const loLeido = r.leido !== undefined ? r.leido : r.direccionDetectada;
    leido.textContent = loLeido ? `Se leyó: «${loLeido}»` : 'Sin un lugar escrito';
  }
  if (r.corregida) leido.append(el('span', 'claims-su-corregida', ' · corregido a mano'));
  item.append(cab, texto, leido);
  if (acciones) agregarAcciones(item, r);
  return item;
}

// -------------------------------------------------------------------------
// Sin ubicar (fase H): por motivo; corregir y descartar en el mismo renglón.
// -------------------------------------------------------------------------

const ORDEN_GRUPOS = ['pendiente', 'barrio', 'lineal', 'ambigua', 'no_encontrada', 'sin_direccion', 'fuera_de_caba', 'descartado'];
const TITULO_GRUPO = { pendiente: 'Todavía sin resolver', barrio: 'Solo el barrio' };
const MAX_POR_GRUPO = 20;
const gruposCompletos = new Set();

function grupoDe(r) {
  if (r.motivoSinUbicar === 'descartado') return 'descartado';
  if (r.geoStatus === 'pendiente') return 'pendiente';
  if (r.ubicacionTipo === 'barrio' && !r.motivoSinUbicar) return 'barrio';
  return r.motivoSinUbicar || 'no_encontrada';
}

function avisoSinUbicar(texto) {
  const aviso = document.getElementById('claimsSinUbicarAviso');
  if (aviso) aviso.textContent = texto;
}

function formulario({ etiqueta, placeholder, accion, alEnviar }) {
  const form = el('form', 'claims-su-form');
  const id = `su-${Math.random().toString(36).slice(2, 9)}`;
  const label = el('label', 'sr', etiqueta);
  label.htmlFor = id;
  const input = el('input');
  input.type = 'text';
  input.id = id;
  input.maxLength = 200;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  const enviar = el('button', 'btn-small primary', accion);
  enviar.type = 'submit';
  const cancelar = el('button', 'btn-small btn-ghost', 'Cancelar');
  cancelar.type = 'button';
  const error = el('p', 'claims-su-error');
  error.setAttribute('role', 'alert');
  form.append(label, input, enviar, cancelar, error);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const valor = input.value.trim();
    if (!valor) {
      error.textContent = 'Escribí algo antes de seguir.';
      input.focus();
      return;
    }
    enviar.disabled = true;
    error.textContent = '';
    try {
      await alEnviar(valor);
    } catch (err) {
      error.textContent = err.message || 'No se pudo.';
      enviar.disabled = false;
      input.focus();
    }
  });
  return { form, input, cancelar };
}

async function postReclamo(r, accion, cuerpo) {
  const resp = await fetch(`/api/reclamos/${encodeURIComponent(r.id)}/${accion}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'No se pudo.');
  return data.reclamo;
}

function agregarAcciones(item, r) {
  const botones = el('div', 'claims-su-acciones');
  const corregir = el('button', 'btn-small', r.motivoSinUbicar === 'descartado' ? 'Ubicar igual' : 'Corregir dirección');
  corregir.type = 'button';
  botones.append(corregir);
  let descartar = null;
  if (r.motivoSinUbicar !== 'descartado') {
    descartar = el('button', 'btn-small btn-ghost', 'Descartar');
    descartar.type = 'button';
    botones.append(descartar);
  }
  item.append(botones);
  const abrir = ({ form, input, cancelar }, boton) => {
    botones.hidden = true;
    item.append(form);
    input.focus();
    cancelar.addEventListener('click', () => {
      form.remove();
      botones.hidden = false;
      boton.focus();
    });
  };
  corregir.addEventListener('click', () =>
    abrir(
      formulario({
        etiqueta: 'Dirección, cruce o lugar',
        placeholder: 'Ej.: Corrientes 1200 · Nazca y Rivadavia · Plaza Irlanda',
        accion: 'Ubicar',
        alEnviar: async (texto) => {
          const nuevo = await postReclamo(r, 'corregir', { texto });
          avisoSinUbicar(
            nuevo && nuevo.direccionNormalizada
              ? `Ubicado: ${nuevo.nombreLugar ? `${nuevo.nombreLugar}, ` : ''}${nuevo.direccionNormalizada} (${etiquetas.PRECISION[nuevo.precision] || nuevo.precision}).`
              : `Quedó como mención de ${nuevo && nuevo.barrio ? nuevo.barrio : 'un barrio'}.`
          );
          await applyFiltersAndReload();
        },
      }),
      corregir
    )
  );
  if (descartar) {
    descartar.addEventListener('click', () =>
      abrir(
        formulario({
          etiqueta: 'Por qué no es un reclamo ubicable',
          placeholder: 'Ej.: es una opinión, no un reclamo',
          accion: 'Descartar',
          alEnviar: async (motivo) => {
            await postReclamo(r, 'descartar', { motivo });
            avisoSinUbicar('Descartado: queda en la lista de descartados.');
            await applyFiltersAndReload();
          },
        }),
        descartar
      )
    );
  }
}

/** Dibuja la tarjeta "Sin ubicar". Devuelve cuántos hay (sin los descartados). */
function renderSinUbicar() {
  const cont = document.getElementById('claimsSinUbicarLista');
  const nEl = document.getElementById('claimsSinUbicarN');
  if (!cont) return 0;
  const sin = rawReclamos.filter((r) => !hasMapLocation(r));
  const grupos = new Map();
  for (const r of sin) {
    const g = grupoDe(r);
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(r);
  }
  const vigentes = sin.length - (grupos.get('descartado') || []).length;
  if (nEl) nEl.textContent = String(vigentes);
  cont.replaceChildren();
  if (!sin.length) {
    cont.append(el('p', 'claims-su-vacio', 'Todos los reclamos de esta vista tienen un punto en el mapa.'));
    return 0;
  }
  for (const g of ORDEN_GRUPOS) {
    const lista = grupos.get(g);
    if (!lista || !lista.length) continue;
    const bloque = el('section', `claims-su-grupo g-${g}`);
    const titulo = el('h3', '', TITULO_GRUPO[g] || etiquetas.MOTIVO[g] || g);
    titulo.append(el('span', 'num', ` ${lista.length}`));
    bloque.append(titulo);
    const visibles = gruposCompletos.has(g) ? lista : lista.slice(0, MAX_POR_GRUPO);
    for (const r of visibles) bloque.append(itemReclamo(r, { acciones: g !== 'pendiente' }));
    if (visibles.length < lista.length) {
      const mas = el('button', 'btn-small btn-ghost claims-su-mas', `Ver los ${lista.length}`);
      mas.type = 'button';
      mas.addEventListener('click', () => {
        gruposCompletos.add(g);
        renderSinUbicar();
      });
      bloque.append(mas);
    }
    cont.append(bloque);
  }
  return vigentes;
}

// -------------------------------------------------------------------------
// Por comunas (fase H): los ubicados más las menciones de solo un barrio;
// nunca los de afuera ni los descartados.
// -------------------------------------------------------------------------

function cuentaEnComuna(row) {
  if (row.comuna == null || row.geoStatus === 'fuera_caba' || row.motivoSinUbicar === 'descartado') return false;
  return hasMapLocation(row) || row.ubicacionTipo === 'barrio';
}

function reclamosPorComuna() {
  const m = new Map();
  for (const r of rawReclamos) {
    if (!cuentaEnComuna(r)) continue;
    const c = Number(r.comuna);
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(r);
  }
  return m;
}

async function cargarComunas() {
  if (comunasGeo) return comunasGeo;
  const resp = await fetch('/api/geo/comunas');
  if (!resp.ok) throw new Error('No se pudieron cargar las comunas.');
  comunasGeo = await resp.json();
  return comunasGeo;
}

const plural = (n, uno, varios) => (n === 1 ? `1 ${uno}` : `${n} ${varios}`);

function renderBotonesComunas(porComuna) {
  let cont = document.getElementById('claimsComunaBotones');
  if (!cont) {
    cont = el('div', 'claims-comuna-botones');
    cont.id = 'claimsComunaBotones';
    cont.setAttribute('role', 'group');
    cont.setAttribute('aria-label', 'Comunas');
    document.getElementById('claimsComunasNota')?.after(cont);
  }
  cont.replaceChildren();
  for (let c = 1; c <= 15; c++) {
    const n = (porComuna.get(c) || []).length;
    const b = el('button', `btn-small${c === comunaElegida ? ' on' : ''}`, `C${c}`);
    b.type = 'button';
    b.append(el('span', 'num', ` · ${n}`));
    b.setAttribute('aria-label', `Comuna ${c}: ${plural(n, 'reclamo', 'reclamos')}`);
    b.setAttribute('aria-pressed', String(c === comunaElegida));
    b.addEventListener('click', () => elegirComuna(c));
    cont.append(b);
  }
}

async function renderComunas() {
  let geo;
  try {
    geo = await cargarComunas();
  } catch (err) {
    mostrarError(err.message);
    return;
  }
  if (vistaMapa !== 'comunas') return;
  const porComuna = reclamosPorComuna();
  const max = Math.max(1, ...[...porComuna.values()].map((l) => l.length));
  const acento = cssVar('--accent') || '#2a78d6';
  if (comunasLayer) claimsMap.removeLayer(comunasLayer);
  comunasLayer = L.geoJSON(geo, {
    style: (f) => {
      const c = Number(f.properties && f.properties.comuna);
      const n = (porComuna.get(c) || []).length;
      return { color: acento, weight: c === comunaElegida ? 3 : 1.2, fillColor: acento, fillOpacity: n ? 0.1 + 0.38 * (n / max) : 0.03 };
    },
    onEachFeature: (f, layer) => {
      const c = Number(f.properties && f.properties.comuna);
      layer.bindTooltip(`Comuna ${c} · ${plural((porComuna.get(c) || []).length, 'reclamo', 'reclamos')}`, { sticky: true });
      layer.on('click', () => elegirComuna(c));
    },
  }).addTo(claimsMap);
  claimsMap.fitBounds(comunasLayer.getBounds(), { padding: [12, 12] });
  renderBotonesComunas(porComuna);
  if (comunaElegida != null) renderComunaCard(comunaElegida, porComuna.get(comunaElegida) || []);
}

function renderComunaCard(c, lista) {
  const card = document.getElementById('claimsComunaCard');
  if (!card) return;
  card.classList.remove('hidden');
  document.getElementById('claimsComunaTitulo').textContent = `Comuna ${c}`;
  const conPunto = lista.filter(hasMapLocation).length;
  const menciones = lista.length - conPunto;
  const barrios = [...new Set(lista.map((r) => r.barrio).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const partes = [conPunto ? `${conPunto} con punto en el mapa` : null, menciones ? `${menciones} que ${menciones === 1 ? 'nombra' : 'nombran'} solo el barrio` : null].filter(Boolean);
  document.getElementById('claimsComunaResumen').textContent = lista.length
    ? `${plural(lista.length, 'reclamo', 'reclamos')}: ${partes.join(' y ')}.${barrios.length ? ` Barrios: ${barrios.join(', ')}.` : ''}`
    : 'Ningún reclamo en esta comuna con estos filtros.';
  const cont = document.getElementById('claimsComunaLista');
  cont.replaceChildren(...lista.map((r) => itemReclamo(r)));
}

function elegirComuna(c) {
  comunaElegida = c;
  renderComunas().then(() => document.getElementById('claimsComunaTitulo')?.focus());
}

function cambiarVista(v) {
  if (v === vistaMapa) return;
  vistaMapa = v;
  document.querySelectorAll('#claimsVistaSeg button[data-v]').forEach((b) => {
    const on = b.dataset.v === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.getElementById('claimsPrecLeyenda')?.classList.toggle('hidden', v === 'comunas');
  document.getElementById('claimsComunasNota')?.classList.toggle('hidden', v !== 'comunas');
  document.getElementById('claimsComunaBotones')?.classList.toggle('hidden', v !== 'comunas');
  if (v === 'puntos') {
    comunaElegida = null;
    document.getElementById('claimsComunaCard')?.classList.add('hidden');
  }
  renderMarkers();
}

document.getElementById('claimsVistaSeg')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (b) cambiarVista(b.dataset.v);
});
document.getElementById('claimsComunaCerrar')?.addEventListener('click', () => {
  comunaElegida = null;
  document.getElementById('claimsComunaCard')?.classList.add('hidden');
  renderComunas();
});

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
    const resp = await fetch(`/api/reclamos?plataforma=${encodeURIComponent(currentPlatform())}`);
    if (!resp.ok) throw new Error('No se pudieron cargar los reclamos.');
    const data = await resp.json();

    allCategorias = Array.isArray(data.categorias) ? data.categorias : [];
    subcategoriasPorCategoria = data.subcategoriasPorCategoria || {};
    conteoPorCategoria = data.conteoPorCategoria || {};
    selectedCategorias = new Set(allCategorias);
    rawReclamos = Array.isArray(data.reclamos) ? data.reclamos : [];
    if (data.etiquetas && data.etiquetas.PRECISION) etiquetas = data.etiquetas;
    selectedPrecisiones = new Set(PRECISIONES);

    recalcularPaleta();

    closeOpenFilterPanel();
    categoriaMultiSelect = createFilterMultiSelect({
      containerId: 'claimsCategoriaSelect',
      label: 'Categoría',
      options: allCategorias,
      selectedSet: selectedCategorias,
    });
    rebuildSubcategoriaFilter();
    precisionMultiSelect = createFilterMultiSelect({
      containerId: 'claimsPrecisionSelect',
      label: 'Precisión',
      options: PRECISIONES,
      selectedSet: selectedPrecisiones,
      labelOf: (p) => etiquetas.PRECISION[p] || p,
    });
    populateBarrioComunaOptions(rawReclamos.filter((r) => r.geoStatus !== 'fuera_caba'));
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

for (const id of ['claimsBarrio', 'claimsComuna', 'claimsDesde', 'claimsHasta']) {
  document.getElementById(id)?.addEventListener('change', () => applyFiltersAndReload());
}
document.getElementById('claimsBuscar')?.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => applyFiltersAndReload(), SEARCH_DEBOUNCE_MS);
});
document.getElementById('claimsClearBtn')?.addEventListener('click', () => {
  categoriaMultiSelect?.selectAll();
  rebuildSubcategoriaFilter();
  subcategoriaMultiSelect?.selectAll();
  precisionMultiSelect?.selectAll();
  resetOtherFilters();
  applyFiltersAndReload();
});
