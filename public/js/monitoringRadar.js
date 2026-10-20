// ==========================================================================
// monitoringRadar.js — la franja oscura del Monitoreo de instagram.html
// (design/riel-radar-v3.html)
// --------------------------------------------------------------------------
// Lo carga solo instagram.html, después de monitoring.js, monitoringFeed.js
// y monitoringFeedPopup.js (scripts clásicos, mismo ámbito global: todo lo
// de acá lleva prefijo radar / RADAR_). Usa de monitoring.js
// withPlataforma, monitoringTable, monitoringViewListeners, formatCount,
// formatBenchmarkRatio y BENCHMARK_LEVEL_NAMES; del pop-up, openFeedPopSolo.
//
// Estado de la escucha: "Escuchando. Última corrida a las HH:MM, la próxima
// a las HH:MM." con /api/monitoring/status (la última corrida guardada de
// esta plataforma y la próxima del cron). La franja no inventa horas: sin
// un dato, no se dice. Se pide al cargar, al terminar una corrida y cada 5
// minutos. Todo en hora de Argentina.
//
// El radar: las publicaciones de HOY de la tabla ya filtrada (el mismo
// conjunto que el feed), en un canvas.
//   - x: la hora de publicación. y: la razón del alcance
//     (benchmark.top.ratio), en escala logarítmica entre 0,6 y 3, con la
//     línea de "alto" en 1,5 y la de "lo habitual" en 1. La razón lleva
//     colchón (src/reachRule.js): ningún texto dice "N veces lo habitual".
//   - Color: el sentimiento (sin clasificar cuenta como neutral). Radio: la
//     raíz de los comentarios. Alcance alto: halo y un anillo que late.
//   - Sin benchmark.top (la cuenta todavía no tiene mediana): círculo hueco
//     sobre "lo habitual", y el tooltip lo avisa.
//   - La línea de "ahora" es la hora real; a su derecha, la zona atenuada.
//     Las marcas de corrida salen de runHours (/api/monitoring/status).
//   - Mouse sobre un pulso: tooltip y clase "hot" en la tira, la tarjeta o
//     la fila de ese posteo; al revés, una tira o una tarjeta resaltan su
//     pulso. Clic: el pop-up de ese posteo solo.
//   - "Actualizar ahora": un barrido al arrancar; al terminar, los posteos
//     nuevos de hoy entran con tres ondas.
//   - La animación corre solo con la franja a la vista y algo que animar; con
//     prefers-reduced-motion no hay latido, barrido ni ondas.
// Todo dato del posteo entra por textContent.
// ==========================================================================

const RADAR_TZ = 'America/Argentina/Buenos_Aires';
const RADAR_STATUS_EVERY_MS = 5 * 60 * 1000;
const RADAR_NOW_EVERY_MS = 30 * 1000;
const radarStatusEl = document.getElementById('radarStatus');
const radarNowEl = document.getElementById('radarNow');

const RADAR_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: RADAR_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const RADAR_HOUR_MINUTE = new Intl.DateTimeFormat('en-GB', { timeZone: RADAR_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const RADAR_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: RADAR_TZ }); // AAAA-MM-DD
const RADAR_SHORT_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: RADAR_TZ, day: '2-digit', month: '2-digit' });

// { nextRunAt, lastRunAt, runHours } de /api/monitoring/status, o null.
let radarStatus = null;

function radarDayOf(date) {
  return RADAR_DAY.format(date);
}

// Hora del día en Argentina, con decimales (13:30 -> 13.5).
function radarHourOf(date) {
  const [h, m] = RADAR_HOUR_MINUTE.format(date).split(':').map(Number);
  return h + m / 60;
}

// "a las 12:00", "ayer a las 20:00", "mañana a las 08:00", "el 14/10 a las 16:00".
function radarWhen(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const time = RADAR_TIME.format(date);
  const day = radarDayOf(date);
  if (day === radarDayOf(new Date())) return `a las ${time}`;
  if (day === radarDayOf(new Date(Date.now() - 86400000))) return `ayer a las ${time}`;
  if (day === radarDayOf(new Date(Date.now() + 86400000))) return `mañana a las ${time}`;
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
  radarRenderEmpty();
  radarRequestDraw();
}

