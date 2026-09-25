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
const monitoringStatusTextEl = document.getElementById('monitoringStatusText');
const monitoringProgressFillEl = document.getElementById('monitoringProgressFill');
const monitoringResultEl = document.getElementById('monitoringResult');
const monitoringLoadErrorEl = document.getElementById('monitoringLoadError');
const monitoringNextRunEl = document.getElementById('monitoringNextRun');

const highlightsSectionEl = document.getElementById('monitoringHighlightsSection');
const cardsEl = document.getElementById('cards');

const fSentEl = document.getElementById('fSent');
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

function formatBenchmarkRatio(ratio) {
  return ratio.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// "sin-referencia" (guión, como lo manda el backend) -> "sinref" (la clase
// CSS de la referencia, .bn.sinref).
function benchmarkLevelClass(metric) {
  const level = (metric && metric.level) || 'sin-referencia';
  return level === 'sin-referencia' ? 'sinref' : level;
}

// <span class="bn {nivel}">{label}: <strong>{nivel}</strong> — <span
// class="v">{valor}</span>, contra una mediana de <span class="v">
// {mediana}</span> en esta cuenta (<span class="v">{ratio}x</span>)</span>
// — misma estructura que bench() en design/monitoreo.html.
function buildBenchLine(label, metric) {
  const span = document.createElement('span');
  span.className = `bn ${benchmarkLevelClass(metric)}`;

  if (!metric || metric.level === 'sin-referencia') {
    span.textContent = `${label}: sin referencia (menos de 5 posteos recientes de esta cuenta)`;
    return span;
  }

  span.appendChild(document.createTextNode(`${label}: `));
  const strong = document.createElement('strong');
  strong.textContent = metric.level;
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
  span.appendChild(document.createTextNode(' en esta cuenta ('));
  const ratio = document.createElement('span');
  ratio.className = 'v';
  ratio.textContent = `${formatBenchmarkRatio(metric.ratio)}x`;
  span.appendChild(ratio);
  span.appendChild(document.createTextNode(')'));
  return span;
}

// Fecha + hora completas (24hs, no "a. m./p. m."). "N/D" si no hay fecha.
function formatFullDateTime(iso) {
  if (!iso) return { date: 'N/D', time: '' };
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('es-AR'),
    time: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }),
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
// Tarjetas destacadas ("Se despegaron"): posteos — no cuentas — cuya cuenta
// tiene benchmark real (account_stats) en AMBAS métricas y cuyo ratio mayor
// (likes o comentarios) llega a 1.5x. Mismo criterio que "dest" en
// design/monitoreo.html.
// -------------------------------------------------------------------------
const HIGHLIGHT_MIN_RATIO = 1.5;
const HIGHLIGHT_CARD_COUNT = 4;

function highlightTop(post) {
  const benchmark = post.benchmark || {};
  const bl = benchmark.likes, bc = benchmark.comments;
  if (!bl || bl.level === 'sin-referencia' || !bc || bc.level === 'sin-referencia') return null;
  const useComments = bc.ratio >= bl.ratio;
  return {
    best: Math.max(bl.ratio, bc.ratio),
    label: useComments ? 'comentarios' : 'likes',
    ratio: useComments ? bc.ratio : bl.ratio,
  };
}

function renderHighlightCards(posts) {
  if (IS_X_MONITOR || !highlightsSectionEl || !cardsEl) {
    if (highlightsSectionEl) highlightsSectionEl.classList.add('hidden');
    return;
  }
  const scored = posts
    .map((post) => ({ post, top: highlightTop(post) }))
    .filter((entry) => entry.top && entry.top.best >= HIGHLIGHT_MIN_RATIO)
    .sort((a, b) => b.top.best - a.top.best)
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
    metric.appendChild(document.createTextNode(` los ${top.label} habituales de la cuenta`));

    card.append(topRow, title, metric);
    card.addEventListener('click', () => highlightGoToRow(post.id));
    cardsEl.appendChild(card);
  }
}

