// Estado de la escucha en la barra superior (diseño v4): la hora de la
// última corrida TERMINADA, de GET /api/monitoring/status (lastRunAt sale de
// monitoring_runs; en instagram.html y x.html, de esa plataforma; en el
// inicio, de cualquiera).
//   - Hace menos de 5 h: verde, "escuchando · 16:02".
//   - Más vieja: gris, "última corrida · 21/10 08:03".
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

function topbarRender() {
  if (!topbarLiveEl || !topbarLiveTextEl) return;
  let text = '—';
  let fresh = false;
  let tip = 'Todavía no se pudo leer el estado de la escucha.';
  if (topbarLastRun === null) {
    text = 'todavía no corrió';
    tip = 'Todavía no terminó ninguna corrida.';
  } else if (topbarLastRun instanceof Date) {
    const time = TOPBAR_TIME.format(topbarLastRun);
    fresh = Date.now() - topbarLastRun.getTime() < TOPBAR_FRESH_MS;
    text = fresh ? `escuchando · ${time}` : `última corrida · ${TOPBAR_DATE.format(topbarLastRun)} ${time}`;
    tip = `${TOPBAR_FULL.format(topbarLastRun)} a las ${time}.\nVerde si terminó hace menos de 5 horas.`;
  }
  topbarLiveEl.classList.toggle('off', !fresh);
  topbarLiveTextEl.textContent = text;
  topbarLiveEl.dataset.tipTitle = 'Última corrida terminada';
  topbarLiveEl.dataset.tip = tip;
}

async function topbarLoad() {
  try {
    const url = topbarPlatform
      ? `/api/monitoring/status?plataforma=${encodeURIComponent(topbarPlatform)}`
      : '/api/monitoring/status';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const last = data && data.lastRunAt ? new Date(data.lastRunAt) : null;
    topbarLastRun = last && Number.isFinite(last.getTime()) ? last : null;
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
