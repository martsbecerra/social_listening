// --------------------------------------------------------------------
// Estadísticas de Instagram (diseño v4, design/social-listening-v4.html):
// todos los bloques sobre el mismo período, con los números de
// GET /api/monitoring/stats (los arma src/stats.js; acá no se cuenta nada).
// Estilos en public/css/styles.css.
//
// Lo carga SOLO instagram.html, después de monitoring.js, el pop-up
// (monitoringFeedPopup.js), kpi.js, el panel y el flujo, y usa lo que ya
// definen: withPlataforma, monitoringViewListeners, formatBenchmarkRatio,
// accountColor, temaColor, feedImageUrl, openFeedPopList y showInMonitoring
// (un clic en una palabra o un tema abre el Monitoreo con este período).
// Script clásico: todo lo suyo lleva prefijo stats / STATS_.
//
// - Carga: la primera vez que se abre la solapa (openStats, lo llama
//   main.js) y cada vez que cambia el período. Mientras llega, lo anterior
//   queda tenue; una respuesta de un período que ya no es el elegido se
//   descarta. Si cambian los posteos de la tabla (una corrida, ignorar, otro
//   tono), los datos se vuelven a pedir: ya, si la solapa está a la vista y
//   el pop-up cerrado; si no, al volver.
// - Período: 7 / 30 / 90 días hasta hoy (hora de Argentina) o Desde → Hasta,
//   recordado en localStorage (sl.stats.periodo).
// - Todo dato entra por textContent (términos, cuentas y títulos los
//   escriben personas); los gráficos son SVG armados con createElementNS y
//   los tooltips van por data-tip (tip.js).
// --------------------------------------------------------------------
const statsTabEl = document.getElementById('tab-stats');
const statsPeriodEl = document.getElementById('statsPeriod');
const statsFromEl = document.getElementById('statsFrom');
const statsToEl = document.getElementById('statsTo');
const statsPeriodNoteEl = document.getElementById('statsPeriodNote');
const statsErrorEl = document.getElementById('statsError');
const statsErrorTextEl = document.getElementById('statsErrorText');
const statsRetryEl = document.getElementById('statsRetry');
const statsBodyEl = document.getElementById('statsBody');
const statsKpisEl = document.getElementById('statsKpis');
const statsPopEl = document.getElementById('feedPop');

const STATS_PERIOD_KEY = 'sl.stats.periodo';
const STATS_DAYS = [7, 30, 90];
const STATS_DEFAULT_DAYS = 30;
const STATS_MAX_DAYS = 366;
const STATS_DAY_MS = 24 * 60 * 60 * 1000;
const STATS_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const STATS_INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const STATS_ONE = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const statsReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const statsNode = kpiNode;
const statsSvg = kpiSvg;

// -------------------------------------------------------------------------
// Fechas ('AAAA-MM-DD', en hora de Argentina) y período.
// -------------------------------------------------------------------------
function statsToday() {
  return STATS_TODAY.format(new Date());
}

function statsAddDays(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function statsDaysBetween(desde, hasta) {
  const [y1, m1, d1] = desde.split('-').map(Number);
  const [y2, m2, d2] = hasta.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / STATS_DAY_MS) + 1;
}

function statsValidDate(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === fecha;
}

// "2026-09-24" → "24/9".
function statsShort(fecha) {
  const [, m, d] = fecha.split('-').map(Number);
  return `${d}/${m}`;
}

// "del 24/9 al 23/10" (o "del 23/10", un solo día).
function statsRangeWords({ desde, hasta }) {
  return desde === hasta ? `del ${statsShort(desde)}` : `del ${statsShort(desde)} al ${statsShort(hasta)}`;
}

// { dias: 7 | 30 | 90 } (hasta hoy) o { desde, hasta }.
function statsReadPeriod() {
  try {
    const saved = window.localStorage.getItem(STATS_PERIOD_KEY) || '';
    if (STATS_DAYS.includes(Number(saved))) return { dias: Number(saved) };
    const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(saved);
    if (m && statsRangeProblem(m[1], m[2]) === null) return { desde: m[1], hasta: m[2] };
  } catch (err) {
    // Sin almacenamiento vale el de siempre.
  }
  return { dias: STATS_DEFAULT_DAYS };
}

let statsPeriodo = statsReadPeriod();

function statsSavePeriod() {
  try {
    const value = statsPeriodo.dias ? String(statsPeriodo.dias) : `${statsPeriodo.desde}/${statsPeriodo.hasta}`;
    window.localStorage.setItem(STATS_PERIOD_KEY, value);
  } catch (err) {
    // Sin almacenamiento el período igual cambia; solo no queda guardado.
  }
}

// Las dos fechas del período elegido.
function statsRange() {
  if (!statsPeriodo.dias) return { desde: statsPeriodo.desde, hasta: statsPeriodo.hasta };
  const hasta = statsToday();
  return { desde: statsAddDays(hasta, -(statsPeriodo.dias - 1)), hasta };
}

// Qué tiene de malo un Desde → Hasta escrito a mano (null si nada).
function statsRangeProblem(desde, hasta) {
  if (!statsValidDate(desde) || !statsValidDate(hasta)) return 'Elegí las dos fechas.';
  if (desde > hasta) return '"Desde" tiene que ser anterior a "Hasta".';
  if (statsDaysBetween(desde, hasta) > STATS_MAX_DAYS) return `El período puede tener hasta ${STATS_MAX_DAYS} días.`;
  return null;
}

