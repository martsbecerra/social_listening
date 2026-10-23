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