function radarRenderNow() {
  if (radarNowEl) radarNowEl.textContent = RADAR_TIME.format(new Date());
}

// ---------------------------------------------------------------------------
// El canvas
// ---------------------------------------------------------------------------
const RADAR_RATIO_MIN = 0.6;
const RADAR_RATIO_MAX = 3;
const RADAR_RATIO_HIGH = 1.5;
const RADAR_PAD = { l: 34, r: 24, t: 26, b: 44 };
const RADAR_MAX_RADIUS = 30;
const RADAR_SWEEP_MS = 2400;
const RADAR_RIPPLE_MS = 1400;
const RADAR_RIPPLE_DELAYS = [0, 350, 700];
const RADAR_APPEAR_MS = 500;
const RADAR_COLORS = { positivo: '#63c7a2', neutral: '#d9c5b2', negativo: '#e07a58' };
const RADAR_EMPTY_NO_POSTS = 'Todavía no hay publicaciones de hoy.';
const RADAR_EMPTY_NO_CANVAS = 'No se puede dibujar el radar en este navegador.';
const RADAR_EMPTY_FILTERED = 'Ninguna publicación de hoy coincide con los filtros.';

const radarEl = document.getElementById('radar');
const radarCanvasEl = document.getElementById('radarCanvas');
const radarTipEl = document.getElementById('radarTip');
const radarEmptyEl = document.getElementById('radarEmpty');
const radarSkyEl = document.querySelector('#tab-monitoring .sky');
const radarPanelEl = document.getElementById('tab-monitoring');
const radarCtx = radarCanvasEl && typeof radarCanvasEl.getContext === 'function' ? radarCanvasEl.getContext('2d') : null;
const radarReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let radarW = 0;
let radarH = 0;
// { x, y, r, post, top, color, hollow }
let radarDots = [];
// Hay datos de la tabla (antes de eso no se dice "no hay publicaciones").
let radarHasData = false;
let radarTodayTotal = 0;
let radarHotId = null;
let radarRipples = []; // { x, y, r, color, start }
let radarSweep = null; // { start }
// Ids que tienen que entrar con ondas cuando lleguen a la tabla.
let radarPendingNew = new Set();
// id -> cuándo empezó a aparecer (el pulso crece desde 0).
const radarAppear = new Map();
let radarFirstLayout = true;
let radarFrame = null;
let radarInView = true;
const radarT0 = performance.now();

function radarHexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const radarX = (hour) => RADAR_PAD.l + (hour / 24) * (radarW - RADAR_PAD.l - RADAR_PAD.r);
function radarY(ratio) {
  const span = Math.log(RADAR_RATIO_MAX) - Math.log(RADAR_RATIO_MIN);
  const t = Math.max(0, Math.min(1, (Math.log(ratio) - Math.log(RADAR_RATIO_MIN)) / span));
  return radarH - RADAR_PAD.b - t * (radarH - RADAR_PAD.t - RADAR_PAD.b);
}
function radarRadius(post) {
  const comments = Number(post.comments);
  return Math.min(RADAR_MAX_RADIUS, 4 + Math.sqrt(Number.isFinite(comments) && comments > 0 ? comments : 0) * 0.42);
}
function radarTopOf(post) {
  const top = post && post.benchmark && post.benchmark.top;
  return top && Number.isFinite(top.ratio) ? top : null;
}

