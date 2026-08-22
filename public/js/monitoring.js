const newAccountInput = document.getElementById('newAccount');
const addAccountBtn = document.getElementById('addAccountBtn');
const accountListEl = document.getElementById('accountList');
const accountErrorEl = document.getElementById('accountError');

const newKeywordInput = document.getElementById('newKeyword');
const addKeywordBtn = document.getElementById('addKeywordBtn');
const keywordListPreviewEl = document.getElementById('keywordListPreview');
const keywordListFullEl = document.getElementById('keywordListFull');
const viewAllKeywordsBtn = document.getElementById('viewAllKeywordsBtn');
const keywordErrorEl = document.getElementById('keywordError');

const keywordsModal = document.getElementById('keywordsModal');
const keywordsModalCloseBtn = document.getElementById('keywordsModalCloseBtn');

const deleteModal = document.getElementById('deleteModal');
const deleteCancelBtn = document.getElementById('deleteCancelBtn');
const deleteConfirmBtn = document.getElementById('deleteConfirmBtn');

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
const fNotiEl = document.getElementById('fNoti');
const chkWrapEl = document.getElementById('chkWrap');
const fDesdeEl = document.getElementById('fDesde');
const fHastaEl = document.getElementById('fHasta');
const qEl = document.getElementById('q');
const sortSelects = [...document.querySelectorAll('.srt')];
const sLikesEl = document.getElementById('sLikes');
const nEl = document.getElementById('n');
const mEl = document.getElementById('m');
const monitoringClearBtn = document.getElementById('clear');

const KEYWORDS_PREVIEW_COUNT = 2;
// Todo de una sola vez: el orden/filtro/paginación ahora los maneja
// Tabulator del lado del cliente, así que no paginamos contra el backend.
const FETCH_ALL_PAGE_SIZE = 5000;
let pendingDeleteId = null;

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

function renderKeywordLists(keywords) {
  const preview = keywords.slice(0, KEYWORDS_PREVIEW_COUNT);
  renderTagList(keywordListPreviewEl, preview, removeKeyword, 'kw');
  renderTagList(keywordListFullEl, keywords, removeKeyword, 'kw');

  // renderTagList reemplaza todo el contenido del contenedor, así que el
  // botón "Ver todas" (que vive ahí adentro para quedar en la misma fila
  // que los chips) hay que volver a engancharlo después.
  if (keywords.length > KEYWORDS_PREVIEW_COUNT) {
    viewAllKeywordsBtn.textContent = `Ver todas (${keywords.length})`;
    viewAllKeywordsBtn.classList.remove('hidden');
  } else {
    viewAllKeywordsBtn.classList.add('hidden');
  }
  keywordListPreviewEl.appendChild(viewAllKeywordsBtn);
}

async function loadConfig() {
  try {
    const resp = await fetch('/api/monitoring/config');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = await resp.json();
    renderTagList(accountListEl, config.accounts, removeAccount);
    renderKeywordLists(config.keywords);
  } catch (err) {
    accountListEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
    keywordListPreviewEl.innerHTML = '<span class="muted">No se pudo cargar. Reiniciá el servidor y recargá la página.</span>';
    console.error('Error cargando config de monitoreo:', err);
  }
}

