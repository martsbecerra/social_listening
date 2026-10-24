// --------------------------------------------------------------------
// La visual del login (index.html y login-verify.html), diseño v4: la
// constelación de los temas de la semana, el ticker "tema · N
// publicaciones", los contadores y las horas de las corridas. Todo sale de
// GET /api/public/resumen, la única ruta de datos sin sesión
// (src/publicResumen.js): temas y cantidades, nunca una publicación.
//
// La constelación es un canvas (#lgNet): un círculo por tema (el radio por
// su cantidad, el color --cat-N por su lugar en la config, como en la app)
// y puntitos sin nombre unidos a dos temas, con una chispa que viaja por
// cada hilo; en una franja baja van los temas que entran sin encimarse. El
// ticker va entre los textos y los contadores, donde haya lugar (si no,
// no va). Con movimiento reducido se dibuja un cuadro quieto; con la
// pestaña oculta o la visual fuera de la pantalla el dibujo se frena (no
// queda un requestAnimationFrame dando vueltas). Sin datos, solo los
// puntitos, sin ticker, y los contadores en "—".
//
// Script clásico: todo lo suyo lleva prefijo lg / LG_. Los contadores
// usan kpiCountUp (kpi.js, que va antes). Todo texto de datos entra por
// textContent (o por fillText, en el canvas).
// --------------------------------------------------------------------
const LG_INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const LG_DOTS = 18;
const LG_TICKER_PX_PER_S = 14;
const LG_LABEL_FONT = '600 12px Sora, system-ui, sans-serif';
const LG_ROW_MIN_PX = 56; // una fila de la constelación: el círculo, su nombre y el vaivén
const LG_TICKER_MIN_H = 150; // menos alto que esto (tres filas), el ticker no va
const LG_TICKER_MIN_W = 230; // menos ancho, "N publicaciones · 7 días" no entra
const LG_NUMBER_WORDS = ['', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho'];
const lgReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const lgVis = document.querySelector('.lg-vis');
const lgCanvas = document.getElementById('lgNet');
const lgCtx = lgCanvas && lgCanvas.getContext ? lgCanvas.getContext('2d') : null;

let lgWidth = 0;
let lgHeight = 0;
let lgTime = 0;
let lgLastTick = 0;
let lgNodes = [];
let lgEdges = [];
let lgFrame = 0; // el requestAnimationFrame en curso (0: frenado)
let lgOnScreen = true;
let lgTemas = [];
let lgPalette = { accent: '', fg: '' }; // los colores de la visual, leídos al armarla

function lgNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Al azar pero siempre igual (mulberry32): la constelación no cambia de
// una carga a la otra.
function lgRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// El color de un tema: el mismo --cat-N que le da la app (temaColor en
// postView.js), por su lugar en la lista de categorías.
function lgCatVar(orden) {
  return Number.isInteger(orden) && orden >= 0 ? `--cat-${(orden % 12) + 1}` : '--cat-otras';
}

function lgToken(name) {
  return getComputedStyle(lgVis).getPropertyValue(name).trim();
}

// ---------- la constelación ----------

// Dónde caben los temas: en el hueco más alto que dejan los textos (en
// escritorio, entre el subtítulo y los contadores; en celular, debajo de
// los contadores) y a la izquierda del ticker, si se ve.
// Las medidas son las del layout (offset*), sin las animaciones de entrada
// de los textos, que los corren unos píxeles mientras suben.
function lgArea() {
  const edges = (selector, fallback) => {
    const el = lgVis.querySelector(selector);
    if (!el || el.offsetParent !== lgVis) return fallback;
    return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight };
  };
  const sub = edges('.sub', { top: 0, bottom: lgHeight * 0.3 });
  const stats = edges('.lg-stats', { top: lgHeight * 0.85, bottom: lgHeight * 0.85 });
  const gaps = [
    [sub.bottom, stats.top],
    [stats.bottom, lgHeight],
  ];
  const [from, to] = gaps.reduce((best, gap) => (gap[1] - gap[0] > best[1] - best[0] ? gap : best));
  const ticker = lgVis.querySelector('.ticker');
  const tickerOn = ticker && !ticker.hidden && ticker.offsetParent === lgVis;
  const right = tickerOn ? ticker.offsetLeft - 40 : lgWidth * 0.94;
  const top = from + 46;
  const bottom = Math.max(top + 60, to - 46);
  return { left: lgWidth * 0.06, right: Math.max(lgWidth * 0.5, right), top, bottom };
}

