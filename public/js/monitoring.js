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
const monitoringResultsCountEl = document.getElementById('monitoringResultsCount');

const KEYWORDS_PREVIEW_COUNT = 2;
// Todo de una sola vez: el orden/filtro/paginación ahora los maneja
// Tabulator del lado del cliente, así que no paginamos contra el backend.
const FETCH_ALL_PAGE_SIZE = 5000;
let pendingDeleteId = null;

function renderTagList(listEl, items, onRemove) {
  listEl.innerHTML = '';
  if (items.length === 0) {
    listEl.innerHTML = '<li class="muted" style="background:none;border:none;">Ninguna todavía</li>';
    return;
  }
  items.forEach((item) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = item;
    const btn = document.createElement('button');
    btn.className = 'remove-tag';
    btn.textContent = '✕';
    btn.title = 'Quitar';
    btn.addEventListener('click', () => onRemove(item));
    li.appendChild(span);
    li.appendChild(btn);
    listEl.appendChild(li);
  });
}

function renderKeywordLists(keywords) {
  const preview = keywords.slice(0, KEYWORDS_PREVIEW_COUNT);
  renderTagList(keywordListPreviewEl, preview, removeKeyword);
  renderTagList(keywordListFullEl, keywords, removeKeyword);

  // renderTagList reemplaza todo el contenido del <ul>, así que el botón
  // "Ver todas" (que vive dentro de ese mismo <ul> para quedar alineado a
  // la derecha en la misma fila) hay que volver a engancharlo después.
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
    const msg = '<li class="muted" style="background:none;border:none;">No se pudo cargar. Reiniciá el servidor y recargá la página.</li>';
    accountListEl.innerHTML = msg;
    keywordListPreviewEl.innerHTML = msg;
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
      updateResultsCountText();
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

// Formatea likes/comments con separador de miles es-AR, o "N/D" si no hay dato.
function formatCount(value) {
  return value === null || value === undefined ? 'N/D' : Number(value).toLocaleString('es-AR');
}

// Interpreta lo que se tipeó en el filtro de fecha (día[/mes[/año]]),
// tolerando con o sin cero adelante y año de 2 o 4 dígitos:
// "8/8", "08/8", "08/08" y "08/08/26" tienen que interpretarse igual.
function parseTypedDate(text) {
  const parts = text.trim().split(/[\/\-\s]+/).filter(Boolean).map(Number);
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  const [day, month, yearRaw] = parts;
  let year = yearRaw;
  if (year !== undefined && year < 100) year += 2000; // "26" -> 2026
  return { day, month, year };
}

// Compara lo tipeado contra la fecha real (ISO 8601) de la fila. Si no
// mencionás mes o año, no se exigen (así "8" solo filtra por día).
// Si lo tipeado no se puede interpretar como fecha, no se filtra nada,
// para no terminar ocultando toda la tabla por un texto raro.
function dateHeaderFilterFunc(headerValue, rowValue) {
  if (!headerValue) return true;
  if (!rowValue) return false;
  const typed = parseTypedDate(headerValue);
  if (!typed) return true;
  const d = new Date(rowValue);
  if (typed.day !== d.getDate()) return false;
  if (typed.month !== undefined && typed.month !== d.getMonth() + 1) return false;
  if (typed.year !== undefined && typed.year !== d.getFullYear()) return false;
  return true;
}

const ACCOUNT_FILTER_DATALIST_ID = 'accountFilterOptions';

// Arma (o actualiza) la <datalist> con las cuentas presentes en los datos
// cargados: sin duplicados y ordenada alfabéticamente. El filtro sigue
// aceptando texto libre (no obliga a elegir de la lista).
function updateAccountFilterOptions(posts) {
  let datalist = document.getElementById(ACCOUNT_FILTER_DATALIST_ID);
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = ACCOUNT_FILTER_DATALIST_ID;
    document.body.appendChild(datalist);
  }
  const cuentas = [...new Set(posts.map((p) => p.account).filter((a) => a && a !== 'N/D'))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  datalist.innerHTML = cuentas.map((a) => `<option value="${a}"></option>`).join('');
}

// Editor de filtro a medida para la columna Cuenta: un input de texto común
// pero conectado a la <datalist> de arriba, así se puede escribir libremente
// O elegir de un desplegable con las cuentas ya vistas. Sigue filtrando por
// coincidencia parcial en cada tecla, vía headerFilterFunc: "like".
function accountFilterEditor(cell, onRendered, success) {
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('list', ACCOUNT_FILTER_DATALIST_ID);
  input.placeholder = 'Filtrar...';
  input.value = cell.getValue() || '';
  input.addEventListener('input', () => success(input.value));
  onRendered(() => input.focus());
  return input;
}

// -------------------------------------------------------------------------
// Benchmark por cuenta (panel desplegable de la fila): compara likes y
// comentarios del posteo contra la mediana histórica de ESA cuenta (nunca
// contra otras cuentas ni contra seguidores — ver src/accountStats.js). El
// backend ya manda "benchmark" armado en cada posteo de /api/monitoring/posts.
// -------------------------------------------------------------------------
const expandedRowIds = new Set();

function formatBenchmarkNumber(n) {
  if (n == null || !Number.isFinite(n)) return 'N/D';
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-AR', { maximumFractionDigits: 1 });
}

function formatBenchmarkRatio(ratio) {
  return ratio.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function benchmarkLevelClass(metric) {
  return `benchmark-${(metric && metric.level) || 'sin-referencia'}`;
}

function benchmarkLineText(label, metric) {
  if (!metric || metric.level === 'sin-referencia') {
    return `${label}: sin referencia (menos de 5 posteos recientes de esta cuenta)`;
  }
  return (
    `${label}: ${metric.level} — ${formatBenchmarkNumber(metric.value)}, contra una mediana de ` +
    `${formatBenchmarkNumber(metric.median)} en esta cuenta (${formatBenchmarkRatio(metric.ratio)}x)`
  );
}

function buildDetailPanel(data) {
  const panel = document.createElement('div');
  panel.className = 'row-detail-panel';
  const benchmark = data.benchmark || {};
  for (const [label, metric] of [
    ['Comentarios', benchmark.comments],
    ['Likes', benchmark.likes],
  ]) {
    const line = document.createElement('p');
    line.className = benchmarkLevelClass(metric);
    line.textContent = benchmarkLineText(label, metric);
    panel.appendChild(line);
  }
  return panel;
}

function toggleRowExpansion(row) {
  const id = row.getData().id;
  if (expandedRowIds.has(id)) expandedRowIds.delete(id);
  else expandedRowIds.add(id);
  if (typeof row.reformat === 'function') {
    row.reformat();
  } else if (monitoringTable) {
    monitoringTable.redraw(true);
  }
}

const MONITORING_COLUMNS = [
  {
    title: '',
    field: 'expand',
    headerSort: false,
    hozAlign: 'center',
    width: 44,
    formatter: (cell) => {
      const btn = document.createElement('button');
      btn.className = 'ico row-expand-btn';
      btn.title = 'Ver detalle';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
      btn.addEventListener('click', () => toggleRowExpansion(cell.getRow()));
      return btn;
    },
  },
  {
    title: 'Cuenta',
    field: 'account',
    headerFilter: accountFilterEditor,
    headerFilterFunc: 'like',
    formatter: (cell) => {
      const account = cell.getValue();
      if (!account || account === 'N/D') return 'N/D';
      const a = document.createElement('a');
      a.href = `https://www.instagram.com/${account}/`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `@${account}`;
      return a;
    },
  },
  {
    title: 'Título',
    field: 'title',
    headerFilter: 'input',
    cssClass: 'title-cell',
    // Que se lleve la mayor parte del ancho libre: es lo que más importa
    // ver bien (la previsualización del posteo).
    widthGrow: 4,
    formatter: (cell) => {
      const row = cell.getRow().getData();
      const title = cell.getValue() || '(sin clasificar)';
      const a = document.createElement('a');
      a.href = row.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = title;
      a.title = title;
      a.className = 'title-link';
      return a;
    },
  },
  {
    title: 'Sentimiento',
    field: 'sentiment',
    width: 140,
    hozAlign: 'center',
    headerHozAlign: 'left',
    headerFilter: 'list',
    headerFilterParams: {
      values: { '': 'Todos', positivo: 'Positivo', neutral: 'Neutral', negativo: 'Negativo' },
    },
    headerFilterFunc: '=',
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
    width: 110,
    hozAlign: 'center',
    headerHozAlign: 'left',
    headerFilter: 'input',
    headerFilterFunc: dateHeaderFilterFunc,
    headerFilterParams: { placeholder: 'ej: 8/8' },
    // Las fechas se guardan en ISO 8601 (2026-08-11T22:29:57.000Z): ese
    // formato ordena bien como texto plano, sin necesitar un parser de
    // fechas aparte (Tabulator/Luxon) solo para esta columna. El filtro sí
    // usa una función a medida (dateHeaderFilterFunc) porque el filtro
    // "like" por defecto compara contra ese string crudo, no contra lo que
    // se ve en pantalla.
    sorter: 'string',
    formatter: (cell) => {
      const row = cell.getRow().getData();
      const span = document.createElement('span');
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
    headerHozAlign: 'left',
    sorter: 'number',
    headerFilter: 'input',
    formatter: (cell) => formatCount(cell.getValue()),
  },
  {
    title: 'Comentarios',
    field: 'comments',
    hozAlign: 'right',
    headerHozAlign: 'left',
    sorter: 'number',
    headerFilter: 'input',
    formatter: (cell) => formatCount(cell.getValue()),
  },
  {
    title: 'Notificado',
    field: 'notified',
    width: 120,
    hozAlign: 'center',
    headerHozAlign: 'left',
    sorter: 'number',
    headerFilter: 'list',
    headerFilterParams: { values: { '': 'Todos', 1: 'Sí', 0: 'No' } },
    headerFilterFunc: '=',
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
    hozAlign: 'center',
    width: 72,
    formatter: (cell) => {
      const id = cell.getRow().getData().id;
      const btn = document.createElement('button');
      btn.className = 'ico del';
      btn.title = 'Borrar';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      btn.addEventListener('click', () => openDeleteModal(id));
      return btn;
    },
  },
];

let monitoringTable = null;

// "Mostrando X de Y posteos" (+ "(filtrados)" si hay algún filtro de
// encabezado activo). X son los resultados que pasan el filtro actual
// (getDataCount("active")), Y es el total sin filtrar.
function updateResultsCountText() {
  if (!monitoringTable) return;
  const total = monitoringTable.getDataCount();
  const filtrados = monitoringTable.getDataCount('active');
  const hayFiltrosActivos = monitoringTable.getFilters(true).length > 0;
  let texto = `Mostrando ${filtrados} de ${total} posteos`;
  if (hayFiltrosActivos) texto += ' (filtrados)';
  monitoringResultsCountEl.textContent = texto;
}

function ensureMonitoringTable(posts) {
  updateAccountFilterOptions(posts);

  if (monitoringTable) {
    monitoringTable.setData(posts);
    updateResultsCountText();
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
      const existingPanel = el.querySelector('.row-detail-panel');
      if (expandedRowIds.has(data.id)) {
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
  monitoringTable.on('pageLoaded', updateResultsCountText);
  monitoringTable.on('dataFiltered', updateResultsCountText);
  monitoringTable.on('tableBuilt', updateResultsCountText);
}

async function loadPosts() {
  try {
    const resp = await fetch(`/api/monitoring/posts?page=1&pageSize=${FETCH_ALL_PAGE_SIZE}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    monitoringLoadErrorEl.classList.add('hidden');
    ensureMonitoringTable(data.posts);
  } catch (err) {
    monitoringLoadErrorEl.textContent = 'No se pudo cargar la tabla. Reiniciá el servidor (para que tome el código nuevo) y recargá la página.';
    monitoringLoadErrorEl.classList.remove('hidden');
    console.error('Error cargando posteos detectados:', err);
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

loadConfig();
loadPosts();