function statsPaintPeriod() {
  const { desde, hasta } = statsRange();
  for (const button of statsPeriodEl.querySelectorAll('button[data-days]')) {
    const on = statsPeriodo.dias === Number(button.dataset.days);
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  const today = statsToday();
  statsFromEl.value = desde;
  statsToEl.value = hasta;
  statsFromEl.max = today;
  statsToEl.max = today;
}

// Una línea debajo del período: un Desde → Hasta mal escrito, o que la base
// tiene datos desde después de "Desde" (los días de antes no son días sin
// publicaciones: no hay datos).
function statsShowPeriodNote(text) {
  statsPeriodNoteEl.textContent = text || '';
  statsPeriodNoteEl.classList.toggle('hidden', !text);
}

function statsSetPeriod(periodo) {
  statsPeriodo = periodo;
  statsSavePeriod();
  statsPaintPeriod();
  statsShowPeriodNote('');
  statsLoad();
}

// -------------------------------------------------------------------------
// Carga.
// -------------------------------------------------------------------------
let statsData = null; // la última respuesta buena
let statsDataRange = ''; // su período, "desde/hasta"
let statsDataPosts = ''; // la firma de los posteos de la tabla cuando se pidió
let statsRequest = 0;

// Ids, tono y tema de los posteos de la tabla: si cambian (una corrida,
// ignorar, corregir el tono), los números de acá quedaron viejos.
function statsPostsKey() {
  if (!monitoringTable) return '';
  return monitoringTable
    .getData()
    .map((p) => `${p.id}:${p.sentiment || ''}:${p.tema || ''}`)
    .join(',');
}

async function statsLoad() {
  const range = statsRange();
  const id = ++statsRequest;
  statsBodyEl.classList.add('loading');
  statsBodyEl.setAttribute('aria-busy', 'true');
  try {
    const resp = await fetch(withPlataforma(`/api/monitoring/stats?desde=${range.desde}&hasta=${range.hasta}`));
    const body = await resp.json().catch(() => null);
    if (id !== statsRequest) return;
    if (!resp.ok || !body || !body.resumen) {
      const err = new Error((body && body.error) || `HTTP ${resp.status}`);
      err.userMessage = body && body.error;
      throw err;
    }
    statsData = body;
    statsDataRange = `${range.desde}/${range.hasta}`;
    statsDataPosts = statsPostsKey();
    statsErrorEl.classList.add('hidden');
    statsBodyEl.classList.remove('hidden');
    statsRender();
  } catch (err) {
    if (id !== statsRequest) return;
    console.error('Error cargando Estadísticas:', err);
    statsData = null;
    statsErrorTextEl.textContent = err.userMessage || 'No se pudieron cargar las estadísticas. Revisá la conexión y volvé a probar.';
    statsErrorEl.classList.remove('hidden');
    statsBodyEl.classList.add('hidden');
  } finally {
    if (id === statsRequest) {
      statsBodyEl.classList.remove('loading');
      statsBodyEl.removeAttribute('aria-busy');
    }
  }
}

function statsTabVisible() {
  return !statsTabEl.classList.contains('hidden');
}

// ¿Cambiaron los posteos de la tabla desde que se pidieron los datos? Si la
// tabla todavía no había llegado entonces, los dos son de la misma base: se
// toma su firma de ahora y no hace falta pedir de nuevo.
function statsIsStale() {
  if (statsDataPosts === '') {
    statsDataPosts = statsPostsKey();
    // Llegó la tabla: el ranking ya puede mostrar las fotos y el tema.
    if (statsDataPosts && statsData) statsRenderRanking();
    return false;
  }
  return statsDataPosts !== statsPostsKey();
}

// La llama main.js al abrir la solapa: pide los datos si no están, si son
// de otro período (con 7 / 30 / 90, pasó la medianoche) o si quedaron viejos.
function openStats() {
  const range = statsRange();
  statsPaintPeriod();
  if (!statsData || statsDataRange !== `${range.desde}/${range.hasta}` || statsIsStale()) statsLoad();
  // Si los datos llegaron con la solapa oculta, la nube no se pudo medir.
  else if (statsCloudEl.clientWidth !== statsCloudWidth) statsBuildCloud();
}

// -------------------------------------------------------------------------
// Ayudas de dibujo.
// -------------------------------------------------------------------------
function statsPct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

function statsPctText(part, total) {
  const pct = statsPct(part, total);
  return pct === null ? '—' : `${pct} %`;
}

// La línea de una tarjeta sin publicaciones en el período.
function statsEmptyLine() {
  const periodo = statsData.periodo;
  return statsNode('p', 'stats-empty', `Sin publicaciones ${statsRangeWords(periodo)}.`);
}

// Después de dibujar, las barras crecen de 0 a su ancho (sin movimiento:
// directo).
function statsGrowBars(container) {
  const bars = [...container.querySelectorAll('[data-w]')];
  const apply = () => bars.forEach((bar) => (bar.style.width = `${bar.dataset.w}%`));
  if (statsReducedMotion.matches) apply();
  else setTimeout(apply, 80);
}

// -------------------------------------------------------------------------
// KPI.
// -------------------------------------------------------------------------
function statsSum(rows, field) {
  return rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
}

// "antes 54 % · 109 publicaciones": "worse" decide si el de antes va en rojo.
function statsToneDetail(previousPct, count, worse) {
  const line = `${STATS_INT.format(count)} ${count === 1 ? 'publicación' : 'publicaciones'}`;
  if (previousPct === null) return [line];
  return ['antes ', statsNode('b', worse ? 'neg' : '', `${Math.round(previousPct)} %`), ` · ${line}`];
}

function statsConversationFormat(total) {
  if (total >= 1e6) return (n) => `${STATS_ONE.format(n / 1e6)} M`;
  if (total >= 1e3) return (n) => `${STATS_ONE.format(n / 1e3)} mil`;
  return (n) => STATS_INT.format(Math.round(n));
}

function statsRenderKpis() {
  const r = statsData.resumen;
  const t = r.tendencias;
  const negativas = statsSum(statsData.porDia, 'negativo');
  const positivas = statsSum(statsData.porDia, 'positivo');
  const pctFormat = (n) => `${Math.round(n)} %`;
  const conversation = kpiDelta(r.conversacion, r.conversacionAnterior);
  statsKpisEl.replaceChildren(
    kpiCard({
      id: 'stats-relevantes',
      label: 'Publicaciones relevantes',
      value: r.relevantes,
      detail: kpiDelta(r.relevantes, r.relevantesAnterior),
      spark: t.relevantes,
    }),
    kpiCard({
      id: 'stats-altos',
      label: 'Se despegaron',
      value: r.seDespegaron,
      detail: kpiDelta(r.seDespegaron, r.seDespegaronAnterior),
      spark: t.seDespegaron,
    }),
    kpiCard({
      id: 'stats-neg',
      label: 'Negativo',
      value: r.negativoPct,
      format: pctFormat,
      detail: statsToneDetail(r.negativoPctAnterior, negativas, r.negativoPct !== null && r.negativoPct > r.negativoPctAnterior),
      spark: t.negativo,
    }),
    kpiCard({
      id: 'stats-pos',
      label: 'Positivo',
      value: r.positivoPct,
      format: pctFormat,
      detail: statsToneDetail(r.positivoPctAnterior, positivas, r.positivoPct !== null && r.positivoPct < r.positivoPctAnterior),
      spark: t.positivo,
    }),
    kpiCard({
      id: 'stats-conv',
      label: 'Conversación',
      value: r.conversacion,
      format: statsConversationFormat(r.conversacion),
      detail: [...conversation, statsNode('br'), 'likes + comentarios'],
      spark: t.conversacion,
    })
  );
}

// -------------------------------------------------------------------------
// Nube: las palabras más usadas (tamaño = publicaciones que la usan; color =
// el tono que predomina entre ellas), en espiral desde el centro, cada una
// medida con un canvas para que no se pisen. "Positivos reales": tamaño =
// las positivas, solo las que tienen alguna. Como en la maqueta, van las que
// están en dos publicaciones o más; la que no entra, no va. Un clic abre el
// Monitoreo con exactamente esas publicaciones (sus ids; con "Positivos
// reales", solo las positivas).
// -------------------------------------------------------------------------
const statsCloudEl = document.getElementById('statsCloud');
const statsCloudSegEl = document.getElementById('statsCloudSeg');
const statsMeasure = document.createElement('canvas').getContext('2d');
let statsCloudMode = 'vol';
let statsCloudWidth = 0;

function statsWordTone(word) {
  if (word.positivas > word.negativas) return 'pos';
  return word.negativas > word.positivas ? 'neg' : 'neu';
}

function statsPlural(n, one, many) {
  return `${STATS_INT.format(n)} ${n === 1 ? one : many}`;
}

function statsShowWord(word) {
  const { desde, hasta } = statsData.periodo;
  showInMonitoring({
    range: { desde, hasta },
    palabra: { term: word.palabra, ids: word.ids },
    sentiment: statsCloudMode === 'pos' ? 'positivo' : '',
  });
}

function statsBuildCloud() {
  const width = statsCloudEl.clientWidth;
  const height = statsCloudEl.clientHeight;
  statsCloudWidth = width;
  if (!width || !height) return;
  const positives = statsCloudMode === 'pos';
  const value = (word) => (positives ? word.positivas : word.n);
  const words = statsData.palabras.filter((w) => w.n >= 2 && (!positives || w.positivas > 0)).sort((a, b) => value(b) - value(a));
  if (!words.length) {
    let text = `Sin publicaciones ${statsRangeWords(statsData.periodo)}.`;
    if (statsData.resumen.relevantes) {
      text = positives ? 'Ninguna palabra repetida tiene publicaciones positivas en el período.' : 'Ninguna palabra se repite en las publicaciones del período.';
    }
    statsCloudEl.replaceChildren(statsNode('div', 'ph', text));
    return;
  }
  const family = getComputedStyle(document.documentElement).getPropertyValue('--display').trim() || 'sans-serif';
  const max = value(words[0]);
  const min = value(words[words.length - 1]);
  const cx = width / 2;
  const cy = height / 2;
  const placed = [];
  const buttons = [];
  for (const word of words) {
    const size = Math.round(13 + (width < 560 ? 30 : 46) * Math.sqrt((value(word) - min) / (max - min || 1)));
    statsMeasure.font = `600 ${size}px ${family}`;
    const w = statsMeasure.measureText(word.palabra).width + 10;
    const h = size * 1.05;
    let angle = 0;
    let radius = 0;
    let x = cx;
    let y = cy;
    let fits = false;
    for (let k = 0; k < 600 && !fits; k++) {
      angle += 0.35;
      radius += 1.3;
      x = cx + radius * Math.cos(angle) * 1.25;
      y = cy + radius * Math.sin(angle) * 0.8;
      fits =
        x - w / 2 > 4 &&
        x + w / 2 < width - 4 &&
        y - h / 2 > 4 &&
        y + h / 2 < height - 4 &&
        !placed.some((p) => Math.abs(p.x - x) * 2 < p.w + w && Math.abs(p.y - y) * 2 < p.h + h);
    }
    if (!fits) continue;
    placed.push({ x, y, w, h });
    const button = statsNode('button', '', word.palabra);
    button.type = 'button';
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.style.fontSize = `${size}px`;
    button.style.color = `var(--${statsWordTone(word)})`;
    if (!statsReducedMotion.matches) button.style.transitionDelay = `${buttons.length * 35}ms`;
    const counts = `${statsPlural(word.n, 'publicación', 'publicaciones')} · ${statsPlural(word.positivas, 'positiva', 'positivas')} · ${statsPlural(word.negativas, 'negativa', 'negativas')}`;
    button.dataset.tipTitle = word.palabra;
    button.dataset.tip = `${counts}\nClic: ${positives ? 'ver las positivas' : 'verlas'} en el Monitoreo`;
    button.setAttribute('aria-label', `${word.palabra}: ${counts}. ${positives ? 'Ver las positivas' : 'Verlas'} en el Monitoreo`);
    button.addEventListener('click', () => statsShowWord(word));
    buttons.push(button);
  }
  statsCloudEl.replaceChildren(...buttons);
  const show = () => buttons.forEach((button) => button.classList.add('in'));
  if (statsReducedMotion.matches) show();
  else requestAnimationFrame(() => requestAnimationFrame(show));
}

// La nube se mide con la tipografía de los títulos: si todavía no cargó,
// se arma cuando llega.
function statsRenderCloud() {
  if (document.fonts && document.fonts.status !== 'loaded') {
    statsCloudEl.replaceChildren(statsNode('div', 'ph', 'Armando la nube…'));
    document.fonts.ready.then(() => statsData && statsBuildCloud());
    return;
  }
  statsBuildCloud();
}

// -------------------------------------------------------------------------
// Menciones por búsqueda: detectadas (también lo que no quedó: ignorado o
// descartado por el clasificador), relevantes y positivas de cada término,
// y la dona con lo que se lleva cada uno de las relevantes (share of voice).
// Las publicaciones que no llegaron por una búsqueda no entran.
// -------------------------------------------------------------------------
const statsRowsEl = document.getElementById('statsRows');
const statsDonutEl = document.getElementById('statsDonut');
const statsDonutLgEl = document.getElementById('statsDonutLg');
const STATS_DONUT_COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--neu', '--pos', '--line2'];

function statsRightCell(text) {
  const cell = statsNode('span', '', text);
  cell.style.textAlign = 'right';
  return cell;
}

function statsRenderMentions() {
  const list = statsData.menciones;
  if (!list.length) {
    statsRowsEl.replaceChildren(
      statsData.resumen.relevantes ? statsNode('p', 'stats-empty', 'Ninguna búsqueda trajo publicaciones en el período.') : statsEmptyLine()
    );
    return;
  }
  const max = Math.max(1, ...list.map((m) => m.detectadas));
  const head = statsNode('div', 'row hdr');
  head.append(statsNode('span', '', 'Búsqueda'), statsNode('span', '', 'Detectadas · relevantes · positivas'), statsRightCell('Relevantes'), statsRightCell('Positivas'));
  const rows = list.map((m) => {
    const row = statsNode('div', 'row');
    row.dataset.tipTitle = m.termino;
    row.dataset.tip =
      `${statsPlural(m.detectadas, 'publicación detectada', 'publicaciones detectadas')} · ` +
      `${STATS_INT.format(m.relevantes)} relevantes (${statsPctText(m.relevantes, m.detectadas)}) · ` +
      `${STATS_INT.format(m.positivas)} positivas (${statsPctText(m.positivas, m.relevantes)} de las relevantes)`;
    const name = statsNode('span', 'nm', m.termino);
    name.appendChild(statsNode('small', '', `${STATS_INT.format(m.detectadas)} detectadas`));
    const bars = statsNode('span', 'bars');
    bars.setAttribute('aria-hidden', 'true');
    for (const n of [m.detectadas, m.relevantes, m.positivas]) {
      const bar = statsNode('i');
      bar.dataset.w = ((n / max) * 100).toFixed(1);
      bars.appendChild(bar);
    }
    const relevant = statsNode('span', 'num', statsPctText(m.relevantes, m.detectadas));
    relevant.appendChild(statsNode('small', '', STATS_INT.format(m.relevantes)));
    const positive = statsNode('span', 'num sent-pos', STATS_INT.format(m.positivas));
    positive.appendChild(statsNode('small', '', `${statsPctText(m.positivas, m.relevantes)} reales`));
    row.append(name, bars, relevant, positive);
    return row;
  });
  statsRowsEl.replaceChildren(head, ...rows);
  statsGrowBars(statsRowsEl);
}

function statsRenderDonut() {
  const slices = statsData.menciones
    .filter((m) => m.relevantes > 0)
    .sort((a, b) => b.relevantes - a.relevantes || a.termino.localeCompare(b.termino, 'es'))
    .map((m, i) => ({ name: m.termino, n: m.relevantes, color: `var(${STATS_DONUT_COLORS[i % STATS_DONUT_COLORS.length]})` }));
  const total = slices.reduce((sum, s) => sum + s.n, 0);
  const circumference = 2 * Math.PI * 58;
  const track = statsSvg('circle', { cx: 75, cy: 75, r: 58, fill: 'none', 'stroke-width': 18 });
  track.style.stroke = 'var(--line)';
  const arcs = [];
  let offset = 0;
  for (const slice of slices) {
    const length = Math.max(0, (slice.n / total) * circumference - 2);
    const arc = statsSvg('circle', {
      cx: 75,
      cy: 75,
      r: 58,
      fill: 'none',
      'stroke-width': 18,
      'stroke-dasharray': `0 ${circumference}`,
      'stroke-dashoffset': -offset,
      transform: 'rotate(-90 75 75)',
    });
    arc.style.stroke = slice.color;
    arc.style.transition = `stroke-dasharray 1.2s ${arcs.length * 0.08}s cubic-bezier(.2,.8,.2,1)`;
    arc.dataset.tipTitle = slice.name;
    arc.dataset.tip = `${statsPlural(slice.n, 'publicación relevante', 'publicaciones relevantes')} · ${statsPctText(slice.n, total)}`;
    arc.dataset.len = String(length);
    arcs.push(arc);
    offset += (slice.n / total) * circumference;
  }
  const value = statsSvg('text', { x: 75, y: 71, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 600 });
  value.style.fill = 'var(--fg)';
  value.style.fontFamily = 'var(--display)';
  value.textContent = STATS_INT.format(total);
  const caption = statsSvg('text', { x: 75, y: 88, 'text-anchor': 'middle', 'font-size': 9 });
  caption.style.fill = 'var(--muted)';
  caption.style.fontFamily = 'var(--mono)';
  // No dice "relevantes" como la maqueta: no son todas las del KPI (las que
  // no llegaron por una búsqueda no entran).
  caption.textContent = 'por búsqueda';
  statsDonutEl.replaceChildren(track, ...arcs, value, caption);
  const grow = () => arcs.forEach((arc) => arc.setAttribute('stroke-dasharray', `${arc.dataset.len} ${circumference}`));
  if (statsReducedMotion.matches) grow();
  else setTimeout(grow, 80);
  statsDonutEl.setAttribute(
    'aria-label',
    total
      ? `Relevantes por búsqueda: ${slices.map((s) => `${s.name} ${statsPctText(s.n, total)}`).join(', ')}`
      : 'Ninguna búsqueda trajo publicaciones relevantes en el período'
  );
  if (!total) {
    statsDonutLgEl.replaceChildren(statsData.resumen.relevantes ? statsNode('p', 'stats-empty', 'Ninguna búsqueda trajo publicaciones relevantes.') : statsEmptyLine());
    return;
  }
  statsDonutLgEl.replaceChildren(
    ...slices.map((slice) => {
      const row = statsNode('div');
      const dot = statsNode('i');
      dot.style.background = slice.color;
      row.append(dot, statsNode('span', '', slice.name), statsNode('b', 'num', statsPctText(slice.n, total)));
      return row;
    })
  );
}

// -------------------------------------------------------------------------
// De qué se habla: los 9 temas con más publicaciones, con el badge contra el
// período anterior, el tono, la evolución por tramo (por día hasta 14 días;
// si no, por semana) y la cita de la que más se despegó. Un clic abre el
// Monitoreo con ese tema y este período.
// -------------------------------------------------------------------------
const statsTopicsEl = document.getElementById('statsTopics');
const STATS_TOPICS_MAX = 9;

// Las reglas del badge (las del dueño): sin datos del período anterior,
// ninguno. Nuevo: nada antes y 3 o más ahora. Pico: 5 o más y al menos el
// doble que antes. En alza: más de +20 %. Baja: menos de −20 %. Si no,
// Estable.
function statsTopicBadge(topic) {
  if (topic.anterior === null) return null;
  const stable = { label: 'Estable', cls: 'st', color: 'var(--neu)' };
  if (topic.anterior === 0) return topic.n >= 3 ? { label: 'Nuevo', cls: 'new', color: 'var(--c3)' } : stable;
  const change = ((topic.n - topic.anterior) / topic.anterior) * 100;
  if (topic.n >= 5 && topic.n >= 2 * topic.anterior) return { label: 'Pico', cls: 'pk', color: 'var(--neg)' };
  if (change > 20) return { label: 'En alza', cls: 'up', color: 'var(--c5)' };
  if (change < -20) return { label: 'Baja', cls: 'dn', color: 'var(--muted)' };
  return stable;
}

function statsTopicChange(topic) {
  if (!topic.anterior) return '—';
  const change = Math.round(((topic.n - topic.anterior) / topic.anterior) * 100);
  return `${change > 0 ? '+' : ''}${change} %`;
}

// La evolución del tema por tramo: área y trazo, del color del badge.
function statsTopicSpark(values, color) {
  const w = 230;
  const h = 54;
  const series = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const max = Math.max(1, ...series);
  const points = series.map((v, i) => `${((i / (series.length - 1)) * w).toFixed(1)},${(50 - (v / max) * 44).toFixed(1)}`).join('L');
  const svg = statsSvg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const area = statsSvg('path', { d: `M${points}L${w},${h}L0,${h}Z`, opacity: 0.15 });
  area.style.fill = color;
  const line = statsSvg('path', { d: `M${points}`, fill: 'none', 'stroke-width': 2, pathLength: 1 });
  line.style.stroke = color;
  if (!statsReducedMotion.matches) {
    line.style.strokeDasharray = '1';
    line.style.strokeDashoffset = '1';
    line.style.animation = 'draw 1.5s ease forwards';
  }
  svg.append(area, line);
  return svg;
}

function statsShowTopic(topic) {
  const { desde, hasta } = statsData.periodo;
  showInMonitoring({ range: { desde, hasta }, tema: topic.tema });
}

function statsTopicCard(topic) {
  const badge = statsTopicBadge(topic);
  const card = statsNode('div', 'card topic');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute(
    'aria-label',
    `${topic.tema}: ${statsPlural(topic.n, 'publicación', 'publicaciones')}${badge ? `, ${badge.label.toLowerCase()}` : ''}. Verlas en el Monitoreo`
  );
  if (badge) card.appendChild(statsNode('span', `badge ${badge.cls}`, badge.label));
  card.appendChild(statsNode('h3', '', topic.tema));
  const meta = statsNode('div', 'meta');
  const count = statsNode('span');
  count.append(statsNode('b', '', STATS_INT.format(topic.n)), ' publ.');
  const change = statsNode('span');
  change.append(statsNode('b', '', statsTopicChange(topic)), ' vs. período anterior');
  meta.append(count, change);
  const tone = statsNode('div', 'stack');
  tone.setAttribute('aria-hidden', 'true');
  for (const [cls, n] of [['bg-pos', topic.positivo], ['bg-neu', topic.neutral], ['bg-neg', topic.negativo]]) {
    const part = statsNode('i', cls);
    part.style.width = `${(n / topic.n) * 100}%`;
    tone.appendChild(part);
  }
  tone.dataset.tip = `${STATS_INT.format(topic.positivo)} positivas · ${STATS_INT.format(topic.neutral)} neutrales · ${STATS_INT.format(topic.negativo)} negativas`;
  card.append(meta, tone, statsTopicSpark(topic.porSemana, badge ? badge.color : 'var(--neu)'));
  // La cita: la publicación del tema que más se despegó. La razón lleva
  // colchón: "4,31× en comentarios", nunca "veces lo habitual".
  const best = topic.destacada;
  if (best && best.titulo) {
    const quote = statsNode('p', 'q', `“${best.titulo}”`);
    quote.dataset.tipTitle = `La que más se despegó en ${topic.tema}`;
    quote.dataset.tip = `${best.cuenta ? `@${best.cuenta} · ` : ''}${formatBenchmarkRatio(best.razon)}× en ${best.metrica}`;
    card.appendChild(quote);
  }
  card.addEventListener('click', () => statsShowTopic(topic));
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    statsShowTopic(topic);
  });
  return card;
}