function lgLayout() {
  const random = lgRandom(20261024);
  const area = lgArea();
  const w = area.right - area.left;
  const h = area.bottom - area.top;
  const max = Math.max(1, ...lgTemas.map((t) => t.n));
  const cols = Math.max(2, Math.min(3, Math.round(w / 170)));
  // Van los temas que entran en filas de LG_ROW_MIN_PX (ya vienen de mayor a
  // menor): en una franja baja, los de menos publicaciones quedan afuera
  // antes que encimar nombres.
  const shown = lgTemas.slice(0, cols * Math.max(1, Math.floor(h / LG_ROW_MIN_PX)));
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const rowH = h / rows;
  const colW = w / cols;
  // El radio crece con la cantidad (de 5 a 18 px), más chico si la fila es
  // baja (celular). El vaivén y el desvío al azar, a la medida de la fila.
  const scale = Math.min(1, rowH / 90);
  const swayX = Math.min(lgWidth * 0.02, colW * 0.08);
  const swayY = Math.min(lgHeight * 0.02, rowH * 0.1);
  if (lgCtx) lgCtx.font = LG_LABEL_FONT;
  const themes = shown.map((tema, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const shift = row % 2 ? (cols >= 3 ? 0.35 : 0.2) : 0;
    // El nombre entero adentro de la franja (con lugar para el vaivén).
    const half = (lgCtx ? lgCtx.measureText(tema.tema).width : 80) / 2 + swayX + 4;
    const x = area.left + ((col + 0.5 + shift) / cols) * w * 0.92 + (random() - 0.5) * Math.min(30, colW * 0.15);
    const hi = Math.min(area.right + 20, lgWidth - 8) - half;
    return {
      label: tema.tema,
      kind: 'tema',
      color: lgToken(lgCatVar(tema.orden)) || lgToken('--accent'),
      r: (5 + 13 * (tema.n / max)) * Math.max(0.6, scale),
      x0: Math.min(Math.max(x, half), Math.max(half, hi)),
      y0: area.top + (row + 0.5) * rowH + (random() - 0.5) * Math.min(24, rowH * 0.2),
      swayX,
      swayY,
      ph: random() * 6.28,
      sp: 0.4 + random() * 0.5,
    };
  });
  const accent = lgToken('--accent');
  const dots = Array.from({ length: LG_DOTS }, () => ({
    kind: 'dot',
    color: accent,
    r: 2.5 + random() * 1.5,
    x0: area.left + random() * w,
    y0: area.top - 30 + random() * (h + 40),
    swayX: lgWidth * 0.02,
    swayY: lgHeight * 0.02,
    ph: random() * 6.28,
    sp: 0.5 + random() * 0.6,
  }));
  const edges = [];
  if (themes.length) {
    for (const dot of dots) {
      const first = themes[Math.floor(random() * themes.length)];
      const second = themes[Math.floor(random() * themes.length)];
      for (const tema of first === second ? [first] : [first, second]) {
        edges.push({ a: dot, b: tema, t: random(), w: 1 + random() * 2 });
      }
    }
  }
  lgNodes = [...themes, ...dots];
  lgEdges = edges;
  lgPalette = { accent, fg: lgToken('--fg') };
}

function lgPos(node) {
  return [
    node.x0 + Math.sin(lgTime * 0.004 * node.sp + node.ph) * node.swayX,
    node.y0 + Math.cos(lgTime * 0.003 * node.sp + node.ph) * node.swayY,
  ];
}