function radarResize() {
  if (!radarCtx || !radarEl) return;
  const rect = radarEl.getBoundingClientRect();
  if (!rect.width) return;
  radarW = rect.width;
  radarH = rect.height;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  radarCanvasEl.width = Math.round(radarW * dpr);
  radarCanvasEl.height = Math.round(radarH * dpr);
  radarCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Los posteos de hoy entre las filas activas (filtradas) de la tabla.
function radarTodayPosts() {
  if (typeof monitoringTable === 'undefined' || !monitoringTable) return null;
  const today = radarDayOf(new Date());
  const isToday = (post) => post.posted_at && radarDayOf(new Date(post.posted_at)) === today;
  radarTodayTotal = monitoringTable.getData().filter(isToday).length;
  return monitoringTable.getData('active').filter(isToday);
}

function radarLayout() {
  const posts = radarTodayPosts();
  if (!posts) return;
  radarHasData = true;
  const now = performance.now();
  // Al entrar, los pulsos aparecen de a uno, en el orden del día.
  if (radarFirstLayout && posts.length && !radarReducedMotion.matches) {
    [...posts]
      .sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at))
      .forEach((post, i) => radarAppear.set(post.id, now + 300 + i * 70));
  }
  if (posts.length) radarFirstLayout = false;

  radarDots = posts.map((post) => {
    const top = radarTopOf(post);
    return {
      x: radarX(radarHourOf(new Date(post.posted_at))),
      y: radarY(top ? top.ratio : 1),
      r: radarRadius(post),
      post,
      top,
      color: RADAR_COLORS[post.sentiment] || RADAR_COLORS.neutral,
      hollow: !top,
    };
  });

  // Los nuevos de "Actualizar ahora" que ya llegaron: ondas.
  if (radarPendingNew.size) {
    let order = 0;
    radarDots.forEach((dot) => {
      if (!radarPendingNew.has(dot.post.id)) return;
      radarPendingNew.delete(dot.post.id);
      if (radarReducedMotion.matches) return;
      // De a uno: cada posteo nuevo, un cuarto de segundo después del anterior.
      const start = now + order * 250;
      order += 1;
      radarAppear.set(dot.post.id, start);
      RADAR_RIPPLE_DELAYS.forEach((delay) => radarRipples.push({ x: dot.x, y: dot.y, r: dot.r, color: dot.color, start: start + delay }));
    });
  }
  radarRenderEmpty();
}

function radarRenderEmpty() {
  if (!radarEmptyEl) return;
  let text = '';
  if (!radarCtx) text = RADAR_EMPTY_NO_CANVAS;
  else if (radarHasData && radarDots.length === 0) {
    if (radarTodayTotal > 0) text = RADAR_EMPTY_FILTERED;
    else {
      const next = radarStatus && radarStatus.nextRunAt ? radarWhen(radarStatus.nextRunAt) : null;
      text = next ? `${RADAR_EMPTY_NO_POSTS} La próxima corrida es ${next}.` : RADAR_EMPTY_NO_POSTS;
    }
  }
  radarEmptyEl.textContent = text;
  radarEmptyEl.classList.toggle('hidden', !text);
}

function radarDrawGrid(nowHour) {
  const ctx = radarCtx;
  const top = RADAR_PAD.t - 6;
  const bottom = radarH - RADAR_PAD.b;
  ctx.font = '11px "DM Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let h = 0; h <= 24; h += 2) {
    const x = radarX(h);
    ctx.strokeStyle = h % 4 === 0 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    if (h % 4 === 0) {
      ctx.fillStyle = 'rgba(169,194,183,.8)';
      ctx.fillText(`${String(h).padStart(2, '0')}:00`, x, bottom + 8);
    }
  }

  // Alto (1,5) y lo habitual (1).
  const yHigh = radarY(RADAR_RATIO_HIGH);
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = 'rgba(99,199,162,.45)';
  ctx.beginPath();
  ctx.moveTo(RADAR_PAD.l, yHigh);
  ctx.lineTo(radarW - RADAR_PAD.r, yHigh);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(159,224,196,.9)';
  ctx.fillText('alto: razón 1,5 contra su cuenta', RADAR_PAD.l + 4, yHigh - 4);
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(169,194,183,.55)';
  ctx.fillText('lo habitual', RADAR_PAD.l + 4, radarY(1) + 4);

  // Lo que todavía no pasó, atenuado.
  const xNow = radarX(nowHour);
  ctx.fillStyle = 'rgba(2,30,25,.45)';
  ctx.fillRect(xNow, top, radarW - RADAR_PAD.r - xNow, bottom - top);

  // Corridas del día: las que ya pasaron y las que faltan.
  const hours = radarStatus && Array.isArray(radarStatus.runHours) ? radarStatus.runHours : [];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  hours.forEach((h) => {
    const x = radarX(h);
    const past = h <= nowHour;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = past ? 'rgba(99,199,162,.55)' : 'rgba(255,255,255,.18)';
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = past ? 'rgba(159,224,196,.9)' : 'rgba(169,194,183,.5)';
    ctx.fillText(past ? 'corrida' : 'próxima', x, bottom + 22);
  });
  return xNow;
}