function statsRenderTopics() {
  const topics = statsData.temas.slice(0, STATS_TOPICS_MAX);
  statsTopicsEl.replaceChildren(...(topics.length ? topics.map(statsTopicCard) : [statsEmptyLine()]));
}

// -------------------------------------------------------------------------
// Cuándo se habla: publicaciones por día de la semana y hora (hora de
// Argentina; más oscuro, más publicaciones).
// -------------------------------------------------------------------------
const statsHeatEl = document.getElementById('statsHeat');
const STATS_WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function statsRenderHeat() {
  const grid = statsData.porHora;
  const max = Math.max(...grid.flat());
  if (!max) {
    statsHeatEl.replaceChildren(statsEmptyLine());
    statsHeatEl.setAttribute('aria-label', 'Sin publicaciones en el período');
    return;
  }
  const days = statsData.periodo.diasEfectivos;
  const nodes = [statsNode('span')];
  for (let h = 0; h < 24; h++) nodes.push(statsNode('span', 'hr', h % 3 === 0 ? String(h) : ''));
  const cells = [];
  let top = { n: -1 };
  grid.forEach((row, d) => {
    nodes.push(statsNode('span', 'lab', STATS_WEEKDAYS[d]));
    row.forEach((n, h) => {
      const cell = statsNode('span', 'c');
      cell.dataset.tipTitle = `${STATS_WEEKDAYS[d]} ${h}:00`;
      cell.dataset.tip = `${statsPlural(n, 'publicación', 'publicaciones')} en ${statsPlural(days, 'día', 'días')}`;
      cell.dataset.o = (0.05 + Math.pow(n / max, 1.2) * 0.95).toFixed(2);
      if (!statsReducedMotion.matches) cell.style.transitionDelay = `${cells.length * 3}ms`;
      if (n > top.n) top = { n, d, h };
      cells.push(cell);
      nodes.push(cell);
    });
  });
  statsHeatEl.replaceChildren(...nodes);
  statsHeatEl.setAttribute(
    'aria-label',
    `Publicaciones por día y hora. La franja con más: ${STATS_WEEKDAYS[top.d]} de ${top.h} a ${top.h + 1} h, ${statsPlural(top.n, 'publicación', 'publicaciones')}`
  );
  const show = () => cells.forEach((cell) => (cell.style.opacity = cell.dataset.o));
  if (statsReducedMotion.matches) show();
  else setTimeout(show, 100);
}