function lgDraw() {
  if (!lgCtx || !lgWidth) return;
  const ctx = lgCtx;
  const { accent, fg } = lgPalette;
  ctx.clearRect(0, 0, lgWidth, lgHeight);
  for (const edge of lgEdges) {
    const [ax, ay] = lgPos(edge.a);
    const [bx, by] = lgPos(edge.b);
    const gradient = ctx.createLinearGradient(ax, ay, bx, by);
    gradient.addColorStop(0, accent);
    gradient.addColorStop(1, edge.b.color);
    ctx.strokeStyle = gradient;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // La chispa que viaja por el hilo.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(ax + (bx - ax) * edge.t, ay + (by - ay) * edge.t, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = LG_LABEL_FONT;
  for (const node of lgNodes) {
    const [x, y] = lgPos(node);
    const pulse = 1 + Math.sin((lgTime + node.ph * 40) / 26) * 0.06;
    ctx.shadowColor = node.color;
    ctx.shadowBlur = node.kind === 'tema' ? 28 : 12;
    ctx.fillStyle = node.color;
    ctx.globalAlpha = node.kind === 'tema' ? 0.9 : 0.8;
    ctx.beginPath();
    ctx.arc(x, y, node.r * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    if (node.kind === 'tema') {
      ctx.fillStyle = fg;
      ctx.fillText(node.label, x, y + node.r + 6);
    }
  }
}

function lgStep(now) {
  const elapsed = lgLastTick ? Math.min(3, (now - lgLastTick) / (1000 / 60)) : 1;
  lgLastTick = now;
  lgTime += elapsed;
  for (const edge of lgEdges) edge.t = (edge.t + 0.0025 * edge.w * elapsed) % 1;
  lgDraw();
  lgFrame = requestAnimationFrame(lgStep);
}

// Anda solo si se puede ver y se quiere movimiento; si no, un cuadro quieto.
function lgUpdateMotion() {
  const run = !lgReducedMotion.matches && !document.hidden && lgOnScreen && lgCtx;
  if (run && !lgFrame) {
    lgLastTick = 0;
    lgFrame = requestAnimationFrame(lgStep);
  } else if (!run) {
    if (lgFrame) cancelAnimationFrame(lgFrame);
    lgFrame = 0;
    lgDraw();
  }
}

function lgResize() {
  if (!lgCanvas || !lgCtx) return;
  const box = lgVis.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  lgWidth = box.width;
  lgHeight = box.height;
  lgCanvas.width = Math.round(lgWidth * ratio);
  lgCanvas.height = Math.round(lgHeight * ratio);
  lgCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  lgLayout();
  lgDraw();
}

// ---------- el ticker ----------

function lgTickerRow({ tema, n, orden }) {
  const row = lgNode('div', 'tk');
  const dot = lgNode('i');
  dot.style.setProperty('--c', `var(${lgCatVar(orden)})`);
  const text = lgNode('span');
  text.append(lgNode('b', '', tema), lgNode('small', '', `${LG_INT.format(n)} ${n === 1 ? 'publicación' : 'publicaciones'} · 7 días`));
  row.append(dot, text);
  return row;
}

// El ticker va a la derecha, entre los textos de arriba y los contadores,
// con el lugar que de verdad queda: con poco ancho el subtítulo baja y los
// contadores pasan a dos renglones. Si no hay lugar (menos de
// LG_TICKER_MIN_H de alto o LG_TICKER_MIN_W de ancho), no va. Medidas del
// layout (offset*), sin las animaciones de entrada.
function lgPlaceTicker(box) {
  box.classList.remove('no-room');
  box.style.top = '';
  box.style.bottom = '';
  if (box.hidden || box.offsetParent !== lgVis) return; // sin temas, o en celular (sin ticker)
  const left = box.offsetLeft;
  let top = box.offsetTop;
  for (const el of lgVis.querySelectorAll('h1, .sub')) {
    if (el.offsetParent === lgVis && el.offsetLeft + el.offsetWidth > left - 16) {
      top = Math.max(top, el.offsetTop + el.offsetHeight + 24);
    }
  }
  const stats = lgVis.querySelector('.lg-stats');
  const bottom = (stats && stats.offsetParent === lgVis ? stats.offsetTop : lgVis.clientHeight) - 24;
  if (bottom - top < LG_TICKER_MIN_H || box.offsetWidth < LG_TICKER_MIN_W) {
    box.classList.add('no-room');
    return;
  }
  box.style.top = `${top}px`;
  box.style.bottom = `${lgVis.clientHeight - bottom}px`;
}

// La lista se repite hasta llenar el alto y después se duplica entera: la
// pista sube hasta la mitad y vuelve a empezar sin que se note.
function lgFillTicker() {
  const track = document.getElementById('lgTicker');
  if (!track) return;
  const box = track.parentElement;
  box.hidden = !lgTemas.length;
  if (!lgTemas.length) return;
  lgPlaceTicker(box);
  if (box.offsetParent !== lgVis) {
    track.replaceChildren();
    return;
  }
  track.replaceChildren(...lgTemas.map(lgTickerRow));
  const one = track.scrollHeight;
  const copies = one > 0 ? Math.max(1, Math.ceil(box.clientHeight / one)) : 1;
  const half = [];
  for (let i = 0; i < copies; i += 1) half.push(...lgTemas.map(lgTickerRow));
  track.replaceChildren(...half, ...half.map((row) => row.cloneNode(true)));
  track.style.animationDuration = `${Math.max(20, (one * copies) / LG_TICKER_PX_PER_S)}s`;
}

// ---------- los números ----------

function lgCount(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!Number.isFinite(value)) {
    el.textContent = '—';
    return;
  }
  kpiCountUp(el, value, (v) => LG_INT.format(Math.round(v)));
}

function lgHoursText(hours) {
  const list = hours.map(String);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list[0];
}

// " La escucha corre cuatro veces por día: 8, 12, 16 y 20 h." (como el pie)
function lgRunsText(resumen) {
  const perDay = Number(resumen.corridasPorDia);
  if (!Number.isFinite(perDay) || perDay <= 0) return '';
  const hours = Array.isArray(resumen.runHours) ? resumen.runHours : [];
  const base = ` La escucha corre ${LG_NUMBER_WORDS[perDay] || perDay} ${perDay === 1 ? 'vez' : 'veces'} por día`;
  if (hours.length === 0 || hours.length > 8) return `${base}.`;
  return `${base}: ${lgHoursText(hours)} h.`;
}

async function lgLoad() {
  let resumen = null;
  try {
    const res = await fetch('/api/public/resumen', { credentials: 'same-origin' });
    if (res.ok) resumen = await res.json();
  } catch {
    resumen = null;
  }
  if (!resumen) {
    // Sin números: los contadores quedan en "—" y la constelación, solo
    // con los puntitos.
    return;
  }
  lgTemas = Array.isArray(resumen.temas)
    ? resumen.temas.filter((t) => t && typeof t.tema === 'string' && Number(t.n) > 0).map((t) => ({ tema: t.tema, n: Number(t.n), orden: t.orden }))
    : [];
  const runs = document.getElementById('lgRuns');
  if (runs) runs.textContent = lgRunsText(resumen);
  lgCount('lgHoy', Number(resumen.publicacionesHoy));
  lgCount('lgReclamos', Number(resumen.reclamosEnMapa));
  lgCount('lgDias', Number(resumen.diasEscuchando));
  lgCount('lg30', Number(resumen.publicaciones30Dias));
  lgRearrange();
}

// El ticker primero: de si se ve depende dónde cabe la constelación.
function lgRearrange() {
  lgFillTicker();
  lgResize();
}

function lgStart() {
  if (!lgVis) return;
  if (lgCanvas && lgCtx) {
    lgResize();
    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(lgRearrange, 120);
    }).observe(lgVis);
    // En celular la visual queda debajo de la tarjeta: fuera de la pantalla
    // no se dibuja.
    new IntersectionObserver((entries) => {
      lgOnScreen = entries.some((entry) => entry.isIntersecting);
      lgUpdateMotion();
    }).observe(lgVis);
    document.addEventListener('visibilitychange', lgUpdateMotion);
    lgReducedMotion.addEventListener('change', lgUpdateMotion);
    // Los textos y los nombres de los temas van en Sora: cuando llega la
    // fuente cambian las medidas y se vuelve a armar (con movimiento
    // reducido, además, no habría otro cuadro).
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(lgRearrange);
      document.fonts.addEventListener('loadingdone', lgRearrange);
    }
    lgUpdateMotion();
  }
  lgLoad();
}

lgStart();