function radarDraw(ts) {
  if (!radarCtx || !radarW) return;
  const ctx = radarCtx;
  const reduced = radarReducedMotion.matches;
  const t = ((ts || performance.now()) - radarT0) / 1000;
  const now = performance.now();
  ctx.clearRect(0, 0, radarW, radarH);
  const nowHour = radarHourOf(new Date());
  const xNow = radarDrawGrid(nowHour);
  const top = RADAR_PAD.t - 6;
  const bottom = radarH - RADAR_PAD.b;

  // El barrido de "Actualizar ahora".
  if (radarSweep && !reduced) {
    const k = Math.min(1, (now - radarSweep.start) / RADAR_SWEEP_MS);
    const x = RADAR_PAD.l + k * (xNow - RADAR_PAD.l);
    const g = ctx.createLinearGradient(x - 160, 0, x, 0);
    g.addColorStop(0, 'rgba(99,199,162,0)');
    g.addColorStop(1, 'rgba(99,199,162,.22)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 160, top, 160, bottom - top);
    ctx.fillStyle = 'rgba(159,224,196,.9)';
    ctx.fillRect(x, top, 1.5, bottom - top);
    if (k >= 1) radarSweep = null;
  } else {
    radarSweep = null;
  }

  // Ahora.
  const breathe = reduced ? 0.6 : 0.5 + 0.3 * Math.sin(t * 1.6);
  ctx.strokeStyle = `rgba(255,255,255,${0.35 + breathe * 0.3})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(xNow, top);
  ctx.lineTo(xNow, bottom);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '500 11px "DM Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('ahora', xNow, RADAR_PAD.t - 22);

  // Ondas.
  radarRipples = radarRipples.filter((rp) => now - rp.start < RADAR_RIPPLE_MS);
  radarRipples.forEach((rp) => {
    const k = (now - rp.start) / RADAR_RIPPLE_MS;
    if (k < 0) return;
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, rp.r + k * 46, 0, Math.PI * 2);
    ctx.strokeStyle = radarHexA(rp.color, (1 - k) * 0.7);
    ctx.lineWidth = 1.5 * (1 - k) + 0.5;
    ctx.stroke();
  });

  // Los pulsos.
  radarDots.forEach((dot) => {
    const isHot = radarHotId === dot.post.id;
    const high = dot.top && dot.top.level === 'alto';
    const appearAt = radarAppear.get(dot.post.id);
    const appear = appearAt === undefined || reduced ? 1 : Math.max(0, Math.min(1, (now - appearAt) / RADAR_APPEAR_MS));
    if (appear >= 1) radarAppear.delete(dot.post.id);
    const scale = 1 - Math.pow(1 - appear, 3);
    if (scale <= 0) return;

    if (high && !reduced) {
      const k = (t * 0.5 + (dot.x % 37) * 0.027) % 1;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.r + 4 + k * 16, 0, Math.PI * 2);
      ctx.strokeStyle = radarHexA(dot.color, (1 - k) * 0.5);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r * scale + (isHot ? 3 : 0), 0, Math.PI * 2);
    if (dot.hollow) {
      ctx.strokeStyle = radarHexA(dot.color, isHot ? 1 : 0.85);
      ctx.lineWidth = isHot ? 2.5 : 1.8;
      ctx.stroke();
    } else {
      ctx.shadowColor = high || isHot ? dot.color : 'transparent';
      ctx.shadowBlur = high ? 16 : isHot ? 12 : 0;
      ctx.fillStyle = radarHexA(dot.color, isHot ? 1 : 0.88);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (isHot) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Animación con freno
// ---------------------------------------------------------------------------
function radarVisible() {
  return Boolean(radarCtx) && radarInView && !document.hidden && radarPanelEl && !radarPanelEl.classList.contains('hidden');
}

// ¿Hay algo que se mueva? Con movimiento reducido, nada.
function radarAnimating() {
  if (radarReducedMotion.matches) return false;
  return true; // la línea de "ahora" respira y los altos laten
}

function radarLoop(ts) {
  radarFrame = null;
  if (!radarVisible()) return;
  radarDraw(ts);
  if (radarAnimating()) radarFrame = requestAnimationFrame(radarLoop);
}

// Un dibujo (o retomar la animación) apenas se pueda.
function radarRequestDraw() {
  if (radarFrame !== null || !radarVisible()) return;
  radarFrame = requestAnimationFrame(radarLoop);
}

// ---------------------------------------------------------------------------
// Hover cruzado, tooltip y clic
// ---------------------------------------------------------------------------
function radarHitTest(mx, my) {
  let best = null;
  let bestDist = Infinity;
  radarDots.forEach((dot) => {
    const dist = Math.hypot(dot.x - mx, dot.y - my);
    if (dist < dot.r + 7 && dist < bestDist) {
      bestDist = dist;
      best = dot;
    }
  });
  return best;
}

// Las tiras de "Se despegaron", las tarjetas del feed y las filas de la tabla
// de ese posteo.
function radarElementsOf(id) {
  const value = window.CSS && CSS.escape ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
  return document.querySelectorAll(`[data-post-id="${value}"], .feed-card[data-id="${value}"]`);
}

function radarSetHot(id) {
  if (radarHotId === id) return;
  if (radarHotId !== null) radarElementsOf(radarHotId).forEach((el) => el.classList.remove('hot'));
  radarHotId = id;
  if (id !== null) radarElementsOf(id).forEach((el) => el.classList.add('hot'));
  radarRequestDraw();
}

function radarTipText(dot) {
  const post = dot.post;
  const parts = [`${formatCount(post.likes)} likes, ${formatCount(post.comments)} comentarios.`];
  if (dot.top) {
    const level = BENCHMARK_LEVEL_NAMES[dot.top.level] || dot.top.level;
    parts.push(`Alcance ${level}, razón ${formatBenchmarkRatio(dot.top.ratio)} en ${dot.top.label}.`);
  } else {
    parts.push('Sin referencia de su cuenta: todavía no hay con qué comparar.');
  }
  return parts.join(' ');
}

function radarShowTip(dot) {
  if (!radarTipEl) return;
  const post = dot.post;
  const account = post.account && post.account !== 'N/D' ? `@${post.account}` : 'N/D';
  const who = document.createElement('b');
  who.textContent = account;
  const title = document.createElement('span');
  title.className = 't';
  title.textContent = post.title || '(sin clasificar)';
  const meta = document.createElement('span');
  meta.className = 'm';
  meta.textContent = radarTipText(dot);
  radarTipEl.replaceChildren(who, document.createTextNode(`, ${RADAR_TIME.format(new Date(post.posted_at))}`), title, meta);

  const left = Math.max(150, Math.min(radarW - 150, dot.x));
  radarTipEl.style.left = `${left}px`;
  radarTipEl.classList.add('on');
  // Abajo del pulso; si no entra, arriba.
  const below = dot.y + dot.r + 12;
  const height = radarTipEl.offsetHeight;
  radarTipEl.style.top = `${below + height > radarH + 40 ? Math.max(0, dot.y - dot.r - 12 - height) : below}px`;
}

function radarHideTip() {
  if (radarTipEl) radarTipEl.classList.remove('on');
}

function radarPointerAt(e) {
  const rect = radarCanvasEl.getBoundingClientRect();
  return radarHitTest(e.clientX - rect.left, e.clientY - rect.top);
}

if (radarCanvasEl && radarCtx) {
  radarCanvasEl.addEventListener('mousemove', (e) => {
    const dot = radarPointerAt(e);
    radarSetHot(dot ? dot.post.id : null);
    radarCanvasEl.style.cursor = dot ? 'pointer' : 'crosshair';
    if (dot) radarShowTip(dot);
    else radarHideTip();
  });
  radarCanvasEl.addEventListener('mouseleave', () => {
    radarSetHot(null);
    radarHideTip();
  });
  radarCanvasEl.addEventListener('click', (e) => {
    const dot = radarPointerAt(e);
    if (dot && typeof openFeedPopSolo === 'function') openFeedPopSolo(dot.post.id);
  });
}

// Al revés: una tira de "Se despegaron" o una tarjeta del feed con el mouse
// encima resaltan su pulso.
function radarHoverSource(target) {
  return target && target.closest ? target.closest('.hl-tops [data-post-id], .feed-card[data-id]') : null;
}
document.addEventListener('mouseover', (e) => {
  const el = radarHoverSource(e.target);
  if (el) radarSetHot(el.dataset.postId || el.dataset.id);
});
document.addEventListener('mouseout', (e) => {
  const el = radarHoverSource(e.target);
  if (el && !el.contains(e.relatedTarget)) radarSetHot(null);
});

// ---------------------------------------------------------------------------
// Avisos de monitoring.js y arranque
// ---------------------------------------------------------------------------
function radarOnMonitoringChange(change) {
  if (change && change.run === 'start') {
    if (!radarReducedMotion.matches) radarSweep = { start: performance.now() };
    radarRequestDraw();
    return false;
  }
  if (change && change.run === 'end') {
    (change.newIds || []).forEach((id) => radarPendingNew.add(id));
    radarLayout();
    radarRenderNow();
    radarLoadStatus();
    radarRequestDraw();
    return false;
  }
  if (change && (change.goToId !== undefined || change.ignoredId !== undefined)) {
    if (change.ignoredId !== undefined) {
      radarLayout();
      radarRequestDraw();
    }
    return false;
  }
  radarLayout();
  radarRequestDraw();
  return false;
}

if (radarEl) {
  if (!radarCtx) radarEl.classList.add('no-canvas');
  monitoringViewListeners.push(radarOnMonitoringChange);

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      radarResize();
      radarLayout();
      radarRequestDraw();
    }).observe(radarEl);
  }
  if (radarSkyEl && typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      radarInView = entries.some((entry) => entry.isIntersecting);
      radarRequestDraw();
    }).observe(radarSkyEl);
  }
  document.addEventListener('visibilitychange', radarRequestDraw);
  // La solapa del Monitoreo vuelve a estar a la vista.
  if (radarPanelEl && typeof MutationObserver === 'function') {
    new MutationObserver(radarRequestDraw).observe(radarPanelEl, { attributes: true, attributeFilter: ['class'] });
  }
  radarReducedMotion.addEventListener('change', radarRequestDraw);
  // El canvas dibuja texto: con las fuentes cargadas, de nuevo.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(radarRequestDraw);

  radarResize();
  radarRenderEmpty();
}

radarRenderStatus();
radarRenderNow();
radarLoadStatus();
setInterval(radarLoadStatus, RADAR_STATUS_EVERY_MS);
setInterval(() => {
  radarRenderNow();
  // Con movimiento reducido no hay animación: la línea de ahora se mueve acá.
  radarRequestDraw();
}, RADAR_NOW_EVERY_MS);