// -------------------------------------------------------------------------
// Tono neto por tramo (los mismos de los temas: por día hasta 14 días, si
// no por semana, el último de los 7 días que terminan en "hasta"):
// positivos menos negativos sobre el total, en puntos. Un tramo sin
// publicaciones no tiene punto (no es un cero).
// -------------------------------------------------------------------------
const statsNetEl = document.getElementById('statsNet');
const STATS_WEEKDAY_OF = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function statsWeekday(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return STATS_WEEKDAY_OF[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function statsSvgText(attrs, text, color = 'var(--muted)') {
  const node = statsSvg('text', { 'font-size': 9, ...attrs });
  node.style.fill = color;
  node.style.fontFamily = 'var(--mono)';
  node.textContent = text;
  return node;
}

function statsRenderNet() {
  const tramos = statsData.semanas;
  const daily = tramos.length > 0 && tramos.every((t) => t.desde === t.hasta);
  const points = tramos.map((t) => {
    const days = statsData.porDia.filter((d) => d.fecha >= t.desde && d.fecha <= t.hasta);
    const total = statsSum(days, 'total');
    const net = total ? Math.round(((statsSum(days, 'positivo') - statsSum(days, 'negativo')) / total) * 100) : null;
    return { ...t, total, net };
  });
  const known = points.filter((p) => p.net !== null);
  if (!known.length) {
    statsNetEl.replaceChildren(statsSvgText({ x: 160, y: 94, 'text-anchor': 'middle', 'font-size': 11 }, `Sin publicaciones ${statsRangeWords(statsData.periodo)}`));
    statsNetEl.setAttribute('aria-label', 'Sin publicaciones en el período');
    return;
  }
  const W = 320;
  const H = 180;
  const n = points.length;
  const max = Math.max(10, ...known.map((p) => p.net));
  const min = Math.min(-10, ...known.map((p) => p.net));
  const x = (i) => 30 + (i / Math.max(1, n - 1)) * (W - 44);
  const y = (k) => 16 + ((max - k) / (max - min)) * (H - 46);
  const label = (p, i) => (daily ? statsWeekday(p.desde) : `S${i + 1}`);
  const nodes = [];
  const zero = statsSvg('line', { x1: 30, x2: W - 10, y1: y(0), y2: y(0), 'stroke-width': 1, opacity: 0.6 });
  zero.style.stroke = 'var(--fg2)';
  nodes.push(
    zero,
    statsSvgText({ x: 26, y: y(0) + 3, 'text-anchor': 'end' }, '0'),
    statsSvgText({ x: 26, y: y(max) + 3, 'text-anchor': 'end' }, `+${max}`),
    statsSvgText({ x: 26, y: y(min) + 3, 'text-anchor': 'end' }, String(min))
  );
  const path = statsSvg('path', {
    d: `M${points.map((p, i) => (p.net === null ? null : `${x(i).toFixed(1)},${y(p.net).toFixed(1)}`)).filter(Boolean).join('L')}`,
    fill: 'none',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    pathLength: 1,
  });
  path.style.stroke = 'var(--accent)';
  if (!statsReducedMotion.matches) {
    path.style.strokeDasharray = '1';
    path.style.strokeDashoffset = '1';
    path.style.animation = 'draw 1.6s ease forwards';
  }
  nodes.push(path);
  points.forEach((p, i) => {
    if (p.net !== null) {
      const dot = statsSvg('circle', { cx: x(i), cy: y(p.net), r: i === n - 1 ? 5 : 3.5, 'stroke-width': 1.5 });
      dot.style.fill = p.net >= 0 ? 'var(--pos)' : 'var(--neg)';
      dot.style.stroke = 'var(--surface)';
      dot.dataset.tipTitle = daily ? `${statsWeekday(p.desde)} ${statsShort(p.desde)}` : `Semana ${statsRangeWords(p)}`;
      dot.dataset.tip = `tono neto ${p.net > 0 ? '+' : ''}${p.net} pts · ${statsPlural(p.total, 'publicación', 'publicaciones')}`;
      nodes.push(dot);
    }
    if (n <= 8 || i % 2 === 0) nodes.push(statsSvgText({ x: x(i), y: H - 8, 'text-anchor': 'middle' }, label(p, i)));
  });
  // El último tramo: "esta semana" / "hoy" si el período termina hoy.
  const last = points[n - 1];
  const endsToday = statsData.periodo.hasta >= statsToday();
  const lastName = daily ? (endsToday ? 'hoy' : 'último día') : endsToday ? 'esta semana' : 'última semana';
  const lastValue = last.net === null ? 'sin publicaciones' : `${last.net > 0 ? '+' : ''}${last.net}`;
  const lastY = last.net === null ? y(0) : y(last.net);
  nodes.push(statsSvgText({ x: x(n - 1), y: lastY + 16, 'text-anchor': 'end', 'font-size': 10 }, `${lastName}: ${lastValue}`, 'var(--fg)'));
  statsNetEl.replaceChildren(...nodes);
  statsNetEl.setAttribute(
    'aria-label',
    `Tono neto ${daily ? 'por día' : 'por semana'}: ${points.map((p, i) => `${label(p, i)} ${p.net === null ? 'sin publicaciones' : `${p.net > 0 ? '+' : ''}${p.net}`}`).join(', ')}`
  );
}

// -------------------------------------------------------------------------
// Quién habla de nosotros: las 10 cuentas con más impacto (likes +
// comentarios de sus publicaciones), más publicaciones o más seguidores.
// -------------------------------------------------------------------------
const statsAccRowsEl = document.getElementById('statsAccRows');
const statsAccSegEl = document.getElementById('statsAccSeg');
const STATS_ACCOUNTS_MAX = 10;
const STATS_COMPACT = new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 });
const STATS_ACC_SORTS = {
  impacto: { label: 'Impacto', value: (a) => a.impacto, text: (a) => STATS_INT.format(a.impacto) },
  publicaciones: { label: 'Publicaciones', value: (a) => a.publicaciones, text: (a) => STATS_INT.format(a.publicaciones) },
  // Sin seguidores conocidos, al final.
  seguidores: { label: 'Seguidores', value: (a) => a.seguidores, text: (a) => (a.seguidores === null ? '—' : STATS_COMPACT.format(a.seguidores)) },
};
let statsAccSort = 'impacto';

