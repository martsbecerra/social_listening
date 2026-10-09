const newAccountInput = document.getElementById('newAccount');
const addAccountBtn = document.getElementById('addAccountBtn');
const accountListPreviewEl = document.getElementById('accountListPreview');
const accountListFullEl = document.getElementById('accountListFull');
const viewAllAccountsBtn = document.getElementById('viewAllAccountsBtn');
const accountErrorEl = document.getElementById('accountError');

const accountsModal = document.getElementById('accountsModal');
const accountsModalCloseBtn = document.getElementById('accountsModalCloseBtn');

const newKeywordInput = document.getElementById('newKeyword');
const addKeywordBtn = document.getElementById('addKeywordBtn');
const keywordListPreviewEl = document.getElementById('keywordListPreview');
const keywordListFullEl = document.getElementById('keywordListFull');
const viewAllKeywordsBtn = document.getElementById('viewAllKeywordsBtn');
const keywordErrorEl = document.getElementById('keywordError');

const keywordsModal = document.getElementById('keywordsModal');
const keywordsModalCloseBtn = document.getElementById('keywordsModalCloseBtn');

// Búsquedas por palabra clave (lista `searches`): la caja existe solo en la
// solapa de Instagram (x.html no la tiene), así que todo lo que las usa
// chequea HAS_SEARCHES.
const newSearchInput = document.getElementById('newSearch');
const addSearchBtn = document.getElementById('addSearchBtn');
const searchListPreviewEl = document.getElementById('searchListPreview');
const searchListFullEl = document.getElementById('searchListFull');
const viewAllSearchesBtn = document.getElementById('viewAllSearchesBtn');
const searchErrorEl = document.getElementById('searchError');
const searchesModal = document.getElementById('searchesModal');
const searchesModalCloseBtn = document.getElementById('searchesModalCloseBtn');
const HAS_SEARCHES = Boolean(
  newSearchInput && addSearchBtn && searchListPreviewEl && searchListFullEl && viewAllSearchesBtn && searchErrorEl && searchesModal && searchesModalCloseBtn
);

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
const monitoringLoadErrorEl = document.getElementById('monitoringLoadError');
const monitoringNextRunEl = document.getElementById('monitoringNextRun');

const highlightsSectionEl = document.getElementById('monitoringHighlightsSection');
const cardsEl = document.getElementById('cards');

const fSentEl = document.getElementById('fSent');
// Filtro "Alcance": solo está en instagram.html (la etiqueta sale del
// benchmark, que X no tiene). En x.html esto es null y el filtro no existe.
const fAlcanceEl = document.getElementById('fAlcance');
const fAccBtnEl = document.getElementById('fAccBtn');
const fAccPanelEl = document.getElementById('fAccPanel');
const fDesdeEl = document.getElementById('fDesde');
const fHastaEl = document.getElementById('fHasta');
const qEl = document.getElementById('q');
const nEl = document.getElementById('n');
const mEl = document.getElementById('m');
const monitoringClearBtn = document.getElementById('clear');

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

// Lista con vista previa + "Ver todas (N)" + listado completo en un modal.
// El mismo componente para cuentas, palabras clave y búsquedas.
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

function renderSearchLists(searches) {
  renderPreviewLists({
    previewEl: searchListPreviewEl,
    fullEl: searchListFullEl,
    viewAllBtn: viewAllSearchesBtn,
    items: searches,
    onRemove: removeSearch,
    extraClass: 'kw',
  });
}

async function loadConfig() {
  try {
    const resp = await fetch(withPlataforma('/api/monitoring/config'));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = await resp.json();
    renderAccountLists(config.accounts);
    renderKeywordLists(config.keywords);
    if (HAS_SEARCHES) renderSearchLists(config.searches || []);
  } catch (err) {
    accountListPreviewEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
    keywordListPreviewEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
    if (HAS_SEARCHES) searchListPreviewEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
    console.error('Error cargando config de monitoreo:', err);
  }
}

