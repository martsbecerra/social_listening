const urlInput = document.getElementById('url');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const progressFillEl = document.getElementById('progressFill');
const errorEl = document.getElementById('error');
const resultCard = document.getElementById('resultCard');
const reportBeforeEl = document.getElementById('reportBefore');
const reportAfterEl = document.getElementById('reportAfter');
const metaEl = document.getElementById('meta');
const copyBtn = document.getElementById('copyBtn');
const waShareBtn = document.getElementById('waShareBtn');
const clearBtn = document.getElementById('clearBtn');
const csvBtn = document.getElementById('csvBtn');

const WA_TEXT_CAP = 4000;

// Guarda el CSV de reclamos de la última respuesta, para poder
// descargarlo cuando el usuario haga clic en "Descargar CSV".
let currentCsv = '';
let reportParts = { beforeTemas: '', afterTemas: '' };

const temasEditor = window.TemasConversacion.mount({
  listEl: document.getElementById('temasList'),
  addBtn: document.getElementById('temasAddBtn'),
});

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// --------------------------------------------------------------------
// Barra de progreso "simulada": el backend no nos avisa en tiempo real
// cómo va el proceso (es una sola llamada que responde al final), así
// que animamos una barra que avanza rápido al principio y se va
// frenando a medida que se acerca al 92% — nunca llega sola al 100%,
// eso lo hacemos recién cuando la respuesta realmente vuelve. Así el
// usuario siempre ve movimiento mientras espera.
// --------------------------------------------------------------------
const LOADING_MESSAGES = [
  'Extrayendo comentarios de Instagram…',
  'Recopilando datos del posteo…',
  'Analizando el sentimiento con IA…',
  'Clasificando comentarios positivos y negativos…',
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
    // Completamos la barra al 100% como remate visual antes de ocultarla.
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

function formatCostUsd(usd, source) {
  if (!Number.isFinite(usd)) return '';
  const formatted = usd.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
  if (source === 'openrouter') return formatted;
  if (source === 'estimate_env' || source === 'estimate_anthropic') {
    return `~${formatted} est.`;
  }
  return formatted;
}

function formatMetaLine(m) {
  const commentPart = m.muestraParcial
    ? `${m.comentariosAnalizados} comentarios analizados (muestra priorizada de ${m.comentariosUnicos} únicos)`
    : `${m.comentariosAnalizados ?? m.comentariosExtraidos} comentarios analizados`;

  const t = m.tokenUsage;
  if (!t || !Number.isFinite(t.totalTokens)) return commentPart;

  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('es-AR') : '—');
  const tokenPart = `${fmt(t.totalTokens)} tokens LLM (${fmt(t.inputTokens)} entrada · ${fmt(t.outputTokens)} salida)`;
  const costPart = formatCostUsd(t.costUsd, t.costSource);
  const parts = [commentPart, tokenPart];
  if (costPart) parts.push(`costo LLM ${costPart}`);
  if (m.llmAttempts > 1) parts.push(`${m.llmAttempts} intentos LLM`);
  return parts.join(' · ');
}

async function analyze() {
  const url = urlInput.value.trim();

  // Reiniciamos la interfaz.
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
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      // El backend nos manda un mensaje de error claro en data.error.
      throw new Error(data.error || 'Ocurrió un error inesperado.');
    }

    stopLoading(true);

    reportBeforeEl.textContent = data.reportParts?.beforeTemas || data.report || '';
    reportAfterEl.textContent = data.reportParts?.afterTemas || '';
    reportParts = {
      beforeTemas: reportBeforeEl.textContent,
      afterTemas: reportAfterEl.textContent,
    };
    temasEditor.setTemas(data.temas || []);
    metaEl.textContent = formatMetaLine(data.meta || {});
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

// Copiar el reporte al portapapeles (útil para pegar en WhatsApp).
function currentReportText() {
  return window.TemasConversacion.assemble(
    reportParts.beforeTemas,
    temasEditor.getTemas(),
    reportParts.afterTemas
  );
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(currentReportText());
    copyBtn.textContent = '¡Copiado!';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
  } catch {
    copyBtn.textContent = 'No se pudo copiar';
  }
}

// Abre WhatsApp Desktop/móvil con el esquema nativo. api.whatsapp.com/send
// sin teléfono muestra "Enlace incorrecto"; wa.me rompe los emojis al redirigir.
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
  const text = currentReportText();
  if (!text || !text.trim()) return;
  openWhatsAppApp(encodeURIComponent(truncateWaText(text)));
}

// Descarga el CSV de reclamos (dirección + temática) como archivo .csv.
function downloadCsv() {
  if (!currentCsv) return;

  // El "﻿" (BOM) al principio hace que Excel en Windows abra los
  // acentos y la "ñ" correctamente en vez de mostrar caracteres raros.
  const blob = new Blob(['﻿' + currentCsv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const fecha = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const a = document.createElement('a');
  a.href = url;
  a.download = `reclamos-vecinos-${fecha}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Limpia todo y deja la app lista para un nuevo análisis.
function clearAll() {
  urlInput.value = '';
  hide(resultCard);
  hide(errorEl);
  reportBeforeEl.textContent = '';
  reportAfterEl.textContent = '';
  reportParts = { beforeTemas: '', afterTemas: '' };
  temasEditor.setTemas([]);
  metaEl.textContent = '';
  currentCsv = '';
  urlInput.focus();
}

analyzeBtn.addEventListener('click', analyze);
// Permite enviar con Enter desde el input.
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});
copyBtn.addEventListener('click', copyReport);
waShareBtn.addEventListener('click', shareWhatsApp);
clearBtn.addEventListener('click', clearAll);
csvBtn.addEventListener('click', downloadCsv);
