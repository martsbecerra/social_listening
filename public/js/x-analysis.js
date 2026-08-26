const urlInput = document.getElementById('url');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const progressFillEl = document.getElementById('progressFill');
const errorEl = document.getElementById('error');
const resultCard = document.getElementById('resultCard');
const reportEl = document.getElementById('report');
const metaEl = document.getElementById('meta');
const copyBtn = document.getElementById('copyBtn');
const waShareBtn = document.getElementById('waShareBtn');
const clearBtn = document.getElementById('clearBtn');
const csvBtn = document.getElementById('csvBtn');

const WA_TEXT_CAP = 4000;

let currentCsv = '';

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

const LOADING_MESSAGES = [
  'Buscando el hilo en X con Grok…',
  'Recopilando respuestas y tweets citados…',
  'Analizando el sentimiento con IA…',
  'Clasificando el hilo y cruzando el padrón…',
  'Armando el reporte ejecutivo…',
];

let progressTimer = null;
let messageTimer = null;

function startLoading() {
  let pct = 0;
  progressFillEl.style.width = '0%';

  progressTimer = setInterval(() => {
    const restante = 92 - pct;
    pct += Math.max(0.3, restante * 0.04);
    if (pct > 92) pct = 92;
    progressFillEl.style.width = pct + '%';
  }, 200);

  let msgIndex = 0;
  statusTextEl.textContent = LOADING_MESSAGES[0];
  messageTimer = setInterval(() => {
    msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
    statusTextEl.style.opacity = 0;
    setTimeout(() => {
      statusTextEl.textContent = LOADING_MESSAGES[msgIndex];
      statusTextEl.style.opacity = 1;
    }, 250);
  }, 3500);

  show(statusEl);
}

function stopLoading(exito) {
  clearInterval(progressTimer);
  clearInterval(messageTimer);

  if (exito) {
    progressFillEl.style.width = '100%';
    setTimeout(() => {
      hide(statusEl);
      progressFillEl.style.width = '0%';
    }, 350);
  } else {
    hide(statusEl);
    progressFillEl.style.width = '0%';
  }
}

function appendHandleLinks(el, text) {
  const skip = new Set(['desconocido', 'n/d']);
  const re = /@([A-Za-z0-9_]{1,15})\b/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const user = m[1];
    if (skip.has(user.toLowerCase())) {
      el.appendChild(document.createTextNode(m[0]));
    } else {
      const a = document.createElement('a');
      a.href = `https://x.com/${user}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[0];
      el.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function renderReportWithLinks(el, text) {
  el.textContent = '';
  const source = String(text || '');
  const urlRe = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+/gi;
  let last = 0;
  for (const m of source.matchAll(urlRe)) {
    if (m.index > last) appendHandleLinks(el, source.slice(last, m.index));
    let raw = m[0];
    let trail = '';
    while (/[),.;:!?]$/.test(raw)) {
      trail = raw.slice(-1) + trail;
      raw = raw.slice(0, -1);
    }
    const a = document.createElement('a');
    a.href = raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = raw;
    el.appendChild(a);
    if (trail) el.appendChild(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < source.length) appendHandleLinks(el, source.slice(last));
  if (!el.childNodes.length) el.textContent = source;
}

async function analyze() {
  const url = urlInput.value.trim();

  hide(errorEl);
  hide(resultCard);

  if (!url) {
    errorEl.textContent = 'Pegá primero el link de la publicación.';
    show(errorEl);
    return;
  }

  analyzeBtn.disabled = true;
  startLoading();

  try {
    const resp = await fetch('/api/x/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || 'Ocurrió un error inesperado.');
    }

    stopLoading(true);

    renderReportWithLinks(reportEl, data.report);
    metaEl.textContent = '';
    hide(metaEl);
    currentCsv = data.csv || '';
    show(resultCard);
  } catch (err) {
    stopLoading(false);
    errorEl.textContent = err.message;
    show(errorEl);
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(reportEl.textContent);
    copyBtn.textContent = '¡Copiado!';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
  } catch {
    copyBtn.textContent = 'No se pudo copiar';
  }
}

function openWhatsAppApp(encodedText) {
  const a = document.createElement('a');
  a.href = 'whatsapp://send?text=' + encodedText;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function truncateWaText(text) {
  if (text.length <= WA_TEXT_CAP) return text;
  let cut = WA_TEXT_CAP;
  if (/[\uD800-\uDBFF]$/.test(text.slice(0, cut))) cut -= 1;
  return text.slice(0, cut);
}

function shareWhatsApp() {
  const text = reportEl.textContent;
  if (!text || !text.trim()) return;
  openWhatsAppApp(encodeURIComponent(truncateWaText(text)));
}

function downloadCsv() {
  if (!currentCsv) return;

  const blob = new Blob(['\uFEFF' + currentCsv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const fecha = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reclamos-x-${fecha}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function clearAll() {
  urlInput.value = '';
  hide(resultCard);
  hide(errorEl);
  reportEl.textContent = '';
  metaEl.textContent = '';
  hide(metaEl);
  currentCsv = '';
  urlInput.focus();
}

analyzeBtn.addEventListener('click', analyze);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});
copyBtn.addEventListener('click', copyReport);
waShareBtn.addEventListener('click', shareWhatsApp);
clearBtn.addEventListener('click', clearAll);
csvBtn.addEventListener('click', downloadCsv);