async function addAccount() {
  const account = newAccountInput.value.trim();
  if (!account) return;

  accountErrorEl.classList.add('hidden');
  addAccountBtn.disabled = true;
  addAccountBtn.textContent = IS_X_MONITOR ? 'Agregando…' : 'Verificando…';

  try {
    const resp = await fetch(withPlataforma('/api/monitoring/accounts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, plataforma: MONITOR_PLATFORM }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'No se pudo agregar la cuenta.');
    newAccountInput.value = '';
    loadConfig();
  } catch (err) {
    accountErrorEl.textContent = err.message;
    accountErrorEl.classList.remove('hidden');
  } finally {
    addAccountBtn.disabled = false;
    addAccountBtn.textContent = 'Agregar';
  }
}

async function removeAccount(account) {
  try {
    await fetch(withPlataforma(`/api/monitoring/accounts/${encodeURIComponent(account)}`), { method: 'DELETE' });
  } catch (err) {
    console.error('Error quitando cuenta:', err);
  }
  loadConfig();
}

async function addKeyword() {
  const keyword = newKeywordInput.value.trim();
  if (!keyword) return;

  keywordErrorEl.classList.add('hidden');
  addKeywordBtn.disabled = true;
  addKeywordBtn.textContent = 'Verificando…';

  try {
    const resp = await fetch(withPlataforma('/api/monitoring/keywords'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, plataforma: MONITOR_PLATFORM }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'No se pudo agregar la palabra clave.');
    newKeywordInput.value = '';
    loadConfig();
  } catch (err) {
    keywordErrorEl.textContent = err.message;
    keywordErrorEl.classList.remove('hidden');
  } finally {
    addKeywordBtn.disabled = false;
    addKeywordBtn.textContent = 'Agregar';
  }
}

async function removeKeyword(keyword) {
  try {
    await fetch(withPlataforma(`/api/monitoring/keywords/${encodeURIComponent(keyword)}`), { method: 'DELETE' });
  } catch (err) {
    console.error('Error quitando palabra clave:', err);
  }
  loadConfig();
}

function openAccountsModal() { accountsModal.classList.remove('hidden'); }
function closeAccountsModal() { accountsModal.classList.add('hidden'); }

function openKeywordsModal() { keywordsModal.classList.remove('hidden'); }
function closeKeywordsModal() { keywordsModal.classList.add('hidden'); }

// Búsquedas por palabra clave: sin verificación contra Apify al agregar
// (el backend solo rechaza si el actor activo no busca).
async function addSearch() {
  const search = newSearchInput.value.trim();
  if (!search) return;

  searchErrorEl.classList.add('hidden');
  addSearchBtn.disabled = true;
  addSearchBtn.textContent = 'Agregando…';

  try {
    const resp = await fetch(withPlataforma('/api/monitoring/searches'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search, plataforma: MONITOR_PLATFORM }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'No se pudo agregar la búsqueda.');
    newSearchInput.value = '';
    loadConfig();
  } catch (err) {
    searchErrorEl.textContent = err.message;
    searchErrorEl.classList.remove('hidden');
  } finally {
    addSearchBtn.disabled = false;
    addSearchBtn.textContent = 'Agregar';
  }
}

async function removeSearch(search) {
  try {
    await fetch(withPlataforma(`/api/monitoring/searches/${encodeURIComponent(search)}`), { method: 'DELETE' });
  } catch (err) {
    console.error('Error quitando búsqueda:', err);
  }
  loadConfig();
}

function openSearchesModal() { searchesModal.classList.remove('hidden'); }
function closeSearchesModal() { searchesModal.classList.add('hidden'); }

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
// Igual que MK en la referencia: clase corta por sentimiento, para las
// tarjetas destacadas y el borde de color.
const SENTIMENT_SHORT = { positivo: 'pos', neutral: 'neu', negativo: 'neg' };

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

  cardsEl.innerHTML = '';
  if (scored.length === 0) {
    highlightsSectionEl.classList.add('hidden');
    return;
  }
  highlightsSectionEl.classList.remove('hidden');

  for (const { post, top } of scored) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `hl ${SENTIMENT_SHORT[post.sentiment] || 'neu'}`;
    card.dataset.go = post.id;

    const topRow = document.createElement('span');
    topRow.className = 'hl-top';
    const acc = document.createElement('span');
    acc.className = 'hl-acc';
    acc.textContent = post.account && post.account !== 'N/D' ? `@${post.account}` : 'N/D';
    const plat = document.createElement('span');
    plat.className = 'hl-plat';
    plat.textContent = 'Instagram';
    topRow.append(acc, plat);

    const title = document.createElement('span');
    title.className = 'hl-title';
    title.textContent = post.title || '(sin clasificar)';

    const metric = document.createElement('span');
    metric.className = 'hl-metric';
    const b = document.createElement('b');
    b.textContent = `${formatBenchmarkRatio(top.ratio)}x`;
    metric.appendChild(b);
    // La razón lleva colchón: ya no es "N veces lo habitual". Al lado van el
    // valor y la mediana reales de la métrica que lo destacó.
    const decisive = post.benchmark[top.metric];
    metric.appendChild(
      document.createTextNode(
        ` en ${top.label}: ${formatBenchmarkNumber(decisive.value)}, contra una mediana de ${formatBenchmarkNumber(decisive.median)}`
      )
    );
    metric.title = `Razón de alcance: ${benchmarkRatioBasis(decisive)}`;

    card.append(topRow, title, metric);
    card.addEventListener('click', () => openHighlight(post.id));
    cardsEl.appendChild(card);
  }
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

// -------------------------------------------------------------------------
// Filtros (barra "Filtrar"). El orden se elige cliqueando el header de
// cada columna — flechas asc/desc de Tabulator, no una fila "Ordenar".
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

function isDefaultFilterState() {
  return (
    !fSentEl.value &&
    !(fAlcanceEl && fAlcanceEl.value) &&
    !fAccValue &&
    !fDesdeEl.value &&
    !fHastaEl.value &&
    !qEl.value.trim()
  );
}

function updateMonitoringClearButtonState() {
  monitoringClearBtn.disabled = isDefaultFilterState();
}

function updateCounts() {
  if (!monitoringTable) return;
  nEl.textContent = monitoringTable.getDataCount('active');
  mEl.textContent = monitoringTable.getDataCount();
}

// Vistas extra sobre los mismos posteos y los mismos filtros que la tabla.
// Hoy hay una sola, el Feed de Instagram (public/js/monitoringFeed.js, que
// x.html no carga): se anota acá y se le avisa de cada cambio. Sin ninguna
// anotada no pasa nada. "change" dice qué pasó:
//   (nada)         cambiaron los datos o los filtros: hay que redibujar.
//   { ignoredId }  se ignoró ese posteo (ya salió de la tabla).
//   { goToId }     hay que mostrar ese posteo (tarjetas de "Se despegaron").
//                  La vista que esté activa devuelve true y se hace cargo;
//                  si ninguna lo hace, lo muestra la tabla.
const monitoringViewListeners = [];

function notifyMonitoringViews(change) {
  let handled = false;
  for (const listener of monitoringViewListeners) {
    if (listener(change) === true) handled = true;
  }
  return handled;
}

// Valores actuales de la barra "Filtrar".
function readFilterValues() {
  return {
    sentiment: fSentEl.value,
    reach: fAlcanceEl ? fAlcanceEl.value : '', // "" | alto | medio | bajo
    account: fAccValue,
    desde: fDesdeEl.value, // "YYYY-MM-DD" del <input type="date"> o ""
    hasta: fHastaEl.value,
    q: normalizeSearch(qEl.value.trim()),
  };
}

// La condición de la barra "Filtrar" sobre un posteo, separada de Tabulator:
// la tabla y la vista Feed de Instagram filtran con esta misma función, así
// las dos muestran siempre el mismo conjunto. "filters" es lo que devuelve
// readFilterValues().
function postMatchesFilters(data, filters) {
  const { sentiment, reach, account, desde, hasta, q } = filters;
  // "sin_clasificar" no es un valor guardado: es la ausencia de valor.
  if (sentiment === SENTIMENT_UNSET) {
    if (data.sentiment) return false;
  } else if (sentiment && data.sentiment !== sentiment) {
    return false;
  }
  if (account && data.account !== account) return false;
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

function applyFilters() {
  if (!monitoringTable) return;
  const filters = readFilterValues();

  monitoringTable.setFilter((data) => postMatchesFilters(data, filters));

  fSentEl.classList.toggle('on', !!filters.sentiment);
  if (fAlcanceEl) fAlcanceEl.classList.toggle('on', !!filters.reach);
  fAccBtnEl.classList.toggle('on', !!filters.account);
  fDesdeEl.classList.toggle('on', !!filters.desde);
  fHastaEl.classList.toggle('on', !!filters.hasta);

  updateCounts();
  updateMonitoringClearButtonState();
  notifyMonitoringViews();
}

// -------------------------------------------------------------------------
// Dropdown de Cuenta a medida (botón + panel propio, no un <select> nativo
// — ver el comentario en instagram.html sobre por qué). Selección única,
// se cierra solo al elegir, clickear afuera o Escape.
// -------------------------------------------------------------------------
// .filters tiene overflow:hidden (esquinas redondeadas de la barra, a
// propósito). El panel es un <div> común — a diferencia del popup de un
// <select> nativo, que el navegador pinta fuera del DOM — así que si se
// queda adentro de .filters, ese overflow lo recorta. Se reubica una sola
// vez como hijo directo de <body> para escapar cualquier contenedor con
// overflow/stacking context propio, y se posiciona a mano en cada apertura.
let accPanelMovedToBody = false;

function positionAccPanel() {
  const rect = fAccBtnEl.getBoundingClientRect();
  fAccPanelEl.style.top = `${rect.bottom + 6}px`;
  fAccPanelEl.style.left = `${rect.left}px`;
  fAccPanelEl.style.minWidth = `${rect.width}px`;
}

function closeAccPanel() {
  fAccPanelEl.classList.add('hidden');
  fAccBtnEl.setAttribute('aria-expanded', 'false');
}

function openAccPanel() {
  if (!accPanelMovedToBody) {
    document.body.appendChild(fAccPanelEl);
    accPanelMovedToBody = true;
  }
  positionAccPanel();
  fAccPanelEl.classList.remove('hidden');
  fAccBtnEl.setAttribute('aria-expanded', 'true');
}

function selectAccount(value, label) {
  fAccValue = value;
  fAccBtnEl.textContent = label;
  closeAccPanel();
  applyFilters();
}

fAccBtnEl.addEventListener('click', () => {
  if (fAccPanelEl.classList.contains('hidden')) openAccPanel();
  else closeAccPanel();
});
document.addEventListener('click', (e) => {
  if (!fAccPanelEl.classList.contains('hidden') && !fAccBtnEl.contains(e.target) && !fAccPanelEl.contains(e.target)) {
    closeAccPanel();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAccPanel();
});
// Reposicionado en fixed, no relativo a un ancestro: si se scrollea con el
// panel abierto se desalinearía del botón. Más simple y predecible cerrarlo,
// mismo comportamiento que un <select> nativo (también se cierra al scrollear).
window.addEventListener('scroll', () => closeAccPanel(), true);
window.addEventListener('resize', () => closeAccPanel());

// Reconstruye el panel de Cuenta con las cuentas presentes en los datos
// cargados. Si la cuenta elegida ya no está, vuelve a "Todas".
function ensureAccountFilterOptions(posts) {
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

// "Limpiar" resetea los filtros a blanco. El orden queda en los headers
// de la tabla (no es un filtro de esta barra).
function resetFilters() {
  fSentEl.value = '';
  if (fAlcanceEl) fAlcanceEl.value = '';
  fAccValue = '';
  fAccBtnEl.textContent = 'Cuenta';
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
    placeholder: 'Todavía no se detectó ningún posteo.',
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
  } catch (err) {
    monitoringLoadErrorEl.textContent = 'No se pudo cargar la tabla. Reiniciá el servidor (para que tome el código nuevo) y recargá la página.';
    monitoringLoadErrorEl.classList.remove('hidden');
    console.error('Error cargando posteos detectados:', err);
  }
}

// Hora real de la próxima corrida (el backend calcula desde MONITOR_CRON) —
// nunca una hora inventada. Si falla, queda el placeholder "–".
async function loadNextRun() {
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
    monitoringProgressFillEl.style.width = `${data.percent}%`;
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
  monitoringProgressFillEl.style.width = '0%';
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
  if (ok) monitoringProgressFillEl.style.width = '100%';
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

  try {
    const resp = await fetch(withPlataforma('/api/monitoring/run-now'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plataforma: MONITOR_PLATFORM }),
    });
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || 'Ocurrió un error inesperado.');

    await finishMonitorLoading(true, monitorDoneText(data));
    await loadPosts();
    if (monitoringTable) monitoringTable.setPage(1);
  } catch (err) {
    await finishMonitorLoading(false, `Error: ${err.message}`);
  } finally {
    runNowBtn.disabled = false;
  }
}

