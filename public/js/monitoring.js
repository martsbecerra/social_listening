const newAccountInput = document.getElementById('newAccount');
const addAccountBtn = document.getElementById('addAccountBtn');
const accountErrorEl = document.getElementById('accountError');
const newKeywordInput = document.getElementById('newKeyword');
const addKeywordBtn = document.getElementById('addKeywordBtn');
const keywordErrorEl = document.getElementById('keywordError');

// Listas de fuentes "de siempre" (x.html): vista previa con "Ver todas" y el
// listado completo en un modal. En instagram.html no están: ahí las cajas de
// fuentes las dibuja public/js/monitoringPanel.js con la config que se
// avisa por notifyMonitoringViews({ config }).
const accountListPreviewEl = document.getElementById('accountListPreview');
const accountListFullEl = document.getElementById('accountListFull');
const viewAllAccountsBtn = document.getElementById('viewAllAccountsBtn');
const accountsModal = document.getElementById('accountsModal');
const accountsModalCloseBtn = document.getElementById('accountsModalCloseBtn');
const keywordListPreviewEl = document.getElementById('keywordListPreview');
const keywordListFullEl = document.getElementById('keywordListFull');
const viewAllKeywordsBtn = document.getElementById('viewAllKeywordsBtn');
const keywordsModal = document.getElementById('keywordsModal');
const keywordsModalCloseBtn = document.getElementById('keywordsModalCloseBtn');
const HAS_CLASSIC_SOURCES = Boolean(
  accountListPreviewEl && accountListFullEl && viewAllAccountsBtn && accountsModal && accountsModalCloseBtn &&
    keywordListPreviewEl && keywordListFullEl && viewAllKeywordsBtn && keywordsModal && keywordsModalCloseBtn
);

// Búsquedas por palabra clave (lista `searches`) y hashtags aparte: las cajas
// existen solo en la solapa de Instagram (x.html no las tiene).
const newSearchInput = document.getElementById('newSearch');
const addSearchBtn = document.getElementById('addSearchBtn');
const searchErrorEl = document.getElementById('searchError');
const HAS_SEARCHES = Boolean(newSearchInput && addSearchBtn && searchErrorEl);
const newHashtagInput = document.getElementById('newHashtag');
const addHashtagBtn = document.getElementById('addHashtagBtn');
const hashtagErrorEl = document.getElementById('hashtagError');
const HAS_HASHTAGS = Boolean(newHashtagInput && addHashtagBtn && hashtagErrorEl);

const ignoreModal = document.getElementById('ignoreModal');
const ignoreCancelBtn = document.getElementById('ignoreCancelBtn');
const ignoreConfirmBtn = document.getElementById('ignoreConfirmBtn');

const runNowBtn = document.getElementById('runNowBtn');
const monitoringStatusCard = document.getElementById('monitoringStatusCard');
const monitoringProgressEl = document.getElementById('monitoringProgress');
const monitoringStatusIconEl = document.getElementById('monitoringStatusIcon');
const monitoringStatusTextEl = document.getElementById('monitoringStatusText');
const monitoringStatusCountEl = document.getElementById('monitoringStatusCount');
const monitoringProgressFillEl = document.getElementById('monitoringProgressFill');
const monitoringProgressListEl = document.getElementById('monitoringProgressList');
const monitoringProgressHideEl = document.getElementById('monitoringProgressHide');
// El porcentaje del recuadro (solo en instagram.html).
const monitoringProgressPctEl = document.getElementById('monitoringProgressPct');
const monitoringLoadErrorEl = document.getElementById('monitoringLoadError');
// "próxima corrida HH:MM" de x.html. El estado de la escucha de la barra
// superior lo escribe topbar.js.
const monitoringNextRunEl = document.getElementById('monitoringNextRun');

const highlightsSectionEl = document.getElementById('monitoringHighlightsSection');
const cardsEl = document.getElementById('cards');
// Cuántas tiras hay en "Se despegaron" (solo en instagram.html).
const highlightsCountEl = document.getElementById('highlightsCount');

const fSentEl = document.getElementById('fSent');
// Filtros "Alcance" y "Tema", el orden y el período: solo están en
// instagram.html (el alcance sale del benchmark, que X no tiene). En x.html
// son null y esos filtros no existen.
const fAlcanceEl = document.getElementById('fAlcance');
const fTemaEl = document.getElementById('fTema');
const fOrdenEl = document.getElementById('fOrden');
const fAccBtnEl = document.getElementById('fAccBtn');
const fAccPanelEl = document.getElementById('fAccPanel');
// Instagram: el desplegable de Cuenta lleva buscador y la cantidad de
// publicaciones del período de cada cuenta (el combo de la maqueta). X: la
// lista simple de siempre.
const fAccTextEl = document.getElementById('fAccBtnText');
const fAccQEl = document.getElementById('fAccQ');
const fAccListEl = document.getElementById('fAccList');
const HAS_ACC_COMBO = Boolean(fAccTextEl && fAccQEl && fAccListEl);
const fDesdeEl = document.getElementById('fDesde');
const fHastaEl = document.getElementById('fHasta');
const qEl = document.getElementById('q');
const nEl = document.getElementById('n');
const mEl = document.getElementById('m');
const monitoringClearBtn = document.getElementById('clear');
// El filtro por fuente (un clic en un chip de búsqueda, palabra clave o
// hashtag), a la vista como una pastilla con ✕ en la línea "Mostrando N de
// M". Solo instagram.html.
const fSourceEl = document.getElementById('fSource');
// Selector Hoy / 7 días / 30 días de la cabecera (solo instagram.html).
const periodSegEl = document.getElementById('periodSeg');

const KEYWORDS_PREVIEW_COUNT = 2;
// Todo de una sola vez: el orden/filtro/paginación ahora los maneja
// Tabulator del lado del cliente, así que no paginamos contra el backend.
const FETCH_ALL_PAGE_SIZE = 5000;
// window.SL_PLATFORM lo setea x.html / instagram.html justo antes de este
// script. dataset.platform es el respaldo. Sin eso, el API defaultéa a
// Instagram y la solapa de X mostraría posteos de la otra red.
function currentMonitorPlatform() {
  if (window.SL_PLATFORM === 'x' || window.SL_PLATFORM === 'instagram') return window.SL_PLATFORM;
  return document.body?.dataset?.platform === 'x' ? 'x' : 'instagram';
}
const MONITOR_PLATFORM = currentMonitorPlatform();
const IS_X_MONITOR = MONITOR_PLATFORM === 'x';
const PROFILE_BASE = IS_X_MONITOR ? 'https://x.com/' : 'https://instagram.com/';
const PLATFORM_LABEL = IS_X_MONITOR ? 'X' : 'Instagram';
let pendingIgnoreId = null;

function withPlataforma(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}plataforma=${encodeURIComponent(MONITOR_PLATFORM)}`;
}

// -------------------------------------------------------------------------
// Config: cuentas trackeadas / palabras clave (visible arriba, sin modal).
// Los ids/handlers de este bloque no cambian — solo el marcado que genera
// renderTagList pasa de <li> (.tag-list) a .chip, calcado de
// design/monitoreo.html.
// -------------------------------------------------------------------------
function renderTagList(listEl, items, onRemove, extraClass) {
  listEl.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = 'Ninguna todavía';
    listEl.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = extraClass ? `chip ${extraClass}` : 'chip';
    const span = document.createElement('span');
    span.textContent = item;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '✕';
    btn.title = 'Quitar';
    btn.addEventListener('click', () => onRemove(item));
    chip.appendChild(span);
    chip.appendChild(btn);
    listEl.appendChild(chip);
  });
}

// Lista con vista previa + "Ver todas (N)" + listado completo en un modal
// (x.html: cuentas y palabras clave).
function renderPreviewLists({ previewEl, fullEl, viewAllBtn, items, onRemove, extraClass }) {
  const preview = items.slice(0, KEYWORDS_PREVIEW_COUNT);
  renderTagList(previewEl, preview, onRemove, extraClass);
  renderTagList(fullEl, items, onRemove, extraClass);

  // renderTagList reemplaza todo el contenido del contenedor, así que el
  // botón "Ver todas" (que vive ahí adentro para quedar en la misma fila
  // que los chips) hay que volver a engancharlo después.
  if (items.length > KEYWORDS_PREVIEW_COUNT) {
    viewAllBtn.textContent = `Ver todas (${items.length})`;
    viewAllBtn.classList.remove('hidden');
  } else {
    viewAllBtn.classList.add('hidden');
  }
  previewEl.appendChild(viewAllBtn);
}

function renderAccountLists(accounts) {
  renderPreviewLists({
    previewEl: accountListPreviewEl,
    fullEl: accountListFullEl,
    viewAllBtn: viewAllAccountsBtn,
    items: accounts,
    onRemove: removeAccount,
  });
}

function renderKeywordLists(keywords) {
  renderPreviewLists({
    previewEl: keywordListPreviewEl,
    fullEl: keywordListFullEl,
    viewAllBtn: viewAllKeywordsBtn,
    items: keywords,
    onRemove: removeKeyword,
    extraClass: 'kw',
  });
}

// La última config que llegó: { accounts, keywords, searches, temas };
// undefined mientras no llegó ninguna, null si falló. Un script que se anota
// en monitoringViewListeners después de que llegó (la respuesta puede ganarle
// a la carga de los scripts siguientes) la lee de acá.
let monitoringConfig;

// Opciones del filtro "Tema" (instagram.html): los temas posibles de un
// posteo, en el orden de config/categorias-reclamos.json (temas de
// /api/monitoring/config). Si el elegido sigue existiendo, queda elegido.
function fillTemaFilter(temas) {
  if (!fTemaEl) return;
  const previous = fTemaEl.value;
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos';
  const options = (temas || []).map((tema) => {
    const opt = document.createElement('option');
    opt.value = tema;
    opt.textContent = tema;
    return opt;
  });
  fTemaEl.replaceChildren(all, ...options);
  fTemaEl.value = (temas || []).includes(previous) ? previous : '';
}

async function loadConfig() {
  try {
    const resp = await fetch(withPlataforma('/api/monitoring/config'));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = await resp.json();
    monitoringConfig = config;
    if (HAS_CLASSIC_SOURCES) {
      renderAccountLists(config.accounts);
      renderKeywordLists(config.keywords);
    }
    fillTemaFilter(config.temas);
    notifyMonitoringViews({ config });
  } catch (err) {
    if (HAS_CLASSIC_SOURCES) {
      accountListPreviewEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
      keywordListPreviewEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
    }
    if (monitoringConfig === undefined) monitoringConfig = null;
    notifyMonitoringViews({ config: monitoringConfig });
    console.error('Error cargando config de monitoreo:', err);
  }
}

// Agrega una fuente con su endpoint (POST /api/monitoring/<endpoint>, el
// valor en `key`). Mientras espera, el botón dice busyText; un error queda
// en errorEl. Al terminar bien vacía el campo y vuelve a leer la config.
// Devuelve true si se agregó.
async function addSource({ input, button, errorEl, endpoint, key, value, busyText, failText }) {
  if (!value) return false;
  errorEl.classList.add('hidden');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    const resp = await fetch(withPlataforma(`/api/monitoring/${endpoint}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value, plataforma: MONITOR_PLATFORM }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || failText);
    input.value = '';
    loadConfig();
    return true;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    return false;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Saca una fuente (DELETE) y vuelve a leer la config. Devuelve true si el
