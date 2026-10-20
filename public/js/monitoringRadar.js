// ==========================================================================
// monitoringRadar.js — la franja oscura del Monitoreo de instagram.html
// (design/riel-radar-v3.html)
// --------------------------------------------------------------------------
// Lo carga solo instagram.html, después de monitoring.js, monitoringFeed.js
// y monitoringFeedPopup.js (scripts clásicos, mismo ámbito global: todo lo
// de acá lleva prefijo radar / RADAR_). Usa de monitoring.js
// withPlataforma.
//
// Estado de la escucha: "Escuchando. Última corrida a las HH:MM, la próxima
// a las HH:MM." con /api/monitoring/status (la última corrida guardada de
// esta plataforma y la próxima del cron). La franja no inventa horas: sin
// un dato, no se dice. Se pide al cargar, al terminar una corrida y cada 5
// minutos. Todo en hora de Argentina.
// ==========================================================================

const RADAR_TZ = 'America/Argentina/Buenos_Aires';
const RADAR_STATUS_EVERY_MS = 5 * 60 * 1000;
const RADAR_NOW_EVERY_MS = 30 * 1000;
const radarStatusEl = document.getElementById('radarStatus');
const radarNowEl = document.getElementById('radarNow');

const RADAR_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: RADAR_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const RADAR_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: RADAR_TZ }); // AAAA-MM-DD
const RADAR_SHORT_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: RADAR_TZ, day: '2-digit', month: '2-digit' });

// { nextRunAt, lastRunAt, runHours } de /api/monitoring/status, o null.
let radarStatus = null;

function radarDayOf(date) {
  return RADAR_DAY.format(date);
}

// "a las 12:00", "ayer a las 20:00", "mañana a las 08:00", "el 14/10 a las 16:00".
function radarWhen(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const time = RADAR_TIME.format(date);
  const day = radarDayOf(date);
  const today = radarDayOf(new Date());
  const yesterday = radarDayOf(new Date(Date.now() - 86400000));
  const tomorrow = radarDayOf(new Date(Date.now() + 86400000));
  if (day === today) return `a las ${time}`;
  if (day === yesterday) return `ayer a las ${time}`;
  if (day === tomorrow) return `mañana a las ${time}`;
  return `el ${RADAR_SHORT_DATE.format(date)} a las ${time}`;
}

function radarRenderStatus() {
  if (!radarStatusEl) return;
  const last = radarStatus && radarStatus.lastRunAt ? radarWhen(radarStatus.lastRunAt) : null;
  const next = radarStatus && radarStatus.nextRunAt ? radarWhen(radarStatus.nextRunAt) : null;
  let text = '';
  if (last && next) text = ` Última corrida ${last}, la próxima ${next}.`;
  else if (next) text = ` La próxima corrida es ${next}.`;
  else if (last) text = ` Última corrida ${last}.`;
  const lead = document.createElement('b');
  lead.textContent = 'Escuchando.';
  radarStatusEl.replaceChildren(lead, document.createTextNode(text));
}

async function radarLoadStatus() {
  try {
    const resp = await fetch(withPlataforma('/api/monitoring/status'));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    radarStatus = await resp.json();
  } catch (err) {
    // Sin estado, queda "Escuchando." solo: nada inventado.
    console.error('Error cargando el estado de la escucha:', err);
  }
  radarRenderStatus();
}

function radarRenderNow() {
  if (radarNowEl) radarNowEl.textContent = RADAR_TIME.format(new Date());
}

radarRenderStatus();
radarRenderNow();
radarLoadStatus();
setInterval(radarLoadStatus, RADAR_STATUS_EVERY_MS);
setInterval(radarRenderNow, RADAR_NOW_EVERY_MS);