addAccountBtn.addEventListener('click', addAccount);
newAccountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAccount(); });
viewAllAccountsBtn.addEventListener('click', openAccountsModal);
accountsModalCloseBtn.addEventListener('click', closeAccountsModal);
accountsModal.addEventListener('click', (e) => { if (e.target === accountsModal) closeAccountsModal(); });
addKeywordBtn.addEventListener('click', addKeyword);
newKeywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });
viewAllKeywordsBtn.addEventListener('click', openKeywordsModal);
keywordsModalCloseBtn.addEventListener('click', closeKeywordsModal);
keywordsModal.addEventListener('click', (e) => { if (e.target === keywordsModal) closeKeywordsModal(); });
if (HAS_SEARCHES) {
  addSearchBtn.addEventListener('click', addSearch);
  newSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSearch(); });
  viewAllSearchesBtn.addEventListener('click', openSearchesModal);
  searchesModalCloseBtn.addEventListener('click', closeSearchesModal);
  searchesModal.addEventListener('click', (e) => { if (e.target === searchesModal) closeSearchesModal(); });
}
ignoreCancelBtn.addEventListener('click', closeIgnoreModal);
ignoreConfirmBtn.addEventListener('click', confirmIgnore);
ignoreModal.addEventListener('click', (e) => { if (e.target === ignoreModal) closeIgnoreModal(); });
runNowBtn.addEventListener('click', runNow);
monitoringProgressHideEl.addEventListener('click', () => monitoringStatusCard.classList.add('hidden'));

fSentEl.addEventListener('change', applyFilters);
if (fAlcanceEl) fAlcanceEl.addEventListener('change', applyFilters);
fDesdeEl.addEventListener('change', applyFilters);
fHastaEl.addEventListener('change', applyFilters);
qEl.addEventListener('input', applyFilters);
monitoringClearBtn.addEventListener('click', resetFilters);

loadConfig();
loadPosts();
loadNextRun();
