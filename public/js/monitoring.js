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
const monitoringRowsEl = document.getElementById('monitoringRows');

const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfoEl = document.getElementById('pageInfo');

const PAGE_SIZE = 20;
const KEYWORDS_PREVIEW_COUNT = 2;
let currentPage = 1;
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

const SENTIMENT_LABELS = { positivo: 'Positivo', neutral: 'Neutral', negativo: 'Negativo' };

function renderPostsTable(posts, total) {
  if (!posts || posts.length === 0) {
    monitoringRowsEl.innerHTML = '<tr><td colspan="7" class="muted">Todavía no se detectó ningún posteo.</td></tr>';
  } else {
    monitoringRowsEl.innerHTML = posts.map((p) => {
      const detectado = new Date(p.detected_at).toLocaleString('es-AR');
      const notifiedBadge = p.notified
        ? '<span class="badge badge-yes">Sí</span>'
        : '<span class="badge badge-no">No</span>';
      const sentiment = p.sentiment || 'neutral';
      const sentimentBadge = `<span class="badge badge-${sentiment}">${SENTIMENT_LABELS[sentiment] || 'Neutral'}</span>`;
      const title = p.title || '(sin clasificar)';
      return `
        <tr>
          <td>@${p.account || 'N/D'}</td>
          <td class="title-cell" title="${title.replace(/"/g, '&quot;')}">${title}</td>
          <td>${sentimentBadge}</td>
          <td>${detectado}</td>
          <td><a href="${p.url}" target="_blank" rel="noopener">Ver posteo</a></td>
          <td>${notifiedBadge}</td>
          <td><button class="delete-row-btn" data-id="${p.id}" title="Borrar">✕</button></td>
        </tr>
      `;
    }).join('');
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  pageInfoEl.textContent = `Página ${currentPage} de ${totalPages} — ${total} posteos en total`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;

  monitoringRowsEl.querySelectorAll('.delete-row-btn').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
  });
}

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
  try {
    await fetch(`/api/monitoring/posts/${encodeURIComponent(pendingDeleteId)}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Error borrando el registro:', err);
  }
  closeDeleteModal();
  loadPosts();
}

async function loadPosts() {
  try {
    const resp = await fetch(`/api/monitoring/posts?page=${currentPage}&pageSize=${PAGE_SIZE}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderPostsTable(data.posts, data.total);
  } catch (err) {
    monitoringRowsEl.innerHTML = '<tr><td colspan="7" class="muted">No se pudo cargar la tabla. Reiniciá el servidor (para que tome el código nuevo) y recargá la página.</td></tr>';
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
    currentPage = 1;
    await loadPosts();
  } catch (err) {
    stopMonitorLoading(false);
    monitoringResultEl.textContent = `Error: ${err.message}`;
    monitoringResultEl.classList.remove('hidden');
  } finally {
    runNowBtn.disabled = false;
  }
}

function goToPrevPage() {
  if (currentPage <= 1) return;
  currentPage -= 1;
  loadPosts();
}

function goToNextPage() {
  currentPage += 1;
  loadPosts();
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
prevPageBtn.addEventListener('click', goToPrevPage);
nextPageBtn.addEventListener('click', goToNextPage);

loadConfig();
loadPosts();