function statsFollowersText(account) {
  return account.seguidores === null ? 'seguidores sin dato' : statsPlural(account.seguidores, 'seguidor', 'seguidores');
}

function statsRenderAccounts() {
  const sort = STATS_ACC_SORTS[statsAccSort];
  const key = (a) => (sort.value(a) === null ? -1 : sort.value(a));
  const list = [...statsData.cuentas]
    .sort((a, b) => key(b) - key(a) || b.publicaciones - a.publicaciones || a.cuenta.localeCompare(b.cuenta, 'es'))
    .slice(0, STATS_ACCOUNTS_MAX);
  if (!list.length) {
    statsAccRowsEl.replaceChildren(statsEmptyLine());
    return;
  }
  const max = Math.max(1, ...list.map((a) => sort.value(a) || 0));
  const head = statsNode('div', 'acc-row hdr');
  head.append(statsNode('span'), statsNode('span', '', 'Cuenta'), statsNode('span', '', sort.label), statsRightCell('Publ.'), statsRightCell('Tono'));
  const rows = list.map((a) => {
    const row = statsNode('div', 'acc-row');
    const best = a.mejorRazon === null ? '' : ` (la mejor, ${formatBenchmarkRatio(a.mejorRazon)}×)`;
    row.dataset.tipTitle = `@${a.cuenta}`;
    row.dataset.tip =
      `${statsPlural(a.publicaciones, 'publicación', 'publicaciones')} · ${STATS_INT.format(a.impacto)} de impacto · ${statsFollowersText(a)}\n` +
      `${statsPlural(a.seDespego, 'se despegó', 'se despegaron')}${best}`;
    const avatar = statsNode('span', 'av', a.cuenta[0].toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    avatar.style.background = accountColor(a.cuenta);
    const name = statsNode('span');
    const detail = a.seDespego ? ` · ${a.seDespego} ${a.seDespego === 1 ? 'se despegó' : 'se despegaron'}` : '';
    name.append(statsNode('b', '', `@${a.cuenta}`), statsNode('small', '', `${statsFollowersText(a)}${detail}`));
    const value = statsNode('span');
    const bar = statsNode('div', 'bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = statsNode('i');
    fill.dataset.w = (((sort.value(a) || 0) / max) * 100).toFixed(1);
    bar.appendChild(fill);
    value.append(bar, statsNode('small', 'num', sort.text(a)));
    const tone = statsRightCell('');
    const stack = statsNode('span', 'stack');
    stack.setAttribute('aria-hidden', 'true');
    for (const [cls, n] of [['bg-pos', a.positivo], ['bg-neu', a.neutral], ['bg-neg', a.negativo]]) {
      const part = statsNode('i', cls);
      part.style.width = `${(n / a.publicaciones) * 100}%`;
      stack.appendChild(part);
    }
    tone.appendChild(stack);
    row.append(avatar, name, value, statsNode('span', 'num', STATS_INT.format(a.publicaciones)), tone);
    return row;
  });
  statsAccRowsEl.replaceChildren(head, ...rows);
  statsGrowBars(statsAccRowsEl);
}

// -------------------------------------------------------------------------
// Las que más se despegaron: las 6 de mayor razón (el endpoint manda 10).
// La razón lleva colchón: va con su métrica y su valor, nunca como "veces lo
// habitual". Un clic abre el pop-up del posteo, que recorre estas 6.
// -------------------------------------------------------------------------
const statsRankEl = document.getElementById('statsRank');
const STATS_RANK_SHOWN = 6;
const STATS_RANK_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit' });

// La fila de la tabla del posteo (foto, tema y lo que usa el pop-up), o null
// si no está cargada.
function statsPostOf(id) {
  const row = feedPopRowOf(id);
  return row ? row.getData() : null;
}

function statsRankButton(item, index, ids) {
  const post = statsPostOf(item.id);
  const button = statsNode('button', 'rk');
  button.type = 'button';
  const thumb = statsNode('span', 'th');
  const src = post ? feedImageUrl(post) : null;
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    thumb.appendChild(img);
  }
  const title = item.titulo || 'Sin título';
  const account = item.cuenta ? `@${item.cuenta}` : 'una cuenta sin identificar';
  const when = Number.isFinite(Date.parse(item.fecha)) ? STATS_RANK_DATE.format(new Date(item.fecha)) : '';
  const text = statsNode('span');
  text.append(statsNode('b', '', title), statsNode('small', '', [account, when, post && post.tema].filter(Boolean).join(' · ')));
  const ratio = `${formatBenchmarkRatio(item.razon)}×`;
  const value = statsNode('span', 'rz', ratio);
  value.appendChild(statsNode('small', '', `${STATS_INT.format(item.valor)} ${item.metrica}`));
  button.append(statsNode('span', 'pos', String(index + 1)), thumb, text, value);
  button.dataset.tipTitle = title;
  button.dataset.tip = `${STATS_INT.format(item.valor)} ${item.metrica} contra una mediana de ${STATS_INT.format(item.mediana)} en ${account} · ${item.sentimiento || 'sin tono'}`;
  button.setAttribute('aria-label', `${index + 1}. ${title}, de ${account}: ${ratio} en ${item.metrica}. Abrir la publicación`);
  button.addEventListener('click', () => openFeedPopList(ids.filter((id) => statsPostOf(id)), item.id, button));
  return button;
}

function statsRenderRanking() {
  const list = statsData.ranking.slice(0, STATS_RANK_SHOWN);
  if (!list.length) {
    statsRankEl.replaceChildren(
      statsData.resumen.relevantes ? statsNode('p', 'stats-empty', 'Ninguna publicación del período tiene con qué compararse en su cuenta.') : statsEmptyLine()
    );
    return;
  }
  const ids = list.map((item) => String(item.id));
  statsRankEl.replaceChildren(...list.map((item, i) => statsRankButton(item, i, ids)));
}

// -------------------------------------------------------------------------
// Todo el período.
// -------------------------------------------------------------------------
function statsRender() {
  const { periodo } = statsData;
  statsShowPeriodNote(
    periodo.desdeEfectivo && periodo.desdeEfectivo > periodo.desde
      ? `Hay publicaciones guardadas desde el ${statsShort(periodo.desdeEfectivo)}: el período cuenta desde ahí.`
      : ''
  );
  statsRenderKpis();
  statsRenderCloud();
  statsRenderMentions();
  statsRenderDonut();
  statsRenderTopics();
  statsRenderHeat();
  statsRenderNet();
  statsRenderAccounts();
  statsRenderRanking();
}

// -------------------------------------------------------------------------
// Controles.
// -------------------------------------------------------------------------
statsPeriodEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-days]');
  if (!button) return;
  const dias = Number(button.dataset.days);
  if (statsPeriodo.dias === dias) return;
  statsSetPeriod({ dias });
});