// servidor la sacó.
async function removeSource(endpoint, value, what) {
  let ok = false;
  try {
    const resp = await fetch(withPlataforma(`/api/monitoring/${endpoint}/${encodeURIComponent(value)}`), { method: 'DELETE' });
    ok = resp.ok;
  } catch (err) {
    console.error(`Error quitando ${what}:`, err);
  }
  loadConfig();
  return ok;
}

function addAccount() {
  return addSource({
    input: newAccountInput,
    button: addAccountBtn,
    errorEl: accountErrorEl,
    endpoint: 'accounts',
    key: 'account',
    value: newAccountInput.value.trim(),
    busyText: IS_X_MONITOR ? 'Agregando…' : 'Verificando…',
    failText: 'No se pudo agregar la cuenta.',
  });
}

function removeAccount(account) {
  return removeSource('accounts', account, 'cuenta');
}

function addKeyword() {
  return addSource({
    input: newKeywordInput,
    button: addKeywordBtn,
    errorEl: keywordErrorEl,
    endpoint: 'keywords',
    key: 'keyword',
    value: newKeywordInput.value.trim(),
    busyText: 'Verificando…',
    failText: 'No se pudo agregar la palabra clave.',
  });
}

// Un hashtag es una palabra clave que empieza con "#" (la misma lista y el
// mismo endpoint): la caja de hashtags de instagram.html le pone el "#" si
// no lo escribieron.
function addHashtag() {
  const raw = newHashtagInput.value.trim().replace(/^#+/, '');
  return addSource({
    input: newHashtagInput,
    button: addHashtagBtn,
    errorEl: hashtagErrorEl,
    endpoint: 'keywords',
    key: 'keyword',
    value: raw ? `#${raw}` : '',
    busyText: 'Verificando…',
    failText: 'No se pudo agregar el hashtag.',
  });
}

function removeKeyword(keyword) {
  return removeSource('keywords', keyword, 'palabra clave');
}

function openAccountsModal() { accountsModal.classList.remove('hidden'); }
function closeAccountsModal() { accountsModal.classList.add('hidden'); }

function openKeywordsModal() { keywordsModal.classList.remove('hidden'); }
function closeKeywordsModal() { keywordsModal.classList.add('hidden'); }

// Búsquedas por palabra clave: sin verificación contra Apify al agregar
// (el backend solo rechaza si el actor activo no busca).
function addSearch() {
  return addSource({
    input: newSearchInput,
    button: addSearchBtn,
    errorEl: searchErrorEl,
    endpoint: 'searches',
    key: 'search',
    value: newSearchInput.value.trim(),
    busyText: 'Agregando…',
    failText: 'No se pudo agregar la búsqueda.',
  });
}

function removeSearch(search) {
  return removeSource('searches', search, 'búsqueda');
}

// --------------------------------------------------------------------
// Tabla de posteos detectados, con Tabulator.
// --------------------------------------------------------------------
const SENTIMENT_LABELS = { positivo: 'Positivo', neutral: 'Neutral', negativo: 'Negativo' };
const SENTIMENT_OPTIONS = ['positivo', 'neutral', 'negativo'];
// Un posteo guardado con sentiment NULL no es "Neutral": es uno que el
// clasificador no pudo evaluar (API caída o respuesta ilegible). Se muestra
// como tal para que se note y se pueda corregir a mano; el backfill lo
// reintenta solo. Ver src/classifier.js.
const SENTIMENT_UNSET = 'sin_clasificar';
const SENTIMENT_UNSET_LABEL = 'Sin clasificar';

function openIgnoreModal(id) {
  pendingIgnoreId = id;
  ignoreModal.classList.remove('hidden');
}

function closeIgnoreModal() {
  pendingIgnoreId = null;
  ignoreModal.classList.add('hidden');
}

async function confirmIgnore() {
  if (!pendingIgnoreId) return;
  const id = pendingIgnoreId;
  try {
    const resp = await fetch(withPlataforma(`/api/monitoring/posts/${encodeURIComponent(id)}/ignore`), { method: 'POST' });
    if (!resp.ok) throw new Error('No se pudo ignorar.');
    if (monitoringTable) {
      if (expandedRowId === id) expandedRowId = null;
      monitoringTable.deleteRow(id);
      updateCounts();
      renderHighlightCards(monitoringTable.getData());
      notifyMonitoringViews({ ignoredId: id });
    }
  } catch (err) {
    console.error('Error ignorando el registro:', err);
  }
  closeIgnoreModal();
}

async function updateSentiment(id, sentiment, selectEl) {
  // Cambiamos la clase al toque para que el color de la pastilla se
  // actualice ya mismo, sin esperar la respuesta del servidor.
  [...SENTIMENT_OPTIONS, SENTIMENT_UNSET].forEach((value) =>
    selectEl.classList.remove(`sentiment-${value}`)
  );
  selectEl.classList.add(`sentiment-${sentiment}`);

  // Ya tiene un sentimiento real: "Sin clasificar" deja de ser una opción.
  const optUnset = selectEl.querySelector(`option[value="${SENTIMENT_UNSET}"]`);
  if (optUnset) optUnset.remove();

  try {
    const resp = await fetch(withPlataforma(`/api/monitoring/posts/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentiment }),
    });
    if (!resp.ok) throw new Error('No se pudo guardar el cambio.');
  } catch (err) {
    console.error('Error actualizando el sentimiento:', err);
  }
}

// El selector de sentimiento (pastilla con color y marca de forma, ver
// .sentiment-select en styles.css). Lo arman la celda de la tabla y la
// tarjeta del feed, cada una con sus propios manejadores. "raw" es el valor
// guardado: null o vacío es "sin clasificar".
function buildSentimentSelect(raw) {
  const sinClasificar = !raw;
  const sentiment = sinClasificar ? SENTIMENT_UNSET : raw;

  const select = document.createElement('select');
  select.className = `sentiment-select sentiment-${sentiment}`;

  // La opción "Sin clasificar" existe sólo mientras el posteo lo esté: es
  // un estado del sistema, no algo que se elija a mano. Elegir cualquier
  // otro valor lo saca de ahí y no se puede volver.
  if (sinClasificar) {
    const opt = document.createElement('option');
    opt.value = SENTIMENT_UNSET;
    opt.textContent = SENTIMENT_UNSET_LABEL;
    opt.selected = true;
    select.appendChild(opt);
  }

  SENTIMENT_OPTIONS.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = SENTIMENT_LABELS[value];
    if (value === sentiment) opt.selected = true;
    select.appendChild(opt);
  });
  return select;
}

// Formatea un número con separador de miles es-AR, o "—" si no hay dato
// (mismo símbolo que usa design/monitoreo.html en fmt/abbr).
function formatCount(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('es-AR');
}

// Seguidores en formato abreviado con coma decimal (48,2K / 1,2M) — la
// referencia hace .replace('.', ',') a propósito, formato es-AR. Sin dato:
// guión, nunca "0" (0 seguidores reales sí se muestra como "0").
function formatFollowers(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')}K`;
  return String(n);
}

// Color del avatar de una cuenta (la inicial va en blanco), de la paleta de
// la maqueta v4 en su tono oscuro. Sale del nombre de la cuenta: cada una se
// ve siempre igual en el feed, el pop-up, el flujo, las cuentas seguidas y
// el filtro de Cuenta.
const ACCOUNT_PALETTE = ['#199e70', '#d04a4a', '#2a78d6', '#c98500', '#6250d6', '#0b7fc4', '#d95926', '#5466b8'];

function accountColor(account) {
  let hash = 7;
  for (const ch of String(account || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return ACCOUNT_PALETTE[hash % ACCOUNT_PALETTE.length];
}

// Color del punto de un tema (el flujo, el pop-up): el de su lugar en la
// lista de temas de la config, con los doce colores de categoría del mapa
// (--cat-1 … --cat-12, se repiten); sin tema, el gris de "otras".
function temaColor(tema) {
  const temas = (monitoringConfig && monitoringConfig.temas) || [];
  const i = tema ? temas.indexOf(tema) : -1;
  return i < 0 ? 'var(--cat-otras)' : `var(--cat-${(i % 12) + 1})`;
}

// El tema a la vista: punto de color y nombre (.tema en styles.css). null
// si el posteo no tiene tema.
function buildTemaTag(tema) {
  if (!tema) return null;
  const tag = document.createElement('span');
  tag.className = 'tema';
  const dot = document.createElement('i');
  dot.style.background = temaColor(tema);
  dot.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.textContent = tema;
  tag.title = tema;
  tag.append(dot, name);
  return tag;
}

// Por qué se detectó un posteo, a partir de matched_reason (lo arma
// src/monitor.js): "búsqueda" con su término, "palabra clave" con la
// palabra, o "cuenta trackeada". Lo que viene después de " · " es el motivo
// del clasificador y no entra acá. Una forma desconocida va tal cual, sin
// término.
function postReasonParts(reason) {
  const base = String(reason || '').split(' · ')[0].trim();
  let match = base.match(/^Búsqueda:\s*(.+?)(?:\s+\(|\s+—\s|$)/);
  if (match) return { text: 'búsqueda', term: match[1] };
  match = base.match(/^Coincidencia con palabra clave:\s*"?(.+?)"?$/);
  if (match) return { text: 'palabra clave', term: match[1] };
  if (base.startsWith('Cuenta trackeada')) return { text: 'cuenta trackeada', term: null };
  return { text: base, term: null };
}

// -------------------------------------------------------------------------
// Benchmark por cuenta (panel desplegable de la fila): compara likes y
// comentarios del posteo contra la mediana histórica de ESA cuenta (nunca
// contra otras cuentas ni contra seguidores — ver src/accountStats.js). El
// backend ya manda "benchmark" armado en cada posteo de /api/monitoring/posts.
// -------------------------------------------------------------------------
let expandedRowId = null;

function formatBenchmarkNumber(n) {
  return n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('es-AR');
}

// Formateador armado una sola vez: toLocaleString con opciones crea uno
// nuevo en cada llamada, y el feed formatea cientos de tarjetas de un saque.
const BENCHMARK_RATIO_OPTIONS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const BENCHMARK_RATIO_FORMAT = new Intl.NumberFormat('es-AR', BENCHMARK_RATIO_OPTIONS);

// La razón del alcance, con dos decimales ("1,09"). Se CORTA, no se
// redondea: los cortes de la regla (1,1 y 1,5, ver src/reachRule.js) tienen
// hasta dos decimales, y un 1,096 redondeado diría "1,10" al lado de
// "Alcance bajo". Cortando, el número que se ve nunca queda del otro lado
// del corte que su etiqueta. El 1e-9 es por la cuenta en punto flotante
// (1,15 * 100 da 114,99999999999999).
function formatBenchmarkRatio(ratio) {
  // Solo los números pasan por el formateador compartido. Con cualquier otra
  // cosa hace lo mismo que antes de tenerlo: un null tira, no sale "0,00".
  if (typeof ratio !== 'number') return ratio.toLocaleString('es-AR', BENCHMARK_RATIO_OPTIONS);
  return BENCHMARK_RATIO_FORMAT.format(Math.floor(ratio * 100 + 1e-9) / 100);
}

// Nombre en pantalla de cada nivel del backend: su "normal" (entre el corte
// de medio y el de alto) es el "medio" de la etiqueta de alcance.
const BENCHMARK_LEVEL_NAMES = { alto: 'alto', normal: 'medio', bajo: 'bajo' };

// Con qué se calculó la razón de una métrica, en palabras: "229 contra una
// mediana de 21 en la cuenta, con colchón de 2.000". La razón no es valor /
// mediana: el backend suma el colchón arriba y abajo y lo manda junto con
// ella. Va donde se muestra la razón (detalle de la tabla, tarjetas y
// pop-up), para que el número no parezca mal calculado.
function benchmarkRatioBasis(metric) {
  const basis = `${formatBenchmarkNumber(metric.value)} contra una mediana de ${formatBenchmarkNumber(metric.median)} en la cuenta`;
  return metric.cushion > 0 ? `${basis}, con colchón de ${formatBenchmarkNumber(metric.cushion)}` : basis;
}

// "sin-referencia" (guión, como lo manda el backend) -> "sinref" (la clase
// CSS de la referencia, .bn.sinref).
function benchmarkLevelClass(metric) {
  const level = (metric && metric.level) || 'sin-referencia';
  return level === 'sin-referencia' ? 'sinref' : level;
}

// <span class="bn {nivel}">{label}: <strong>{nivel}</strong> — <span
// class="v">{valor}</span>, contra una mediana de <span class="v">
// {mediana}</span> en esta cuenta (razón <span class="v">{ratio}x</span>,
// con colchón de {colchón})</span> — la estructura de bench() en
// design/monitoreo.html, más el colchón: la razón no es valor / mediana.
function buildBenchLine(label, metric) {
  const span = document.createElement('span');
  span.className = `bn ${benchmarkLevelClass(metric)}`;

  if (!metric || metric.level === 'sin-referencia') {
    // El backend dice por qué (classifyValue en src/accountStats.js): no es
    // lo mismo que falte el dato de este posteo (likes ocultos por el autor)
    // que la cuenta no tenga muestra suficiente.
    const reason = metric && metric.reason;
    span.textContent =
      reason === 'sin-dato'
        ? `${label}: sin dato (el contador está oculto o no llegó)`
        : reason === 'sin-mediana'
          ? `${label}: sin referencia (los posteos recientes de esta cuenta no traen este dato)`
          : `${label}: sin referencia (menos de 5 posteos recientes de esta cuenta)`;
    return span;
  }

  span.appendChild(document.createTextNode(`${label}: `));
  const strong = document.createElement('strong');
  strong.textContent = BENCHMARK_LEVEL_NAMES[metric.level] || metric.level;
  span.appendChild(strong);
  span.appendChild(document.createTextNode(' — '));
  const value = document.createElement('span');
  value.className = 'v';
  value.textContent = formatBenchmarkNumber(metric.value);
  span.appendChild(value);
  span.appendChild(document.createTextNode(', contra una mediana de '));
  const median = document.createElement('span');
  median.className = 'v';
  median.textContent = formatBenchmarkNumber(metric.median);
  span.appendChild(median);
  span.appendChild(document.createTextNode(' en esta cuenta (razón '));
  const ratio = document.createElement('span');
  ratio.className = 'v';
  ratio.textContent = `${formatBenchmarkRatio(metric.ratio)}x`;
  span.appendChild(ratio);
  const cushion = metric.cushion > 0 ? `, con colchón de ${formatBenchmarkNumber(metric.cushion)}` : '';
  span.appendChild(document.createTextNode(`${cushion})`));
  return span;
}

// Fecha + hora completas (24hs, no "a. m./p. m."). "N/D" si no hay fecha.
// Mismo motivo que BENCHMARK_RATIO_FORMAT: formateadores armados una vez.
const FULL_DATE_FORMAT = new Intl.DateTimeFormat('es-AR');
const FULL_TIME_FORMAT = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

function formatFullDateTime(iso) {
  if (!iso) return { date: 'N/D', time: '' };
  const d = new Date(iso);
  // Una fecha inválida hace tirar a Intl.DateTimeFormat (toLocaleDateString
  // devolvía el texto "Invalid Date"): se conserva ese resultado.
  if (Number.isNaN(d.getTime())) return { date: 'Invalid Date', time: 'Invalid Date' };
  return { date: FULL_DATE_FORMAT.format(d), time: FULL_TIME_FORMAT.format(d) };
}

// -------------------------------------------------------------------------
// Fecha de las métricas de un posteo: de cuándo son los likes y comentarios
// que se están mostrando. Es la última vez que se escribieron
// (metrics_updated_at: un refresco, o el benchmark al pasar por la cuenta);
// si el posteo nunca se refrescó, la fecha en que se detectó, porque sus
// números son los de ese momento. Con más de METRICS_STALE_DAYS días se
// avisa (stale): la tarjeta y el pop-up la muestran en naranja.
//   short: "08/10"   full: "08/10/2026 · 23:48"
// null si el posteo no trae ninguna de las dos fechas.
// -------------------------------------------------------------------------
const METRICS_STALE_DAYS = 3;

function postMetricsDate(post) {
  const iso = (post && (post.metrics_updated_at || post.detected_at)) || null;
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  // Día y mes siempre con dos dígitos ("08/10"), en la hora de este
  // navegador. A mano: el formateador de es-AR no rellena el día cuando va
  // sin el año ("8/10").
  const two = (n) => String(n).padStart(2, '0');
  const short = `${two(date.getDate())}/${two(date.getMonth() + 1)}`;
  return {
    short,
    full: `${short}/${date.getFullYear()} · ${FULL_TIME_FORMAT.format(date)}`,
    stale: Date.now() - date.getTime() > METRICS_STALE_DAYS * 24 * 60 * 60 * 1000,
  };
}

// Panel desplegable — mismo marcado que .dt en design/monitoreo.html.
function buildDetailPanel(data) {
  const wrap = document.createElement('div');
  wrap.className = 'dt';
  // Sin esto, cualquier click adentro del panel (un link, el texto) burbujea
  // hasta el rowClick de Tabulator y cierra el panel que se acaba de abrir
  // (en la referencia esto no hace falta: el detalle es un <tr> hermano, no
  // un hijo de la fila — acá Tabulator no permite esa forma).
  wrap.addEventListener('click', (e) => e.stopPropagation());

  const h4 = document.createElement('h4');
  h4.textContent = data.title || '(sin clasificar)';
  wrap.appendChild(h4);

  const cap = document.createElement('p');
  cap.className = 'dt-cap';
  cap.textContent = data.caption || '';
  wrap.appendChild(cap);

  if (!IS_X_MONITOR) {
    const bench = document.createElement('div');
    bench.className = 'dt-bench';
    const benchmark = data.benchmark || {};
    bench.appendChild(buildBenchLine('Comentarios', benchmark.comments));
    bench.appendChild(buildBenchLine('Likes', benchmark.likes));
    wrap.appendChild(bench);
  }

  const links = document.createElement('div');
  links.className = 'dt-links';
  if (data.account && data.account !== 'N/D') {
    const profile = document.createElement('a');
    profile.href = `${PROFILE_BASE}${data.account}`;
    profile.target = '_blank';
    profile.rel = 'noopener';
    profile.textContent = 'Ver perfil';
    links.appendChild(profile);
  }
  const post = document.createElement('a');
  post.href = data.url;
  post.target = '_blank';
  post.rel = 'noopener';
  post.textContent = 'Ver publicación';
  links.appendChild(post);
  wrap.appendChild(links);

  const meta = document.createElement('p');
  meta.className = 'dt-meta';
  const { date, time } = formatFullDateTime(data.posted_at);
  meta.textContent = time ? `${date} · ${time} · ${PLATFORM_LABEL}` : `${date} · ${PLATFORM_LABEL}`;
  wrap.appendChild(meta);

  return wrap;
}

// Reformatea una fila puntual si está montada en el DOM ahora mismo (podría
// no estarlo, por paginación).
function reformatRowIfMounted(id) {
  if (!monitoringTable) return;
  const row = monitoringTable.getRow(id);
  if (row && typeof row.reformat === 'function') row.reformat();
}

// Solo una fila abierta a la vez: abrir una cierra la que estuviera abierta
// (mismo criterio que el listener de "tb" en la referencia).
function toggleRowExpansion(row) {
  const id = row.getData().id;
  const previous = expandedRowId;
  expandedRowId = expandedRowId === id ? null : id;
  if (previous != null && previous !== expandedRowId) reformatRowIfMounted(previous);
  if (typeof row.reformat === 'function') row.reformat();
  else if (monitoringTable) monitoringTable.redraw(true);
}

// -------------------------------------------------------------------------
// Tarjetas destacadas ("Se despegaron"): posteos — no cuentas — con alcance
// alto según la regla del backend (src/reachRule.js: razón con colchón y
// piso por métrica), los de mayor razón primero. Acá no hay ningún corte: la
// métrica que decide y su nivel los manda el backend (benchmark.top,
// highlightOf en src/accountStats.js) entre las que tienen referencia. Un
// posteo con likes sin dato (ocultos por el autor) se destaca igual por sus
// comentarios, en vez de quedar afuera.
// -------------------------------------------------------------------------
const HIGHLIGHT_CARD_COUNT = 4;

function highlightTop(post) {
  const top = post.benchmark && post.benchmark.top;
  return top && top.level === 'alto' && Number.isFinite(top.ratio) ? top : null;
}

function renderHighlightCards(posts) {
  if (IS_X_MONITOR || !highlightsSectionEl || !cardsEl) {
    if (highlightsSectionEl) highlightsSectionEl.classList.add('hidden');
    return;
  }
  const scored = posts
    .map((post) => ({ post, top: highlightTop(post) }))
    .filter((entry) => entry.top)
    .sort((a, b) => b.top.ratio - a.top.ratio)
    .slice(0, HIGHLIGHT_CARD_COUNT);

  cardsEl.replaceChildren();
  if (highlightsCountEl) highlightsCountEl.textContent = String(scored.length);
  if (scored.length === 0) {
    highlightsSectionEl.classList.add('hidden');
    return;
  }
  highlightsSectionEl.classList.remove('hidden');
  for (const { post, top } of scored) cardsEl.appendChild(buildHighlightStrip(post, top));
}

// Hora del destacado, en hora de Argentina: "10:35" si es de hoy,
// "14/10 10:35" si no.
const HIGHLIGHT_TZ = 'America/Argentina/Buenos_Aires';
const HIGHLIGHT_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: HIGHLIGHT_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const HIGHLIGHT_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: HIGHLIGHT_TZ, day: '2-digit', month: '2-digit' });
const HIGHLIGHT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: HIGHLIGHT_TZ });

function highlightWhen(iso) {
  const date = new Date(iso);
  if (!iso || !Number.isFinite(date.getTime())) return '';
  const time = HIGHLIGHT_TIME.format(date);
  return HIGHLIGHT_DAY.format(date) === HIGHLIGHT_DAY.format(new Date()) ? time : `${HIGHLIGHT_DATE.format(date)} ${time}`;
}

// Una tira (design/social-listening-v4.html): la razón grande con su métrica, el
// título, la cuenta y la hora, el valor contra la mediana y el selector de
// sentimiento. La razón lleva colchón: no es "N veces lo habitual"; al lado
// van el valor y la mediana reales de la métrica que lo destacó. Todo dato
// del posteo entra por textContent. Las acciones (abrir, sentimiento) las
// atiende el contenedor (ver más abajo).
function buildHighlightStrip(post, top) {
  const decisive = post.benchmark[top.metric];
  const account = post.account && post.account !== 'N/D' ? `@${post.account}` : 'N/D';

  const strip = document.createElement('article');
  strip.className = post.sentiment === 'negativo' ? 'hl-strip neg' : 'hl-strip';
  strip.dataset.postId = post.id;
  strip.tabIndex = 0;
  strip.setAttribute('aria-label', `Posteo de ${account}: abrir el detalle`);

  const ratio = document.createElement('div');
  ratio.className = 'hl-strip-ratio';
  ratio.textContent = `${formatBenchmarkRatio(top.ratio)}×`;
  const ratioMetric = document.createElement('small');
  ratioMetric.textContent = `en ${top.label}`;
  ratio.appendChild(ratioMetric);
  ratio.title = `Razón de alcance: ${benchmarkRatioBasis(decisive)}`;

  const title = document.createElement('h3');
  title.className = 'hl-strip-title';
  title.textContent = post.title || '(sin clasificar)';

  const who = document.createElement('div');
  who.className = 'hl-strip-who';
  const text = document.createElement('span');
  const name = document.createElement('b');
  name.textContent = account;
  const value = document.createElement('span');
  value.className = 'mono';
  value.textContent = formatBenchmarkNumber(decisive.value);
  const median = document.createElement('span');
  median.className = 'mono';
  median.textContent = formatBenchmarkNumber(decisive.median);
  const when = highlightWhen(post.posted_at);
  text.append(name, when ? `, ${when}, ` : ', ', value, ` ${top.label} contra `, median);
  const sentiment = buildSentimentSelect(post.sentiment);
  sentiment.setAttribute('aria-label', 'Sentimiento');
  who.append(text, sentiment);

  strip.append(ratio, title, who);
  return strip;
}

// Corrige el sentimiento desde una tira: PATCH y color de la pastilla como en
// la tabla, el dato de la fila de Tabulator, y aviso a las otras vistas (el
// feed se redibuja con el color nuevo).
function highlightSetSentiment(strip, select) {
  const id = strip.dataset.postId;
  const row = monitoringTable ? monitoringTable.getRow(id) : null;
  updateSentiment(row ? row.getData().id : id, select.value, select);
  strip.classList.toggle('neg', select.value === 'negativo');
  if (row) row.update({ sentiment: select.value });
  notifyMonitoringViews();
}

// Clic en un destacado: abre el pop-up de ese posteo, solo (sin anterior ni
// siguiente), en la vista Tabla y en el Feed, y aunque un filtro lo esté
// tapando. El pop-up es de public/js/monitoringFeedPopup.js, que carga solo
// instagram.html: donde no está (x.html), o si no encuentra el posteo, queda
// lo de antes: ir a su fila.
function openHighlight(id) {
  if (typeof openFeedPopSolo === 'function' && openFeedPopSolo(id)) return;
  highlightGoToRow(id);
}

// Respaldo de openHighlight, para cuando no hay pop-up. Busca la fila en el
// conjunto activo (filtrado + ordenado) actual — igual que la referencia, no
// reinicia filtros: si el posteo está tapado por un filtro, no hace nada. A
// diferencia de la referencia (tabla plana, sin paginación), acá hay que
// ubicar en qué página de Tabulator cae.
async function highlightGoToRow(id) {
  if (!monitoringTable) return;
  // Con el Feed como vista activa (solo Instagram) la tabla está oculta: el
  // destacado lleva a la tarjeta de ese posteo.
  if (notifyMonitoringViews({ goToId: id })) return;
  const rows = monitoringTable.getRows('active');
  const idx = rows.findIndex((r) => r.getData().id === id);
  if (idx === -1) return;

  const pageSize = monitoringTable.getPageSize();
  await monitoringTable.setPage(Math.floor(idx / pageSize) + 1);

  const row = monitoringTable.getRow(id);
  if (!row) return;
  expandedRowId = id;
  row.reformat();

  const el = row.getElement();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // fuerza reflow para poder repetir la animación si ya se había disparado antes.
  el.classList.add('flash');
}

// -------------------------------------------------------------------------
// Alcance del posteo: UNA etiqueta (alto | medio | bajo) a partir de los dos
// niveles que ya manda el backend en benchmark.likes y benchmark.comments
// (classifyValue en src/accountStats.js, con la regla de src/reachRule.js:
// razón con colchón, piso para el alto, y los cortes que diga el .env). Acá
// no se recalcula nada ni se conoce ningún corte, solo se combinan. Likes y
// comentarios pesan igual y vale el mejor de los dos: alto si alguno da
// alto, bajo solo si los dos dan bajo, medio en el resto ("normal" del
// backend se muestra como "medio"; "bajo" quiere decir que el posteo no se
// despega de lo normal de su cuenta). Una métrica sin referencia (likes
// ocultos, muestra chica) no cuenta y decide la otra; si ninguna tiene
// referencia devuelve null y el posteo no lleva etiqueta de alcance.
//   by / label: la métrica que decidió la etiqueta: la de mejor nivel y, a
//               igual nivel, la de mayor razón (empate: comentarios, igual
//               que highlightOf en el backend).
//   ratio:      la razón de esa métrica, (valor + colchón) / (mediana de la
//               cuenta + colchón). Es la que se muestra al lado de la
//               etiqueta y, dentro de cada nivel, la que ordena "Mayor
//               alcance".
//   metric:     lo que mandó el backend para esa métrica (valor, mediana,
//               colchón), para poder decir con qué se calculó la razón.
// -------------------------------------------------------------------------
const REACH_RANK = { bajo: 0, normal: 1, alto: 2 };
const REACH_LEVELS = ['bajo', 'medio', 'alto'];
const REACH_METRICS = [
  { by: 'comments', label: 'comentarios' },
  { by: 'likes', label: 'likes' },
];

function postReach(post) {
  const benchmark = (post && post.benchmark) || {};
  let best = null;
  for (const { by, label } of REACH_METRICS) {
    const metric = benchmark[by];
    const rank = metric ? REACH_RANK[metric.level] : undefined;
    // "sin-referencia" (o cualquier nivel desconocido) no entra en la cuenta.
    if (typeof rank !== 'number' || !Number.isFinite(metric.ratio)) continue;
    if (!best || rank > best.rank || (rank === best.rank && metric.ratio > best.ratio)) {
      best = { rank, by, label, ratio: metric.ratio, metric };
    }
  }
  if (!best) return null;
  return { level: REACH_LEVELS[best.rank], by: best.by, label: best.label, ratio: best.ratio, metric: best.metric };
}

// El alcance a la vista: medidor de cinco barras con su nivel
// (design/social-listening-v4.html). En "alto" las cinco laten en el color
// de acento, en "medio" van tres en ámbar, en "bajo" quedan grises
// (.reach-meter en styles.css; en la maqueta se llama .reach, que acá ya es
// una etiqueta del pop-up). Sin referencia: "—". Lo usan la columna "Alcance" de la tabla y el
// pie de la tarjeta del feed. "reach" es lo que devuelve postReach.
const REACH_TITLES = { alto: 'Alto', medio: 'Medio', bajo: 'Bajo' };

function buildReachMeter(reach) {
  const cell = document.createElement('span');
  cell.className = 'reach-cell';
  if (!reach) {
    cell.textContent = '—';
    cell.title = 'Sin referencia de su cuenta';
    return cell;
  }
  const meter = document.createElement('span');
  meter.className = `reach-meter ${reach.level}`;
  meter.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) meter.appendChild(document.createElement('i'));
  cell.append(meter, REACH_TITLES[reach.level]);
  cell.title = `Alcance ${reach.level}: razón ${formatBenchmarkRatio(reach.ratio)} en ${reach.label} (${benchmarkRatioBasis(reach.metric)})`;
  return cell;
}

// Para ordenar la columna "Alcance": primero el nivel, dentro de cada nivel
// la razón; sin referencia, al final.
function reachSortValue(post) {
  const reach = postReach(post);
  return reach ? REACH_LEVELS.indexOf(reach.level) * 1e6 + reach.ratio : -1;
}

// -------------------------------------------------------------------------
// Período de la solapa (instagram.html): Hoy, 7 días o 30 días, por la
// fecha de publicación (posted_at) en hora de Argentina. "Hoy" arranca a las
// 00:00 de hoy; "7 días", a las 00:00 de seis días antes (hoy y los seis
// anteriores). Filtra todo lo de la solapa: los KPI, las fuentes, el flujo,
// "Se despegaron" y la lista (va dentro de postMatchesFilters). Se recuerda
// en el navegador; sin nada guardado, "Hoy". En x.html no hay período
// (monitorPeriodDays 0) y no se filtra nada por acá.
// -------------------------------------------------------------------------
const PERIOD_KEY = 'sl.monitoreo.periodo';
const PERIOD_OPTIONS = [1, 7, 30];
const DAY_MS = 24 * 60 * 60 * 1000;
const AR_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

function readSavedPeriod() {
  try {
    const saved = Number(window.localStorage.getItem(PERIOD_KEY));
    return PERIOD_OPTIONS.includes(saved) ? saved : 1;
  } catch (err) {
    return 1;
  }
}

let monitorPeriodDays = periodSegEl ? readSavedPeriod() : 0;

// Las 00:00 en Argentina del día que está "days - 1" días antes de "now".
// Argentina no tiene horario de verano desde 2009: siempre UTC−3, y restar
// días enteros de 24 h da otra medianoche.
function argentinaDayStart(now, daysBack = 0) {
  return Date.parse(`${AR_DAY.format(new Date(now))}T00:00:00-03:00`) - daysBack * DAY_MS;
}

// Desde cuándo cuenta el período elegido (ms), o null si no hay período.
function monitorPeriodStart(now = Date.now()) {
  return monitorPeriodDays ? argentinaDayStart(now, monitorPeriodDays - 1) : null;
}

// El período en palabras: "hoy", "7 días", "30 días".
function monitorPeriodLabel(days = monitorPeriodDays) {
  return days === 1 ? 'hoy' : `${days} días`;
}

function postPostedMs(post) {
  const ms = post && post.posted_at ? Date.parse(post.posted_at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// ¿El posteo es del período? Sin fecha de publicación no es de ninguno.
function postInPeriod(post, from = monitorPeriodStart()) {
  if (from === null) return true;
  const ms = postPostedMs(post);
  return ms !== null && ms >= from;
}

// Los posteos del período, de todos los cargados (sin los demás filtros).
function monitorPeriodPosts() {
  if (!monitoringTable) return [];
  const from = monitorPeriodStart();
  return monitoringTable.getData().filter((post) => postInPeriod(post, from));
}

function paintPeriodSeg() {
  if (!periodSegEl) return;
  for (const button of periodSegEl.querySelectorAll('button[data-days]')) {
    const on = Number(button.dataset.days) === monitorPeriodDays;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
}

function setMonitorPeriod(days) {
  if (!periodSegEl || !PERIOD_OPTIONS.includes(days) || days === monitorPeriodDays) return;
  monitorPeriodDays = days;
  try {
    window.localStorage.setItem(PERIOD_KEY, String(days));
  } catch (err) {
    // Sin almacenamiento el período igual cambia; solo no queda guardado.
  }
  paintPeriodSeg();
  applyFilters();
  if (monitoringTable) renderHighlightCards(monitoringTable.getData());
}

// La línea de "no hay nada" de la lista (feed y tabla) y del flujo. Si el
// período no tiene ninguna publicación, lo dice con un enlace al período
// siguiente: "Todavía no hay publicaciones de hoy · ver 7 días". Si las hay
// pero los filtros las tapan, "No hay publicaciones con esos filtros.";
// "filtered" false: el que pregunta no filtra (el flujo).
function buildEmptyListLine({ filtered = true } = {}) {
  const line = document.createElement('span');
  const total = monitoringTable ? monitoringTable.getDataCount() : 0;
  if (!total) {
    line.textContent = 'Todavía no se detectó ningún posteo.';
    return line;
  }
  const inPeriod = monitorPeriodDays ? monitorPeriodPosts().length : total;
  if (inPeriod > 0) {
    line.textContent = filtered ? 'No hay publicaciones con esos filtros.' : 'No hay publicaciones para mostrar.';
    return line;
  }
  const next = PERIOD_OPTIONS[PERIOD_OPTIONS.indexOf(monitorPeriodDays) + 1];
  line.textContent =
    monitorPeriodDays === 1 ? 'Todavía no hay publicaciones de hoy' : `No hay publicaciones en los últimos ${monitorPeriodDays} días`;
  if (next) {
    line.append(' · ');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link-btn';
    link.textContent = `ver ${next} días`;
    link.addEventListener('click', () => setMonitorPeriod(next));
    line.appendChild(link);
  }
  return line;
}

// -------------------------------------------------------------------------
// Filtros (barra "Filtrar"). La tabla se ordena cliqueando el header de
// cada columna — flechas asc/desc de Tabulator, no una fila "Ordenar"; el
// feed, con el selector "Orden".
// -------------------------------------------------------------------------
function normalizeSearch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
}

// Cuenta seleccionada en el dropdown a medida (ver fAccBtnEl/fAccPanelEl más
// abajo) — reemplaza a fAccEl.value de un <select> nativo.
let fAccValue = '';

// Filtro por fuente: { kind: 'search' | 'keyword', term } o null. Lo pone un
// clic en un chip de las cajas de fuentes (setSourceFilter, desde
// monitoringPanel.js). "search": los posteos que trajo esa búsqueda
// (matched_reason "Búsqueda: <término>"); "keyword": los que tienen esa
// palabra o hashtag escrita en el título o el texto.
let monitorSourceFilter = null;

function sourceFilterKey(source) {
  return source ? `${source.kind}:${normalizeSearch(source.term)}` : '';
}

function setSourceFilter(source) {
  monitorSourceFilter = source && source.term ? { kind: source.kind === 'search' ? 'search' : 'keyword', term: source.term } : null;
  applyFilters();
}

// ¿El posteo vino por esa fuente? Ver monitorSourceFilter.
function postMatchesSource(post, source) {
  const term = normalizeSearch(source.term).trim();
  if (!term) return true;
  if (source.kind === 'search') {
    const reason = postReasonParts(post.matched_reason);
    return reason.text === 'búsqueda' && normalizeSearch(reason.term).trim() === term;
  }
  return normalizeSearch(`${post.title || ''} ${post.caption || ''}`).includes(term);
}

const DEFAULT_ORDER = 'recent';

function isDefaultFilterState() {
  return (
    !fSentEl.value &&
    !(fAlcanceEl && fAlcanceEl.value) &&
    !(fTemaEl && fTemaEl.value) &&
    !(fOrdenEl && fOrdenEl.value !== DEFAULT_ORDER) &&
    !fAccValue &&
    !monitorSourceFilter &&
    !fDesdeEl.value &&
    !fHastaEl.value &&
    !qEl.value.trim()
  );
}

// "Limpiar": deshabilitado sin nada que limpiar; en instagram.html, además,
// invisible (sigue ocupando su lugar, así la línea no salta).
function updateMonitoringClearButtonState() {
  const clean = isDefaultFilterState();
  monitoringClearBtn.disabled = clean;
  if (fSourceEl) monitoringClearBtn.classList.toggle('on', !clean);
}

// "Mostrando N de M": N, lo que deja ver la barra; M, todas las del período
// (en x.html, todas las cargadas).
function updateCounts() {
  if (!monitoringTable) return;
  nEl.textContent = monitoringTable.getDataCount('active');
  mEl.textContent = monitorPeriodDays ? monitorPeriodPosts().length : monitoringTable.getDataCount();
}

// La pastilla del filtro por fuente, con su ✕ (solo instagram.html).
function renderSourcePill() {
  if (!fSourceEl) return;
  fSourceEl.replaceChildren();
  fSourceEl.classList.toggle('hidden', !monitorSourceFilter);
  if (!monitorSourceFilter) return;
  const label = document.createElement('span');
  label.textContent = monitorSourceFilter.kind === 'search' ? 'búsqueda ' : 'contiene ';
  const term = document.createElement('code');
  term.textContent = monitorSourceFilter.term;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Sacar el filtro por fuente');
  close.addEventListener('click', () => setSourceFilter(null));
  fSourceEl.append(label, term, close);
}

// Vistas extra sobre los mismos posteos y los mismos filtros que la tabla:
// en Instagram, el Feed (public/js/monitoringFeed.js), el pop-up, el panel
// de arriba (KPI, fuentes, pulso, pipeline, alertas: monitoringPanel.js) y
// el flujo en vivo (monitoringFlow.js); en las dos páginas, la barra
// superior (topbar.js). Se anotan acá y se les avisa de cada cambio. Sin
// ninguna anotada no pasa nada. "change" dice qué pasó:
//   (nada)         cambiaron los datos, los filtros o el período: hay que
//                  redibujar.
//   { ignoredId }  se ignoró ese posteo (ya salió de la tabla).
//   { goToId }     hay que mostrar ese posteo (respaldo de "Se despegaron").
//                  La vista que esté activa devuelve true y se hace cargo;
//                  si ninguna lo hace, lo muestra la tabla.
//   { config }     llegó la config de fuentes (null si falló).
//   { run: 'start' }           arrancó "Actualizar ahora".
//   { run: 'end', newIds }     terminó (bien o mal); newIds, los posteos que
//                  no estaban antes. Los usan la barra superior
//                  (topbar.js) y el panel para releer la última corrida, y
//                  el flujo para hacerlos entrar de a uno.
const monitoringViewListeners = [];

function notifyMonitoringViews(change) {
  let handled = false;
  for (const listener of monitoringViewListeners) {
    if (listener(change) === true) handled = true;
  }
  return handled;
}

// Valores actuales de la barra "Filtrar", con el período y la fuente.
function readFilterValues() {
  return {
    sentiment: fSentEl.value,
    reach: fAlcanceEl ? fAlcanceEl.value : '', // "" | alto | medio | bajo
    tema: fTemaEl ? fTemaEl.value : '',
    account: fAccValue,
    desde: fDesdeEl.value, // "YYYY-MM-DD" del <input type="date"> o ""
    hasta: fHastaEl.value,
    q: normalizeSearch(qEl.value.trim()),
    periodFrom: monitorPeriodStart(), // ms, o null sin período (x.html)
    source: monitorSourceFilter,
  };
}

// La condición de la barra "Filtrar" sobre un posteo, separada de Tabulator:
// la tabla y la vista Feed de Instagram filtran con esta misma función, así
// las dos muestran siempre el mismo conjunto. "filters" es lo que devuelve
// readFilterValues().
function postMatchesFilters(data, filters) {
  const { sentiment, reach, tema, account, desde, hasta, q, periodFrom, source } = filters;
  if (periodFrom != null && !postInPeriod(data, periodFrom)) return false;
  // "sin_clasificar" no es un valor guardado: es la ausencia de valor.
  if (sentiment === SENTIMENT_UNSET) {
    if (data.sentiment) return false;
  } else if (sentiment && data.sentiment !== sentiment) {
    return false;
  }
  if (tema && data.tema !== tema) return false;
  if (account && data.account !== account) return false;
  if (source && !postMatchesSource(data, source)) return false;
  // Alcance: la etiqueta de postReach. Un posteo sin etiqueta (ninguna de sus
  // dos métricas tiene referencia) no entra en ninguno de los tres niveles.
  if (reach) {
    const postLevel = postReach(data);
    if (!postLevel || postLevel.level !== reach) return false;
  }
  if (desde || hasta) {
    if (!data.posted_at) return false;
    const posted = new Date(data.posted_at);
    if (desde && posted < new Date(`${desde}T00:00:00`)) return false;
    if (hasta && posted > new Date(`${hasta}T23:59:59.999`)) return false;
  }
  if (q) {
    const haystack = normalizeSearch(`${data.title || ''} ${data.account || ''} ${data.caption || ''}`);
    if (!haystack.includes(q)) return false;
  }
  return true;
}

// La placa de "no hay nada" de la tabla (placeholder de Tabulator): el
// mismo texto que la del feed (buildEmptyListLine), al día con el período y
// los filtros.
const tablePlaceholderEl = document.createElement('div');
tablePlaceholderEl.className = 'tbl-empty';

function applyFilters() {
  if (!monitoringTable) return;
  const filters = readFilterValues();

  monitoringTable.setFilter((data) => postMatchesFilters(data, filters));

  fSentEl.classList.toggle('on', !!filters.sentiment);
  if (fAlcanceEl) fAlcanceEl.classList.toggle('on', !!filters.reach);
  if (fTemaEl) fTemaEl.classList.toggle('on', !!filters.tema);
  fAccBtnEl.classList.toggle('on', !!filters.account);
  fDesdeEl.classList.toggle('on', !!filters.desde);
  fHastaEl.classList.toggle('on', !!filters.hasta);
  tablePlaceholderEl.replaceChildren(buildEmptyListLine());

  updateCounts();
  renderSourcePill();
  updateMonitoringClearButtonState();
  notifyMonitoringViews();
}

// -------------------------------------------------------------------------
// Dropdown de Cuenta a medida (botón + panel propio, no un <select> nativo:
// con ~70 opciones el navegador puede abrirlo hacia arriba). Selección
// única, se cierra solo al elegir, clickear afuera o Escape.
//   - Instagram (HAS_ACC_COMBO, el combo de la maqueta): el panel cuelga del
//     botón, con un buscador y, por cuenta, cuántas publicaciones tiene en
//     el período. Se arma al abrirlo, con los datos de ese momento.
//   - X: la lista simple de siempre, armada al cargar los datos. La barra
//     de X tiene overflow:hidden, así que el panel se muda a <body> y se
//     posiciona a mano en cada apertura.
// -------------------------------------------------------------------------
let accPanelMovedToBody = false;

function positionAccPanel() {
  const rect = fAccBtnEl.getBoundingClientRect();
  fAccPanelEl.style.top = `${rect.bottom + 6}px`;
  fAccPanelEl.style.left = `${rect.left}px`;
  fAccPanelEl.style.minWidth = `${rect.width}px`;
}

function closeAccPanel() {
  if (fAccPanelEl.classList.contains('hidden')) return;
  fAccPanelEl.classList.add('hidden');
  fAccBtnEl.setAttribute('aria-expanded', 'false');
}

function openAccPanel() {
  if (HAS_ACC_COMBO) {
    fAccQEl.value = '';
    drawAccountCombo();
  } else {
    if (!accPanelMovedToBody) {
      document.body.appendChild(fAccPanelEl);
      accPanelMovedToBody = true;
    }
    positionAccPanel();
  }
  fAccPanelEl.classList.remove('hidden');
  fAccBtnEl.setAttribute('aria-expanded', 'true');
  if (HAS_ACC_COMBO) fAccQEl.focus();
}

function setAccountLabel(label) {
  if (HAS_ACC_COMBO) fAccTextEl.textContent = label;
  else fAccBtnEl.textContent = label;
}

const ACC_ALL_LABEL = HAS_ACC_COMBO ? 'Todas' : 'Cuenta';

function selectAccount(value, label) {
  fAccValue = value;
  setAccountLabel(label);
  closeAccPanel();
  if (HAS_ACC_COMBO) fAccBtnEl.focus();
  applyFilters();
}

// Una opción del combo de Instagram: inicial con el color de la cuenta,
// "@cuenta" y la cantidad de publicaciones del período.
function buildAccountComboOption(value, label, count) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', String(value === fAccValue));
  if (value === fAccValue) btn.classList.add('on');
  const av = document.createElement('span');
  av.className = 'av';
  av.setAttribute('aria-hidden', 'true');
  av.textContent = value ? value[0].toUpperCase() : '∗';
  av.style.background = value ? accountColor(value) : 'var(--line2)';
  const name = document.createElement('span');
  name.className = 'nm';
  name.textContent = label;
  const n = document.createElement('small');
  n.textContent = String(count);
  btn.append(av, name, n);
  btn.addEventListener('click', () => selectAccount(value, value ? `@${value}` : ACC_ALL_LABEL));
  return btn;
}

function drawAccountCombo() {
  const query = normalizeSearch(fAccQEl.value.trim()).replace(/^@/, '');
  const posts = monitorPeriodPosts();
  const counts = new Map();
  for (const post of posts) {
    if (!post.account || post.account === 'N/D') continue;
    counts.set(post.account, (counts.get(post.account) || 0) + 1);
  }
  // Todas las cuentas de lo cargado, aunque no tengan nada en el período
  // (con 0), las de más publicaciones primero.
  const all = monitoringTable ? monitoringTable.getData() : [];
  for (const post of all) {
    if (post.account && post.account !== 'N/D' && !counts.has(post.account)) counts.set(post.account, 0);
  }
  const accounts = [...counts.entries()]
    .filter(([account]) => !query || normalizeSearch(account).includes(query))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
  const options = accounts.map(([account, count]) => buildAccountComboOption(account, `@${account}`, count));
  if (!query) options.unshift(buildAccountComboOption('', 'Todas las cuentas', posts.length));
  if (!options.length) {
    const none = document.createElement('p');
    none.className = 'combo-none';
    none.textContent = 'Ninguna cuenta con ese nombre.';
    options.push(none);
  }
  fAccListEl.replaceChildren(...options);
}

fAccBtnEl.addEventListener('click', () => {
  if (fAccPanelEl.classList.contains('hidden')) openAccPanel();
  else closeAccPanel();
});
if (HAS_ACC_COMBO) {
  fAccQEl.addEventListener('input', drawAccountCombo);
  // Enter en el buscador elige la primera cuenta de la lista; ↓ baja a ella.
  fAccQEl.addEventListener('keydown', (e) => {
    const first = fAccListEl.querySelector('button');
    if (!first) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      first.click();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      first.focus();
    }
  });
  fAccListEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...fAccListEl.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) fAccQEl.focus();
    else (buttons[i + (e.key === 'ArrowDown' ? 1 : -1)] || buttons[i]).focus();
  });
}
document.addEventListener('click', (e) => {
  if (!fAccPanelEl.classList.contains('hidden') && !fAccBtnEl.contains(e.target) && !fAccPanelEl.contains(e.target)) {
    closeAccPanel();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || fAccPanelEl.classList.contains('hidden')) return;
  const inside = fAccPanelEl.contains(document.activeElement);
  closeAccPanel();
  if (inside) fAccBtnEl.focus();
});
// X: el panel va en fixed, no relativo a un ancestro: si se scrollea con el
// panel abierto se desalinearía del botón. Más simple y predecible cerrarlo,
// mismo comportamiento que un <select> nativo (también se cierra al
// scrollear). El de Instagram cuelga del botón y se mueve con él.
if (!HAS_ACC_COMBO) {
  window.addEventListener('scroll', () => closeAccPanel(), true);
  window.addEventListener('resize', () => closeAccPanel());
}

