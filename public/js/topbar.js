// Estado de la escucha en la barra superior (diseño v4): la hora de la
// última corrida TERMINADA, de GET /api/monitoring/status (lastRunAt sale de
// monitoring_runs; en instagram.html y x.html, de esa plataforma; en el
// inicio, de cualquiera).
//   - Hace menos de 5 h: verde, "escuchando · 16:02". Si esa corrida no
//     salió del todo bien (lastRunEstado: incompleta o cortada; el backend
//     lo calcula, src/runStatus.js), punto ámbar quieto y "incompleta ·
//     16:02" o "cortada · 16:02", con lo que falló en el tooltip.
//   - Más vieja: gris, "última corrida · 21/10 08:03" (el tooltip suma lo
//     que falló, si falló algo).
//   - Ninguna: gris, "todavía no corrió".
// Sin respuesta del servidor queda "—" en gris: nunca una hora inventada.
// Se vuelve a pedir cada 5 minutos y al terminar "Actualizar ahora"; el color
// se recalcula cada minuto, así pasa a gris solo aunque no haya corridas.
// La hora va en la de Argentina, no en la del navegador.

const TOPBAR_TZ = 'America/Argentina/Buenos_Aires';
const TOPBAR_FRESH_MS = 5 * 60 * 60 * 1000;
const TOPBAR_FETCH_EVERY_MS = 5 * 60 * 1000;
const TOPBAR_RENDER_EVERY_MS = 60 * 1000;
const TOPBAR_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: TOPBAR_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const TOPBAR_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: TOPBAR_TZ, day: '2-digit', month: '2-digit' });
const TOPBAR_FULL = new Intl.DateTimeFormat('es-AR', { timeZone: TOPBAR_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

const topbarLiveEl = document.getElementById('topLive');
const topbarLiveTextEl = document.getElementById('topLiveText');
// La plataforma de la página (window.SL_PLATFORM la pone instagram.html o
// x.html); el inicio no tiene.
const topbarPlatform = window.SL_PLATFORM === 'instagram' || window.SL_PLATFORM === 'x' ? window.SL_PLATFORM : null;
// undefined: todavía no se sabe; null: nunca corrió; si no, la fecha.
let topbarLastRun;
// Cómo salió esa corrida (ok | incompleta | cortada | null) y qué falló, ya
// en textos para una persona (lastRunFallidas de /api/monitoring/status).
let topbarEstado = null;
let topbarFallidas = null;
const TOPBAR_WARN_STATES = ['incompleta', 'cortada'];

function topbarRender() {
  if (!topbarLiveEl || !topbarLiveTextEl) return;
  let text = '—';
  let fresh = false;
  let warn = false;
  let spoken = '';
  let tip = 'Todavía no se pudo leer el estado de la escucha.';
  if (topbarLastRun === null) {
    text = 'todavía no corrió';
    tip = 'Todavía no terminó ninguna corrida.';
  } else if (topbarLastRun instanceof Date) {
    const time = TOPBAR_TIME.format(topbarLastRun);
    fresh = Date.now() - topbarLastRun.getTime() < TOPBAR_FRESH_MS;
    const noOk = TOPBAR_WARN_STATES.includes(topbarEstado);
    warn = fresh && noOk;
    text = warn ? `${topbarEstado} · ${time}` : fresh ? `escuchando · ${time}` : `última corrida · ${TOPBAR_DATE.format(topbarLastRun)} ${time}`;
    const cuando = `${TOPBAR_FULL.format(topbarLastRun)} a las ${time}.`;
    const queFallo = noOk && topbarFallidas && topbarFallidas.tooltip ? topbarFallidas.tooltip : noOk ? `La corrida quedó ${topbarEstado}.` : '';
    tip = queFallo ? `${cuando}\n${queFallo}` : `${cuando}\nVerde si terminó hace menos de 5 horas.`;
    if (warn) spoken = `Escucha: ${topbarEstado}, ${time}${topbarFallidas && topbarFallidas.frase ? `, ${topbarFallidas.frase}` : ''}`;
  }
  topbarLiveEl.classList.toggle('off', !fresh);
  topbarLiveEl.classList.toggle('warn', warn);
  topbarLiveTextEl.textContent = text;
  topbarLiveEl.dataset.tipTitle = 'Última corrida terminada';
  topbarLiveEl.dataset.tip = tip;
  // Para un lector de pantalla: lo que el punto ámbar dice con el color.
  if (spoken) topbarLiveEl.setAttribute('aria-label', spoken);
  else topbarLiveEl.removeAttribute('aria-label');
}

async function topbarLoad() {
  try {
    const url = topbarPlatform
      ? `/api/monitoring/status?plataforma=${encodeURIComponent(topbarPlatform)}`
      : '/api/monitoring/status';
    // Automático (cada 5 min): no cuenta como actividad (public/js/sesion.js).
    const resp = await fetch(url, slAuto());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const last = data && data.lastRunAt ? new Date(data.lastRunAt) : null;
    topbarLastRun = last && Number.isFinite(last.getTime()) ? last : null;
    topbarEstado = (data && data.lastRunEstado) || null;
    topbarFallidas = (data && data.lastRunFallidas) || null;
  } catch (err) {
    // Se queda con lo último que supo; si nunca supo nada, "—".
    console.error('Error leyendo el estado de la escucha:', err);
  }
  topbarRender();
}

if (topbarLiveEl) {
  topbarRender();
  topbarLoad();
  setInterval(topbarLoad, TOPBAR_FETCH_EVERY_MS);
  setInterval(topbarRender, TOPBAR_RENDER_EVERY_MS);
  // Al terminar "Actualizar ahora" (monitoring.js avisa { run: 'end' }).
  if (typeof monitoringViewListeners !== 'undefined') {
    monitoringViewListeners.push((change) => {
      if (change && change.run === 'end') topbarLoad();
    });
  }
}