// Desde → Hasta: con las dos fechas bien, ese período; si termina hoy y
// tiene 7, 30 o 90 días, es ese botón.
function statsOnDates() {
  const desde = statsFromEl.value;
  const hasta = statsToEl.value;
  const problem = statsRangeProblem(desde, hasta);
  if (problem) {
    statsShowPeriodNote(problem);
    return;
  }
  const dias = statsDaysBetween(desde, hasta);
  statsSetPeriod(hasta === statsToday() && STATS_DAYS.includes(dias) ? { dias } : { desde, hasta });
}
statsFromEl.addEventListener('change', statsOnDates);
statsToEl.addEventListener('change', statsOnDates);
statsRetryEl.addEventListener('click', statsLoad);

statsCloudSegEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-mode]');
  if (!button || button.dataset.mode === statsCloudMode) return;
  statsCloudMode = button.dataset.mode;
  for (const b of statsCloudSegEl.querySelectorAll('button[data-mode]')) {
    b.classList.toggle('on', b === button);
    b.setAttribute('aria-pressed', String(b === button));
  }
  if (statsData) statsBuildCloud();
});

statsAccSegEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-sort]');
  if (!button || button.dataset.sort === statsAccSort) return;
  statsAccSort = button.dataset.sort;
  for (const b of statsAccSegEl.querySelectorAll('button[data-sort]')) {
    b.classList.toggle('on', b === button);
    b.setAttribute('aria-pressed', String(b === button));
  }
  if (statsData) statsRenderAccounts();
});

// Otro ancho, otra nube.
let statsResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(statsResizeTimer);
  statsResizeTimer = setTimeout(() => {
    if (statsData && statsTabVisible() && statsCloudEl.clientWidth !== statsCloudWidth) statsBuildCloud();
  }, 150);
});

// Cambiaron los posteos de la tabla: se vuelve a pedir ya si la solapa está
// a la vista (y el pop-up cerrado, para no rehacer lo que está debajo); si
// no, openStats lo hace al volver.
function statsRefreshIfStale() {
  if (!statsData || !statsTabVisible() || (statsPopEl && statsPopEl.open)) return;
  if (statsIsStale()) statsLoad();
}
monitoringViewListeners.push((change) => {
  if (change && ('config' in change || change.run === 'start')) return;
  statsRefreshIfStale();
});
if (statsPopEl) statsPopEl.addEventListener('close', statsRefreshIfStale);

statsPaintPeriod();
// Si la página se abrió en #tab-stats antes de que este archivo cargara.
if (statsTabVisible()) openStats();