// Reconstruye el panel de Cuenta con las cuentas presentes en los datos
// cargados (X; el combo de Instagram se arma al abrirlo). Si la cuenta
// elegida ya no está, vuelve a "Todas".
function ensureAccountFilterOptions(posts) {
  if (HAS_ACC_COMBO) {
    if (fAccValue && !posts.some((post) => post.account === fAccValue)) {
      fAccValue = '';
      setAccountLabel(ACC_ALL_LABEL);
    }
    return;
  }
  const previous = fAccValue;
  const accounts = [...new Set(posts.map((p) => p.account).filter((a) => a && a !== 'N/D'))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
  const stillValid = accounts.includes(previous);

  fAccPanelEl.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `acc-select-option${stillValid ? '' : ' sel'}`;
  allBtn.textContent = 'Cuenta';
  allBtn.addEventListener('click', () => selectAccount('', 'Cuenta'));
  fAccPanelEl.appendChild(allBtn);

  for (const account of accounts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `acc-select-option${account === previous ? ' sel' : ''}`;
    btn.textContent = `@${account}`;
    btn.addEventListener('click', () => selectAccount(account, `@${account}`));
    fAccPanelEl.appendChild(btn);
  }

  if (!stillValid) {
    fAccValue = '';
    fAccBtnEl.textContent = 'Cuenta';
  }
}

// "Limpiar" resetea los filtros a blanco y el orden del feed a "Más
// recientes"; el período no es un filtro y queda como está. El orden de la
// tabla queda en sus headers.
function resetFilters() {
  fSentEl.value = '';
  if (fAlcanceEl) fAlcanceEl.value = '';
  if (fTemaEl) fTemaEl.value = '';
  if (fOrdenEl) fOrdenEl.value = DEFAULT_ORDER;
  monitorSourceFilter = null;
  fAccValue = '';
  setAccountLabel(ACC_ALL_LABEL);
  fAccBtnEl.classList.remove('on');
  fDesdeEl.value = '';
  fHastaEl.value = '';
  fDesdeEl.classList.remove('on');
  fHastaEl.classList.remove('on');
  qEl.value = '';
  applyFilters();
}

// Par de flechas asc/desc que Tabulator pinta en cada header sortable.
// El color activo lo decide el CSS según aria-sort del header.
const SORT_ARROWS =
  '<span class="sort-ind" aria-hidden="true"><span class="sort-up"></span><span class="sort-down"></span></span>';

const MONITORING_COLUMNS = [
  {
    // Puramente visual: el toggle real es rowClick sobre toda la fila (ver
    // ensureMonitoringTable) — clickear en cualquier parte de la fila abre
    // el detalle, como en la referencia. La rotación la maneja el CSS a
    // partir de la clase "on" que pone rowFormatter en la fila.
    title: '',
    field: 'expand',
    headerSort: false,
    hozAlign: 'center',
    // 48px, no 34: es el mínimo real para que el contenido (.chev de
    // 22x22px + los 13px de padding horizontal de .tabulator-cell a cada
    // lado = 48px) entre sin desbordar. Con menos, el CSS base de Tabulator
    // (.tabulator-cell{overflow:hidden;text-overflow:ellipsis;white-space:
    // nowrap}, no algo que hayamos agregado nosotros) recorta el chevron y
    // muestra los puntos suspensivos — comprobado en vivo con
    // cell.scrollWidth vs cell.clientWidth. minWidth repite el mismo valor
    // porque el default de Tabulator (40px) por sí solo tampoco alcanza.
    width: 48,
    minWidth: 48,
    formatter: () =>
      '<span class="chev"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg></span>',
  },
  {
    title: 'Cuenta',
    field: 'account',
    // Cuenta y Título se reparten lo que dejan las columnas fijas. Con un
    // ancho mínimo, en una pantalla angosta la tabla se desplaza de costado
    // en vez de dejarlas sin texto.
    minWidth: 120,
    formatter: (cell) => {
      const account = cell.getValue();
      if (!account || account === 'N/D') return 'N/D';
      const a = document.createElement('a');
      a.className = 'c-acc';
      a.href = `${PROFILE_BASE}${account}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `@${account}`;
      a.addEventListener('click', (e) => e.stopPropagation());
      return a;
    },
  },
  {
    title: 'Seguidores',
    field: 'followers',
    width: 118,
    hozAlign: 'right',
    headerHozAlign: 'right',
    sorter: 'number',
    headerSortStartingDir: 'desc',
    formatter: (cell) => `<span class="c-num">${formatFollowers(cell.getValue())}</span>`,
  },
  {
    title: 'Título',
    field: 'title',
    cssClass: 'c-title-cell',
    // El título completo va en el panel desplegable — acá solo una vista
    // previa recortada con puntos suspensivos (mismo max-width que .c-title
    // en la referencia).
    widthGrow: 2,
    minWidth: 200,
    formatter: (cell) => {
      const title = cell.getValue() || '(sin clasificar)';
      const span = document.createElement('span');
      span.className = 'c-title';
      span.title = title;
      span.textContent = title;
      return span;
    },
  },
  {
    title: 'Sentimiento',
    field: 'sentiment',
    width: 156,
    hozAlign: 'center',
    headerHozAlign: 'left',
    formatter: (cell) => {
      const id = cell.getRow().getData().id;
      const select = buildSentimentSelect(cell.getValue());
      select.addEventListener('click', (e) => e.stopPropagation());
      select.addEventListener('change', () => {
        if (select.value === SENTIMENT_UNSET) return;
        updateSentiment(id, select.value, select);
        // También el dato de la fila en Tabulator: desplegar o replegar la
        // fila re-corre este formatter desde row.getData(), y sin esto el
        // select se volvía a armar con el valor viejo (el PATCH ya se había
        // guardado bien; solo la tabla quedaba atrás). row.update re-corre
        // el rowFormatter, así el panel abierto también queda al día.
        cell.getRow().update({ sentiment: select.value });
        if (monitoringTable) renderHighlightCards(monitoringTable.getData());
        // El panel (tono de las fuentes, KPI) y el flujo, al día.
        notifyMonitoringViews();
      });
      return select;
    },
  },
  {
    title: 'Fecha',
    field: 'posted_at',
    width: 118,
    hozAlign: 'center',
    headerHozAlign: 'left',
    // Las fechas se guardan en ISO 8601: ese formato ordena bien como texto
    // plano, sin necesitar un parser de fechas aparte para esta columna.
    sorter: 'string',
    headerSortStartingDir: 'desc',
    formatter: (cell) => {
      const row = cell.getRow().getData();
      const span = document.createElement('span');
      span.className = 'c-date';
      span.textContent = cell.getValue() ? new Date(cell.getValue()).toLocaleDateString('es-AR') : 'N/D';
      span.title = `Detectado: ${new Date(row.detected_at).toLocaleString('es-AR')}`;
      return span;
    },
  },
  {
    title: 'Likes',
    field: 'likes',
    width: 100,
    hozAlign: 'right',
    headerHozAlign: 'right',
    sorter: 'number',
    headerSortStartingDir: 'desc',
    formatter: (cell) => `<span class="c-num">${formatCount(cell.getValue())}</span>`,
  },
  {
    title: 'Coment.',
    field: 'comments',
    width: 108,
    hozAlign: 'right',
    headerHozAlign: 'right',
    sorter: 'number',
    headerSortStartingDir: 'desc',
    formatter: (cell) => `<span class="c-num">${formatCount(cell.getValue())}</span>`,
  },
  {
    // El alcance contra lo habitual de su cuenta, con el medidor (solo
    // Instagram: X no tiene benchmark; se saca más abajo). 108 de ancho para
    // que el encabezado entre entero con la flecha de orden.
    title: 'Alcance',
    field: 'benchmark',
    width: 108,
    headerSortStartingDir: 'desc',
    sorter: (a, b, aRow, bRow) => reachSortValue(aRow.getData()) - reachSortValue(bRow.getData()),
    formatter: (cell) => buildReachMeter(postReach(cell.getRow().getData())),
  },
  {
    title: '',
    field: 'id',
    headerSort: false,
    hozAlign: 'right',
    width: 56,
    formatter: (cell) => {
      const id = cell.getRow().getData().id;
      const btn = document.createElement('button');
      btn.className = 'ico del';
      btn.title = 'Ignorar publicación';
      btn.setAttribute('aria-label', 'Ignorar publicación');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openIgnoreModal(id);
      });
      return btn;
    },
  },
];

if (IS_X_MONITOR) {
  const followersIdx = MONITORING_COLUMNS.findIndex((col) => col.field === 'followers');
  if (followersIdx !== -1) MONITORING_COLUMNS.splice(followersIdx, 1);
  const reachIdx = MONITORING_COLUMNS.findIndex((col) => col.field === 'benchmark');
  if (reachIdx !== -1) MONITORING_COLUMNS.splice(reachIdx, 1);
  const commentsCol = MONITORING_COLUMNS.find((col) => col.field === 'comments');
  if (commentsCol) commentsCol.title = 'Resp.';
  const commentsIdx = MONITORING_COLUMNS.findIndex((col) => col.field === 'comments');
  if (commentsIdx !== -1) {
    MONITORING_COLUMNS.splice(
      commentsIdx + 1,
      0,
      {
        title: 'RTs',
        field: 'retweets',
        width: 90,
        hozAlign: 'right',
        headerHozAlign: 'right',
        sorter: 'number',
        headerSortStartingDir: 'desc',
        formatter: (cell) => `<span class="c-num">${formatCount(cell.getValue())}</span>`,
      },
      {
        title: 'Vistas',
        field: 'views',
        width: 100,
        hozAlign: 'right',
        headerHozAlign: 'right',
        sorter: 'number',
        headerSortStartingDir: 'desc',
        formatter: (cell) => `<span class="c-num">${formatCount(cell.getValue())}</span>`,
      }
    );
  }
}

let monitoringTable = null;

function ensureMonitoringTable(posts) {
  ensureAccountFilterOptions(posts);

  if (monitoringTable) {
    monitoringTable.setData(posts).then(() => {
      applyFilters();
    });
    return;
  }

  monitoringTable = new Tabulator('#monitoringTable', {
    data: posts,
    index: 'id',
    layout: 'fitColumns',
    columns: MONITORING_COLUMNS,
    headerSortElement: SORT_ARROWS,
    // Mismo default que tenía el select "Likes ↓": mayor a menor al entrar.
    initialSort: [{ column: 'likes', dir: 'desc' }],
    rowFormatter: (row) => {
      const data = row.getData();
      const el = row.getElement();
      // El id del posteo en la fila, para ubicarla desde otras vistas.
      el.dataset.postId = data.id;
      const isOpen = expandedRowId === data.id;
      el.classList.toggle('on', isOpen);
      const existingPanel = el.querySelector('.dt');
      if (isOpen) {
        const freshPanel = buildDetailPanel(data);
        if (existingPanel) existingPanel.replaceWith(freshPanel);
        else el.appendChild(freshPanel);
      } else if (existingPanel) {
        existingPanel.remove();
      }
    },
    pagination: true,
    paginationSize: 20,
    paginationSizeSelector: [10, 20, 50, 100],
    // Un nodo propio y no un texto: applyFilters lo tiene al día (período
    // sin publicaciones, filtros que tapan todo).
    placeholder: tablePlaceholderEl,
    // Tabulator viene en inglés; traducimos solo el label del selector de
    // tamaño de página (lo demás no se pidió tocar).
    locale: 'es-ar',
    langs: {
      'es-ar': {
        pagination: { page_size: 'Filas por página' },
      },
    },
  });
  monitoringTable.on('pageLoaded', updateCounts);
  monitoringTable.on('tableBuilt', () => {
    applyFilters();
  });
  // rowClick pasado en el constructor no se conecta en esta build de
  // Tabulator 6.3.0 (comprobado en vivo) — .on() después de construir la
  // tabla sí funciona. Clickear en cualquier parte de la fila abre/cierra
  // su detalle (igual que la referencia); los controles interactivos de
  // adentro (links, ignorar, sentimiento) cortan la propagación en su propio
  // formatter.
  monitoringTable.on('rowClick', (e, row) => toggleRowExpansion(row));
}

// @returns {Promise<object[]|null>} los posteos que llegaron, o null si falló.
async function loadPosts() {
  try {
    const resp = await fetch(withPlataforma(`/api/monitoring/posts?page=1&pageSize=${FETCH_ALL_PAGE_SIZE}`));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    monitoringLoadErrorEl.classList.add('hidden');
    const posts = (data.posts || []).filter(
      (post) => (post.plataforma || 'instagram') === MONITOR_PLATFORM
    );
    ensureMonitoringTable(posts);
    renderHighlightCards(posts);
    return posts;
  } catch (err) {
    monitoringLoadErrorEl.textContent = 'No se pudo cargar la tabla. Reiniciá el servidor (para que tome el código nuevo) y recargá la página.';
    monitoringLoadErrorEl.classList.remove('hidden');
    console.error('Error cargando posteos detectados:', err);
    return null;
  }
}

// Hora real de la próxima corrida (el backend calcula desde MONITOR_CRON) —
// nunca una hora inventada. Si falla, queda el placeholder "–".
async function loadNextRun() {
  if (!monitoringNextRunEl) return;
  try {
    const resp = await fetch('/api/monitoring/status');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const time = new Date(data.nextRunAt).toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    monitoringNextRunEl.textContent = `próxima corrida ${time}`;
  } catch (err) {
    console.error('Error cargando la próxima corrida:', err);
  }
}

// --------------------------------------------------------------------
// Progreso real del ciclo (GET /api/monitoring/progress, ver getView en
// src/monitoringProgress.js): mientras "Actualizar ahora" está en curso, se
// consulta cada PROGRESS_POLL_MS y se dibuja lo que manda el backend:
//   - arriba, la fase con su contador ("Buscando posteos nuevos · 5 de 8
//     listas");
//   - la barra, con el porcentaje real;
//   - debajo, las últimas líneas del ciclo, que ya vienen escritas y
//     elegidas (qué búsqueda terminó y con cuántos nuevos, cuál falló, cuáles
//     siguen en curso, el resumen de cada fase). Acá no se arma ni se recorta
//     ninguna: solo se dibujan.
// null (el ciclo todavía no arrancó su primera fase) deja todo como estaba,
// no lo pisa con nada inventado. Al terminar, el recuadro queda a la vista
// con el resultado hasta que se aprieta "Ocultar" o se lanza otro ciclo.
// --------------------------------------------------------------------
const PROGRESS_POLL_MS = 1500;
let progressPollTimer = null;
// ¿Se está esperando un ciclo? Una respuesta del progreso que llega tarde,
// con el resultado ya dibujado, no tiene que pisarlo.
let progressWaiting = false;
// ¿Ya se vio avanzar ESTE ciclo? Antes de eso, un "terminado" que mande el
// backend es el cierre del ciclo anterior (el nuevo todavía no arrancó).
let progressSeenRunning = false;
// Las últimas líneas dibujadas, para no rehacer la lista si no cambió (al
// rehacerla, las rueditas de lo que está en curso vuelven a empezar).
let progressLinesDrawn = '';

const PROGRESS_LINE_ICONS = { ok: '✓', err: '✕', run: '' };

// Cada línea: ícono (✓, ✕ o la ruedita de "en curso"), de qué se trata y
// cómo salió. Todo entra por textContent: los términos de búsqueda y las
// cuentas los escribe el usuario.
function drawProgressLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const key = JSON.stringify(list);
  if (key === progressLinesDrawn) return;
  progressLinesDrawn = key;
  monitoringProgressListEl.replaceChildren(
    ...list.map((line) => {
      const state = Object.prototype.hasOwnProperty.call(PROGRESS_LINE_ICONS, line.state) ? line.state : 'ok';
      const li = document.createElement('li');
      li.className = state;
      const icon = document.createElement('span');
      icon.className = 'i';
      icon.textContent = PROGRESS_LINE_ICONS[state];
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 't';
      label.textContent = line.label || '';
      const detail = document.createElement('span');
      detail.className = 'd';
      detail.textContent = line.detail || '';
      li.append(icon, label, detail);
      // Para un lector de pantalla, el estado va en palabras.
      if (state !== 'ok') li.setAttribute('aria-label', `${state === 'err' ? 'Falló' : 'En curso'}: ${label.textContent} · ${detail.textContent}`);
      return li;
    })
  );
}

function setProgressHead(text, counter = '') {
  monitoringStatusTextEl.textContent = text;
  monitoringStatusCountEl.textContent = counter;
}

// La barra y, donde está, el porcentaje grande: el mismo número real.
function setProgressPercent(percent) {
  monitoringProgressFillEl.style.width = `${percent}%`;
  if (monitoringProgressPctEl) monitoringProgressPctEl.textContent = `${percent}%`;
}

async function pollMonitorProgress() {
  try {
    const resp = await fetch(withPlataforma('/api/monitoring/progress'));
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data || !progressWaiting) return;
    if (data.finished) {
      // El ciclo ya terminó y la respuesta de "Actualizar ahora" todavía no
      // llegó: van quedando sus líneas completas.
      if (progressSeenRunning) drawProgressLines(data.lines);
      return;
    }
    progressSeenRunning = true;
    setProgressHead(data.phase, `${data.done} de ${data.total}${data.suffix ? ` ${data.suffix}` : ''}`);
    setProgressPercent(data.percent);
    drawProgressLines(data.lines);
  } catch (err) {
    // Un fallo puntual de polling no tiene que interrumpir la espera del
    // resultado real (runNow sigue esperando su propio fetch).
  }
}

function startMonitorLoading() {
  progressWaiting = true;
  progressSeenRunning = false;
  monitoringProgressEl.classList.remove('done', 'failed');
  monitoringStatusIconEl.className = 'spinner';
  monitoringStatusIconEl.textContent = '';
  monitoringProgressHideEl.classList.add('hidden');
  monitoringStatusCard.classList.remove('hidden');
  setProgressHead(IS_X_MONITOR ? 'Buscando posteos nuevos con Grok…' : 'Buscando posteos nuevos…');
  setProgressPercent(0);
  drawProgressLines([]);

  pollMonitorProgress();
  progressPollTimer = setInterval(pollMonitorProgress, PROGRESS_POLL_MS);
}

// "Listo: 4 relevantes guardados de 11 nuevos". "Nuevos" es lo mismo que en
// cada línea de búsqueda: posteos que no estaban guardados ni se habían
// evaluado antes (newCandidates, por plataforma, en la respuesta del ciclo).
function monitorDoneText(data) {
  const saved = Number(data.newCount) || 0;
  const perPlatform = Object.values(data.porPlataforma || {});
  if (!perPlatform.some((p) => p && Number.isFinite(p.newCandidates))) {
    return `Listo: ${saved} ${saved === 1 ? 'posteo nuevo' : 'posteos nuevos'}`;
  }
  const fresh = perPlatform.reduce((sum, p) => sum + ((p && p.newCandidates) || 0), 0);
  if (fresh === 0 && saved === 0) return 'Listo: no hubo posteos nuevos';
  return `Listo: ${saved} ${saved === 1 ? 'relevante guardado' : 'relevantes guardados'} de ${fresh} ${fresh === 1 ? 'nuevo' : 'nuevos'}`;
}

// Deja el recuadro en su estado final: ✓ con el resultado o ✕ con el error.
// Las líneas quedan a la vista; se va con "Ocultar".
async function finishMonitorLoading(ok, text) {
  clearInterval(progressPollTimer);
  progressPollTimer = null;

  // El cierre completo del ciclo: la última fase deja su resumen recién al
  // terminar, cuando ya no hay nada "en curso" que consultar. Con error solo
  // vale si se vio avanzar este ciclo (si no arrancó, el cierre que haya es
  // de uno anterior).
  if (ok || progressSeenRunning) {
    try {
      const resp = await fetch(withPlataforma('/api/monitoring/progress'));
      const data = resp.ok ? await resp.json() : null;
      if (data && data.finished) drawProgressLines(data.lines);
    } catch (err) {
      // Sin el cierre quedan las últimas líneas que se llegaron a ver.
    }
  }
  if (ok) setProgressPercent(100);
  progressWaiting = false;
  monitoringProgressEl.classList.add(ok ? 'done' : 'failed');
  monitoringStatusIconEl.className = ok ? 'run-progress-mark' : 'run-progress-mark err';
  monitoringStatusIconEl.textContent = ok ? '✓' : '✕';
  setProgressHead(text);
  monitoringProgressHideEl.classList.remove('hidden');
}

async function runNow() {
  runNowBtn.disabled = true;
  startMonitorLoading();
  // Aviso a las otras vistas: arrancó y, al terminar, qué posteos no
  // estaban antes (ver monitoringViewListeners).
  const idsBefore = new Set(monitoringTable ? monitoringTable.getData().map((post) => post.id) : []);
  notifyMonitoringViews({ run: 'start' });
  let newIds = [];

  try {
    const resp = await fetch(withPlataforma('/api/monitoring/run-now'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plataforma: MONITOR_PLATFORM }),
    });
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || 'Ocurrió un error inesperado.');

    await finishMonitorLoading(true, monitorDoneText(data));
    const posts = await loadPosts();
    if (posts) newIds = posts.filter((post) => !idsBefore.has(post.id)).map((post) => post.id);
    if (monitoringTable) monitoringTable.setPage(1);
  } catch (err) {
    await finishMonitorLoading(false, `Error: ${err.message}`);
  } finally {
    runNowBtn.disabled = false;
    notifyMonitoringViews({ run: 'end', newIds });
  }
}

addAccountBtn.addEventListener('click', addAccount);
newAccountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAccount(); });
addKeywordBtn.addEventListener('click', addKeyword);
newKeywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });
if (HAS_CLASSIC_SOURCES) {
  viewAllAccountsBtn.addEventListener('click', openAccountsModal);
  accountsModalCloseBtn.addEventListener('click', closeAccountsModal);
  accountsModal.addEventListener('click', (e) => { if (e.target === accountsModal) closeAccountsModal(); });
  viewAllKeywordsBtn.addEventListener('click', openKeywordsModal);
  keywordsModalCloseBtn.addEventListener('click', closeKeywordsModal);
  keywordsModal.addEventListener('click', (e) => { if (e.target === keywordsModal) closeKeywordsModal(); });
}
if (HAS_SEARCHES) {
  addSearchBtn.addEventListener('click', addSearch);
  newSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSearch(); });
}
if (HAS_HASHTAGS) {
  addHashtagBtn.addEventListener('click', addHashtag);
  newHashtagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addHashtag(); });
}
// Acciones de las tiras de "Se despegaron" (instagram.html), en el
// contenedor porque las tiras se rehacen con cada cambio: el selector de
// sentimiento guarda; un clic en cualquier otro lado de la tira, o Enter /
// Espacio con el foco en ella, abre el pop-up de ese posteo solo.
if (cardsEl && !IS_X_MONITOR) {
  cardsEl.addEventListener('change', (e) => {
    const select = e.target.closest('select.sentiment-select');
    const strip = select && select.closest('.hl-strip');
    if (!strip || select.value === SENTIMENT_UNSET) return;
    highlightSetSentiment(strip, select);
  });
  cardsEl.addEventListener('click', (e) => {
    const strip = e.target.closest('.hl-strip');
    if (!strip || e.target.closest('select, a, button, label')) return;
    openHighlight(strip.dataset.postId);
  });
  cardsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    if (!e.target.matches('.hl-strip')) return;
    e.preventDefault(); // Espacio no baja la página
    openHighlight(e.target.dataset.postId);
  });
}
ignoreCancelBtn.addEventListener('click', closeIgnoreModal);
ignoreConfirmBtn.addEventListener('click', confirmIgnore);
ignoreModal.addEventListener('click', (e) => { if (e.target === ignoreModal) closeIgnoreModal(); });
runNowBtn.addEventListener('click', runNow);
monitoringProgressHideEl.addEventListener('click', () => monitoringStatusCard.classList.add('hidden'));

fSentEl.addEventListener('change', applyFilters);
if (fAlcanceEl) fAlcanceEl.addEventListener('change', applyFilters);
if (fTemaEl) fTemaEl.addEventListener('change', applyFilters);
// El orden no filtra, pero cuenta para "Limpiar" y el feed se redibuja con
// el aviso de applyFilters.
if (fOrdenEl) fOrdenEl.addEventListener('change', applyFilters);
fDesdeEl.addEventListener('change', applyFilters);
fHastaEl.addEventListener('change', applyFilters);
qEl.addEventListener('input', applyFilters);
monitoringClearBtn.addEventListener('click', resetFilters);
if (periodSegEl) {
  paintPeriodSeg();
  periodSegEl.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-days]');
    if (button) setMonitorPeriod(Number(button.dataset.days));
  });
}

loadConfig();
loadPosts();
loadNextRun();