// Busca la fila en el conjunto activo (filtrado + ordenado) actual — igual
// que la referencia, no reinicia filtros: si el posteo está tapado por un
// filtro, no hace nada. A diferencia de la referencia (tabla plana, sin
// paginación), acá hay que ubicar en qué página de Tabulator cae.
async function highlightGoToRow(id) {
  if (!monitoringTable) return;
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

function applyFilters() {
  if (!monitoringTable) return;
  const fs = fSentEl.value;
  const fa = fAccValue;
  const fDesde = fDesdeEl.value; // "YYYY-MM-DD" del <input type="date"> o ""
  const fHasta = fHastaEl.value;
  const q = normalizeSearch(qEl.value.trim());

  monitoringTable.setFilter((data) => {
    // "sin_clasificar" no es un valor guardado: es la ausencia de valor.
    if (fs === SENTIMENT_UNSET) {
      if (data.sentiment) return false;
    } else if (fs && data.sentiment !== fs) {
      return false;
    }
    if (fa && data.account !== fa) return false;
    if (fDesde || fHasta) {
      if (!data.posted_at) return false;
      const posted = new Date(data.posted_at);
      if (fDesde && posted < new Date(`${fDesde}T00:00:00`)) return false;
      if (fHasta && posted > new Date(`${fHasta}T23:59:59.999`)) return false;
    }
    if (q) {
      const haystack = normalizeSearch(`${data.title || ''} ${data.account || ''} ${data.caption || ''}`);
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  fSentEl.classList.toggle('on', !!fs);
  fAccBtnEl.classList.toggle('on', !!fa);
  fDesdeEl.classList.toggle('on', !!fDesde);
  fHastaEl.classList.toggle('on', !!fHasta);

  updateCounts();
  updateMonitoringClearButtonState();
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
      const raw = cell.getValue();
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
// Progreso real del ciclo (GET /api/monitoring/progress, ver
// src/monitoringProgress.js): mientras "Actualizar ahora" está en curso,
// se consulta cada PROGRESS_POLL_MS y se muestra la fase con su contador
// real y el porcentaje real. null (sin ciclo corriendo, o entre el fetch
// inicial y que el scheduler arranque la primera fase) deja el texto/barra
// como estaban, no los pisa con nada inventado.
// --------------------------------------------------------------------
const PROGRESS_POLL_MS = 1500;
let progressPollTimer = null;

async function pollMonitorProgress() {
  try {
    const resp = await fetch(withPlataforma('/api/monitoring/progress'));
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data) return;
    monitoringStatusTextEl.textContent = `${data.phase} · ${data.done} de ${data.total}`;
    monitoringProgressFillEl.style.width = `${data.percent}%`;
  } catch (err) {
    // Un fallo puntual de polling no tiene que interrumpir la espera del
    // resultado real (runNow sigue esperando su propio fetch).
  }
}

function startMonitorLoading() {
  monitoringResultEl.classList.add('hidden');
  monitoringStatusCard.classList.remove('hidden');
  monitoringStatusTextEl.textContent = IS_X_MONITOR ? 'Buscando posteos nuevos con Grok…' : 'Buscando posteos nuevos…';
  monitoringProgressFillEl.style.width = '0%';

  pollMonitorProgress();
  progressPollTimer = setInterval(pollMonitorProgress, PROGRESS_POLL_MS);
}

function stopMonitorLoading(exito) {
  clearInterval(progressPollTimer);
  progressPollTimer = null;

  if (exito) {
    monitoringProgressFillEl.style.width = '100%';
    setTimeout(() => {
      monitoringStatusCard.classList.add('hidden');
      monitoringProgressFillEl.style.width = '0%';
    }, 350);
  } else {
    monitoringStatusCard.classList.add('hidden');
    monitoringProgressFillEl.style.width = '0%';
  }
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

    stopMonitorLoading(true);
    monitoringResultEl.textContent = `Listo: ${data.checked} posteos revisados, ${data.newCount} nuevos.`;
    monitoringResultEl.classList.remove('hidden');
    await loadPosts();
    if (monitoringTable) monitoringTable.setPage(1);
  } catch (err) {
    stopMonitorLoading(false);
    monitoringResultEl.textContent = `Error: ${err.message}`;
    monitoringResultEl.classList.remove('hidden');
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

fSentEl.addEventListener('change', applyFilters);
fDesdeEl.addEventListener('change', applyFilters);
fHastaEl.addEventListener('change', applyFilters);
qEl.addEventListener('input', applyFilters);
monitoringClearBtn.addEventListener('click', resetFilters);

loadConfig();
loadPosts();
loadNextRun();