async function addAccount() {
  const account = newAccountInput.value.trim();
  if (!account) return;

  accountErrorEl.classList.add('hidden');
  addAccountBtn.disabled = true;
  addAccountBtn.textContent = 'Verificando…';

  try {
    const resp = await fetch('/api/monitoring/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account }),
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
    await fetch(`/api/monitoring/accounts/${encodeURIComponent(account)}`, { method: 'DELETE' });
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
    const resp = await fetch('/api/monitoring/keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword }),
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
    await fetch(`/api/monitoring/keywords/${encodeURIComponent(keyword)}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Error quitando palabra clave:', err);
  }
  loadConfig();
}

function openKeywordsModal() { keywordsModal.classList.remove('hidden'); }
function closeKeywordsModal() { keywordsModal.classList.add('hidden'); }

// --------------------------------------------------------------------
// Tabla de posteos detectados, con Tabulator.
// --------------------------------------------------------------------
const SENTIMENT_LABELS = { positivo: 'Positivo', neutral: 'Neutral', negativo: 'Negativo' };
const SENTIMENT_OPTIONS = ['positivo', 'neutral', 'negativo'];
// Igual que MK en la referencia: clase corta por sentimiento, para las
// tarjetas destacadas y el borde de color.
const SENTIMENT_SHORT = { positivo: 'pos', neutral: 'neu', negativo: 'neg' };

function openDeleteModal(id) {
  pendingDeleteId = id;
  deleteModal.classList.remove('hidden');
}

function closeDeleteModal() {
  pendingDeleteId = null;
  deleteModal.classList.add('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  try {
    await fetch(`/api/monitoring/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (monitoringTable) {
      monitoringTable.deleteRow(id);
      updateCounts();
    }
  } catch (err) {
    console.error('Error borrando el registro:', err);
  }
  closeDeleteModal();
}

async function updateSentiment(id, sentiment, selectEl) {
  // Cambiamos la clase al toque para que el color de la pastilla se
  // actualice ya mismo, sin esperar la respuesta del servidor.
  SENTIMENT_OPTIONS.forEach((value) => selectEl.classList.remove(`sentiment-${value}`));
  selectEl.classList.add(`sentiment-${sentiment}`);

  try {
    const resp = await fetch(`/api/monitoring/posts/${encodeURIComponent(id)}`, {
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

  const bench = document.createElement('div');
  bench.className = 'dt-bench';
  const benchmark = data.benchmark || {};
  bench.appendChild(buildBenchLine('Comentarios', benchmark.comments));
  bench.appendChild(buildBenchLine('Likes', benchmark.likes));
  wrap.appendChild(bench);

  const links = document.createElement('div');
  links.className = 'dt-links';
  if (data.account && data.account !== 'N/D') {
    const profile = document.createElement('a');
    profile.href = `https://instagram.com/${data.account}`;
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
  meta.textContent = time ? `${date} · ${time} · Instagram` : `${date} · Instagram`;
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
// Filtros + orden (barra "Filtrar" / "Ordenar"): selects nativos, igual que
// design/monitoreo.html — sin desplegables a medida.
// -------------------------------------------------------------------------
// sortField/sortDir en null = sin orden forzado (orden natural: el que ya
// trae /api/monitoring/posts, más nuevos primero). Solo el estado inicial
// de la página fuerza "likes desc" — un select vaciado a mano, o "Limpiar",
// dejan el orden en null como cualquier otro filtro que se limpia.
let sortField = 'likes';
let sortDir = 'desc';
// Claves cortas de los <option value="l|desc"> (calcadas de la referencia)
// a los fields reales de Tabulator. El rango de fechas ahora filtra en vez
// de ordenar (ver fDesde/fHasta), así que ya no hay clave "d" acá.
const SORT_FIELD_MAP = { l: 'likes', c: 'comments', fol: 'followers' };
const SORTABLE_FIELDS = ['likes', 'comments', 'followers'];

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
    !fNotiEl.checked &&
    !fDesdeEl.value &&
    !fHastaEl.value &&
    !qEl.value.trim() &&
    sortField === null
  );
}

function updateMonitoringClearButtonState() {
  monitoringClearBtn.disabled = isDefaultFilterState();
}

function updateSortColumnHighlight() {
  if (!monitoringTable) return;
  for (const field of SORTABLE_FIELDS) {
    const column = monitoringTable.getColumn(field);
    if (!column) continue;
    column.getElement().classList.toggle('act', field === sortField);
  }
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
  const fn = fNotiEl.checked;
  const fDesde = fDesdeEl.value; // "YYYY-MM-DD" del <input type="date"> o ""
  const fHasta = fHastaEl.value;
  const q = normalizeSearch(qEl.value.trim());

  monitoringTable.setFilter((data) => {
    if (fs && data.sentiment !== fs) return false;
    if (fa && data.account !== fa) return false;
    if (fn && data.notified) return false;
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
  chkWrapEl.classList.toggle('on', fn);
  fDesdeEl.classList.toggle('on', !!fDesde);
  fHastaEl.classList.toggle('on', !!fHasta);

  updateCounts();
  updateMonitoringClearButtonState();
}

function applySort() {
  if (!monitoringTable) return;
  if (sortField) {
    monitoringTable.setSort(sortField, sortDir);
  } else {
    // Ningún select de orden elegido: orden natural (el que ya trae
    // /api/monitoring/posts), no forzamos ningún campo.
    monitoringTable.clearSort();
  }
  updateSortColumnHighlight();
  updateCounts();
  updateMonitoringClearButtonState();
}

// Un select de orden elegido resetea los otros dos a neutro — solo uno
// activo a la vez, igual que la referencia. Vaciar el select activo (elegir
// la opción en blanco) deja el orden en null: no vuelve a imponerse solo,
// para poder "sacarlo" de verdad desde el propio desplegable.
sortSelects.forEach((sel) => {
  sel.addEventListener('change', () => {
    if (sel.value) {
      const [key, dir] = sel.value.split('|');
      sortField = SORT_FIELD_MAP[key];
      sortDir = dir;
      sortSelects.forEach((other) => {
        if (other !== sel) other.value = '';
      });
    } else {
      sortField = null;
      sortDir = null;
    }
    sortSelects.forEach((o) => o.classList.toggle('on', !!o.value));
    applySort();
  });
});

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

// "Limpiar" resetea TODO a blanco, orden incluido — el mismo tratamiento
// que el resto de los controles de esta barra. El "Likes desc" solo es el
// arranque de la página (ver más abajo), no un estado al que este botón
// vuelva: si fuera así, no habría forma de sacar el orden con "Limpiar"
// cuando ya se estaba en ese estado.
function resetFilters() {
  fSentEl.value = '';
  fAccValue = '';
  fAccBtnEl.textContent = 'Cuenta';
  fAccBtnEl.classList.remove('on');
  fNotiEl.checked = false;
  fDesdeEl.value = '';
  fHastaEl.value = '';
  fDesdeEl.classList.remove('on');
  fHastaEl.classList.remove('on');
  qEl.value = '';
  sortSelects.forEach((o) => {
    o.value = '';
    o.classList.remove('on');
  });
  sortField = null;
  sortDir = null;
  applyFilters();
  applySort();
}

// Estado inicial: Likes de mayor a menor, para que el select ya arranque
// mostrando "Likes ↓" tildado en vez de en blanco (sortField ya vale
// 'likes' arriba). Es un default de arranque, no un piso al que "Limpiar"
// o el propio select tengan que volver.
sLikesEl.value = 'l|desc';
sLikesEl.classList.add('on');

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
    headerSort: false,
    formatter: (cell) => {
      const account = cell.getValue();
      if (!account || account === 'N/D') return 'N/D';
      const a = document.createElement('a');
      a.className = 'c-acc';
      a.href = `https://instagram.com/${account}`;
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
    headerSort: false,
    width: 100,
    hozAlign: 'right',
    headerHozAlign: 'right',
    sorter: 'number',
    formatter: (cell) => `<span class="c-num">${formatFollowers(cell.getValue())}</span>`,
  },
  {
    title: 'Título',
    field: 'title',
    headerSort: false,
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
    headerSort: false,
    width: 140,
    hozAlign: 'center',
    headerHozAlign: 'left',
    formatter: (cell) => {
      const id = cell.getRow().getData().id;
      const sentiment = cell.getValue() || 'neutral';
      const select = document.createElement('select');
      select.className = `sentiment-select sentiment-${sentiment}`;
      SENTIMENT_OPTIONS.forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = SENTIMENT_LABELS[value];
        if (value === sentiment) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('click', (e) => e.stopPropagation());
      select.addEventListener('change', () => updateSentiment(id, select.value, select));
      return select;
    },
  },
  {
    title: 'Fecha',
    field: 'posted_at',
    headerSort: false,
    width: 110,
    hozAlign: 'center',
    headerHozAlign: 'left',
    // Las fechas se guardan en ISO 8601: ese formato ordena bien como texto
    // plano, sin necesitar un parser de fechas aparte para esta columna.
    sorter: 'string',
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
    headerSort: false,
    width: 100,
    hozAlign: 'right',
    headerHozAlign: 'right',
    sorter: 'number',
    formatter: (cell) => `<span class="c-num">${formatCount(cell.getValue())}</span>`,
  },
  {
    // Abreviado, igual que la referencia (el select de orden sí dice
    // "Comentarios" completo).
    title: 'Coment.',
    field: 'comments',
    headerSort: false,
    hozAlign: 'right',
    headerHozAlign: 'right',
    sorter: 'number',
    formatter: (cell) => `<span class="c-num">${formatCount(cell.getValue())}</span>`,
  },
  {
    title: 'Notificado',
    field: 'notified',
    headerSort: false,
    width: 120,
    hozAlign: 'center',
    headerHozAlign: 'center',
    sorter: 'number',
    formatter: (cell) => {
      const notified = cell.getValue();
      const span = document.createElement('span');
      span.className = notified ? 'badge badge-yes' : 'badge badge-no';
      span.textContent = notified ? 'Sí' : 'No';
      return span;
    },
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
      btn.title = 'Borrar';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeleteModal(id);
      });
      return btn;
    },
  },
];

let monitoringTable = null;

function ensureMonitoringTable(posts) {
  ensureAccountFilterOptions(posts);

  if (monitoringTable) {
    monitoringTable.setData(posts).then(() => {
      applyFilters();
      applySort();
    });
    return;
  }

  monitoringTable = new Tabulator('#monitoringTable', {
    data: posts,
    index: 'id',
    layout: 'fitColumns',
    columns: MONITORING_COLUMNS,
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
    applySort();
  });
  // rowClick pasado en el constructor no se conecta en esta build de
  // Tabulator 6.3.0 (comprobado en vivo) — .on() después de construir la
  // tabla sí funciona. Clickear en cualquier parte de la fila abre/cierra
  // su detalle (igual que la referencia); los controles interactivos de
  // adentro (links, borrar, sentimiento) cortan la propagación en su propio
  // formatter.
  monitoringTable.on('rowClick', (e, row) => toggleRowExpansion(row));
}

async function loadPosts() {
  try {
    const resp = await fetch(`/api/monitoring/posts?page=1&pageSize=${FETCH_ALL_PAGE_SIZE}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    monitoringLoadErrorEl.classList.add('hidden');
    ensureMonitoringTable(data.posts);
    renderHighlightCards(data.posts);
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
// Barra de progreso "simulada", igual que en el análisis de publicación:
// el backend no avisa en tiempo real cómo va el ciclo (una sola llamada
// que responde al final), así que animamos una barra que avanza rápido al
// principio y se frena cerca del 92%, más mensajes rotativos, para que se
// vea que algo está pasando mientras se espera.
// --------------------------------------------------------------------
const MONITOR_LOADING_MESSAGES = [
  'Buscando posteos nuevos en las cuentas trackeadas…',
  'Revisando los hashtags configurados…',
  'Evaluando relevancia con IA…',
  'Clasificando título y sentimiento…',
  'Guardando resultados…',
];

let monitorProgressTimer = null;
let monitorMessageTimer = null;

function startMonitorLoading() {
  monitoringResultEl.classList.add('hidden');
  monitoringStatusCard.classList.remove('hidden');

  let pct = 0;
  monitoringProgressFillEl.style.width = '0%';

  monitorProgressTimer = setInterval(() => {
    const restante = 92 - pct;
    pct += Math.max(0.3, restante * 0.04);
    if (pct > 92) pct = 92;
    monitoringProgressFillEl.style.width = pct + '%';
  }, 200);

  let msgIndex = 0;
  monitoringStatusTextEl.textContent = MONITOR_LOADING_MESSAGES[0];
  monitorMessageTimer = setInterval(() => {
    msgIndex = (msgIndex + 1) % MONITOR_LOADING_MESSAGES.length;
    monitoringStatusTextEl.style.opacity = 0;
    setTimeout(() => {
      monitoringStatusTextEl.textContent = MONITOR_LOADING_MESSAGES[msgIndex];
      monitoringStatusTextEl.style.opacity = 1;
    }, 250);
  }, 2500);
}

function stopMonitorLoading(exito) {
  clearInterval(monitorProgressTimer);
  clearInterval(monitorMessageTimer);

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
    const resp = await fetch('/api/monitoring/run-now', { method: 'POST' });
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
addKeywordBtn.addEventListener('click', addKeyword);
newKeywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });
viewAllKeywordsBtn.addEventListener('click', openKeywordsModal);
keywordsModalCloseBtn.addEventListener('click', closeKeywordsModal);
keywordsModal.addEventListener('click', (e) => { if (e.target === keywordsModal) closeKeywordsModal(); });
deleteCancelBtn.addEventListener('click', closeDeleteModal);
deleteConfirmBtn.addEventListener('click', confirmDelete);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });
runNowBtn.addEventListener('click', runNow);

fSentEl.addEventListener('change', applyFilters);
fNotiEl.addEventListener('change', applyFilters);
fDesdeEl.addEventListener('change', applyFilters);
fHastaEl.addEventListener('change', applyFilters);
qEl.addEventListener('input', applyFilters);
monitoringClearBtn.addEventListener('click', resetFilters);

loadConfig();
loadPosts();
loadNextRun();
