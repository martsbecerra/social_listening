// ==========================================================================
// apifyCost.js
// --------------------------------------------------------------------------
// Cuánto gasta la app en Apify. Hay dos actores con dos modelos de cobro:
//   - apify/instagram-scraper (el "oficial": análisis de publicación, y el
//     monitoreo con IG_ACTOR=apify): cobra POR RESULTADO devuelto (item del
//     dataset, incluidos los items de error no_items / not_found), a una
//     tarifa por 1000 que depende del plan (APIFY_PLAN, APIFY_RATE_*).
//   - apidojo/instagram-scraper-api (el monitoreo por defecto): cobra POR
//     CONSULTA con posteos incluidos (perfil 0,005 usd con 10; hashtag 0,015
//     con 30; búsqueda 0,015 con 20; posteo suelto 0,005) más 0,0005 usd
//     por cada posteo de más (APIDOJO_RATE_*, APIDOJO_INCLUDED_*). Además,
//     como estas llamadas van por el flujo asincrónico (src/apify.js), la
//     fila guarda también lo que Apify cobró de verdad (usd_real).
// Acá viven:
//   - las tarifas y el plan activo,
//   - el registro de cada llamada (recordApifyCall, lo llama runActorSync):
//     actor, tipo de consulta (queryTypeFor), usd estimado, usd_real,
//   - el reporte por ventana, fase y actor (summarizeCosts, lo usan
//     scripts/costo-apify.js y GET /api/monitoring/costs),
//   - la línea "[costo] ciclo #N ..." que imprime el scheduler.
// Nada de acá puede tirar abajo una llamada real ni un ciclo:
// recordApifyCall atrapa sus errores y los loguea.
//
// Columna usd: el estimado al momento de registrar (tarifa del plan activo
// para el oficial; tarifa de la consulta + extras para apidojo). En los
// reportes, las filas del oficial se recalculan desde los resultados con
// las tres tarifas a la vez (cambiar de plan no invalida el histórico); las
// de apidojo usan usd_real cuando existe y, si no, el usd estimado.
// ==========================================================================

const db = require('./db');

const PLANS = ['free', 'starter', 'scale'];
const DEFAULT_RATES = { free: 2.7, starter: 2.3, scale: 1.9 };
const OFFICIAL_ACTOR = 'apify~instagram-scraper';
const APIDOJO_ACTOR = 'apidojo~instagram-scraper-api';
// Tarifas de apidojo (USD por consulta, USD por posteo extra) y posteos
// incluidos por consulta, según su pestaña de precios (septiembre 2026).
const APIDOJO_DEFAULTS = {
  user: 0.005,
  hashtag: 0.015,
  search: 0.015,
  post: 0.005,
  item: 0.0005,
  includedUser: 10,
  includedHashtag: 30,
  includedSearch: 20,
};
const QUERY_TYPES = ['user', 'hashtag', 'search', 'post', 'details'];
const DAY_MS = 24 * 60 * 60 * 1000;

function parseRate(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseCount(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Tarifas del actor oficial en USD por 1000 resultados, por plan (del .env o los defaults). Se leen en cada llamada, no al cargar. */
function getRates() {
  return {
    free: parseRate(process.env.APIFY_RATE_FREE, DEFAULT_RATES.free),
    starter: parseRate(process.env.APIFY_RATE_STARTER, DEFAULT_RATES.starter),
    scale: parseRate(process.env.APIFY_RATE_SCALE, DEFAULT_RATES.scale),
  };
}

/** Tarifas de apidojo: USD por consulta según tipo, USD por posteo extra y posteos incluidos por tipo. */
function getApidojoRates() {
  return {
    user: parseRate(process.env.APIDOJO_RATE_USER, APIDOJO_DEFAULTS.user),
    hashtag: parseRate(process.env.APIDOJO_RATE_HASHTAG, APIDOJO_DEFAULTS.hashtag),
    search: parseRate(process.env.APIDOJO_RATE_SEARCH, APIDOJO_DEFAULTS.search),
    post: parseRate(process.env.APIDOJO_RATE_POST, APIDOJO_DEFAULTS.post),
    item: parseRate(process.env.APIDOJO_RATE_ITEM, APIDOJO_DEFAULTS.item),
    included: {
      user: parseCount(process.env.APIDOJO_INCLUDED_USER, APIDOJO_DEFAULTS.includedUser),
      hashtag: parseCount(process.env.APIDOJO_INCLUDED_HASHTAG, APIDOJO_DEFAULTS.includedHashtag),
      search: parseCount(process.env.APIDOJO_INCLUDED_SEARCH, APIDOJO_DEFAULTS.includedSearch),
    },
  };
}

let warnedPlan = null;
/** Plan activo (APIFY_PLAN). Un valor desconocido cae a 'starter', avisando una sola vez por valor. */
function getActivePlan() {
  const raw = String(process.env.APIFY_PLAN || 'starter').trim().toLowerCase();
  if (PLANS.includes(raw)) return raw;
  if (warnedPlan !== raw) {
    warnedPlan = raw;
    console.warn(`[costo] APIFY_PLAN="${raw}" no es free, starter ni scale: se usa starter.`);
  }
  return 'starter';
}

/** true para el actor oficial, incluidas las filas viejas sin actor. */
function isOfficialActor(actor) {
  return !actor || actor === OFFICIAL_ACTOR;
}

/** Nombre legible del actor ("apify/instagram-scraper"). */
function actorLabel(actor) {
  return String(actor || OFFICIAL_ACTOR).replace('~', '/');
}

/** USD que cuestan `items` resultados del actor oficial en el plan dado (default: el activo). */
function usdForItems(items, plan = getActivePlan()) {
  const count = Number(items) || 0;
  const rates = getRates();
  const rate = rates[plan] ?? rates.starter;
  return (count * rate) / 1000;
}

/** Los mismos resultados del actor oficial valuados con las tres tarifas: { free, starter, scale }. */
function usdByPlan(items) {
  return { free: usdForItems(items, 'free'), starter: usdForItems(items, 'starter'), scale: usdForItems(items, 'scale') };
}

/**
 * USD de una consulta de apidojo: tarifa del tipo de consulta más los
 * posteos por encima de los incluidos. Un posteo suelto es tarifa plana.
 * Un tipo desconocido se valúa como consulta de perfil.
 */
function usdForApidojo(queryType, items, rates = getApidojoRates()) {
  const count = Number(items) || 0;
  const type = QUERY_TYPES.includes(queryType) ? queryType : 'user';
  if (type === 'post') return rates.post;
  if (type === 'details') return rates.user;
  const included = rates.included[type] ?? 0;
  return rates[type] + Math.max(0, count - included) * rates.item;
}

/** USD estimado de una llamada según el actor: oficial por resultados y plan; apidojo por consulta. */
function usdForCall({ actor, queryType, items, plan }) {
  return isOfficialActor(actor) ? usdForItems(items, plan) : usdForApidojo(queryType, items);
}

function urlOf(entry) {
  if (typeof entry === 'string') return entry;
  return entry && typeof entry === 'object' && typeof entry.url === 'string' ? entry.url : null;
}

/**
 * Tipo de consulta (user | hashtag | search | post | details) a partir del
 * input del actor: keywords es búsqueda; una URL de /explore/tags/ es
 * hashtag, de /explore/search/ es búsqueda, de /p/ o /reel/ es un posteo
 * suelto, cualquier otra es un perfil. Para el actor oficial,
 * resultsType 'details' es la consulta de seguidores. null si no se puede
 * saber (input vacío).
 */
function queryTypeFor(actor, input) {
  const i = input || {};
  if (Array.isArray(i.keywords) && i.keywords.length > 0) return 'search';
  if (isOfficialActor(actor) && i.resultsType === 'details') return 'details';
  const list = Array.isArray(i.directUrls) && i.directUrls.length > 0 ? i.directUrls : Array.isArray(i.startUrls) ? i.startUrls : [];
  const first = list.length > 0 ? urlOf(list[0]) : null;
  if (typeof first !== 'string') return null;
  if (/\/explore\/tags\//.test(first)) return 'hashtag';
  if (/\/explore\/search\//.test(first)) return 'search';
  if (/\/(p|reel|reels|tv)\//.test(first)) return 'post';
  return 'user';
}

/**
 * target / results_type para la fila, a partir del input del actor. El actor
 * oficial usa directUrls + resultsType; apidojo usa startUrls (URLs planas)
 * o keywords (búsqueda por palabra clave) y no tiene resultsType. El resto
 * es por si algún actor futuro identifica la corrida de otra forma.
 */
function describeInput(input) {
  const i = input || {};
  let target = null;
  if (Array.isArray(i.directUrls) && i.directUrls.length > 0) target = i.directUrls.map(urlOf).filter(Boolean).join(', ');
  else if (Array.isArray(i.startUrls) && i.startUrls.length > 0) target = i.startUrls.map(urlOf).filter(Boolean).join(', ');
  else if (Array.isArray(i.keywords) && i.keywords.length > 0) target = i.keywords.join(', ');
  else if (typeof i.username === 'string') target = i.username;
  else if (Array.isArray(i.usernames) && i.usernames.length > 0) target = i.usernames.join(', ');
  else if (typeof i.search === 'string') target = i.search;
  return {
    target: target ? String(target).slice(0, 300) : null,
    resultsType: i.resultsType ? String(i.resultsType) : null,
  };
}

/**
 * Registra una llamada a Apify en apify_calls. NUNCA tira: una falla al
 * registrar se loguea y la llamada real sigue su curso.
 * @param {{ runId?: number|null, phase?: string, plataforma?: string, actor?: string, input?: object,
 *   items?: number, ok: boolean, error?: string|null, durationMs?: number, at?: string,
 *   queryType?: string|null, usdReal?: number|null, apifyRunId?: string|null }} call
 */
function recordApifyCall(call) {
  try {
    const { target, resultsType } = describeInput(call.input);
    const items = Number(call.items) || 0;
    const actor = call.actor || OFFICIAL_ACTOR;
    const queryType = call.queryType || queryTypeFor(actor, call.input);
    db.insertApifyCall({
      at: call.at,
      runId: call.runId ?? null,
      phase: call.phase || 'desconocida',
      plataforma: call.plataforma || 'instagram',
      actor,
      queryType,
      target,
      resultsType,
      items,
      ok: Boolean(call.ok),
      error: call.error ?? null,
      durationMs: call.durationMs,
      // Una llamada fallida no cobró la consulta (o no sabemos): usd 0; si
      // igual hubo run, usd_real dice la verdad.
      usd: call.ok ? usdForCall({ actor, queryType, items }) : 0,
      usdReal: call.usdReal ?? null,
      apifyRunId: call.apifyRunId ?? null,
    });
  } catch (err) {
    console.error('[costo] No se pudo registrar la llamada a Apify:', err.message);
  }
}

function startOfTodayIso(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const emptyOficial = () => ({ calls: 0, results: 0, failed: 0, usd: { free: 0, starter: 0, scale: 0 } });
const emptyApidojo = () => ({ calls: 0, results: 0, failed: 0, usd: 0, usdEstimado: 0, usdReal: null, callsConReal: 0 });
const emptyBucket = () => ({ calls: 0, results: 0, failed: 0, oficial: emptyOficial(), apidojo: emptyApidojo(), usd: null });

function addRow(bucket, row) {
  bucket.calls += row.calls;
  bucket.results += row.results;
  bucket.failed += row.failed;
  if (isOfficialActor(row.actor)) {
    bucket.oficial.calls += row.calls;
    bucket.oficial.results += row.results;
    bucket.oficial.failed += row.failed;
  } else {
    const a = bucket.apidojo;
    a.calls += row.calls;
    a.results += row.results;
    a.failed += row.failed;
    a.usdEstimado += row.usd;
    a.usd += row.usdBest;
    if (row.usdReal != null) a.usdReal = (a.usdReal || 0) + row.usdReal;
    a.callsConReal += row.withReal;
  }
}

/** Cierra un bucket: usd del oficial en las tres tarifas y total por plan = oficial + apidojo (real si existe, si no estimado). */
function closeBucket(bucket) {
  bucket.oficial.usd = usdByPlan(bucket.oficial.results);
  bucket.usd = {
    free: bucket.oficial.usd.free + bucket.apidojo.usd,
    starter: bucket.oficial.usd.starter + bucket.apidojo.usd,
    scale: bucket.oficial.usd.scale + bucket.apidojo.usd,
  };
  return bucket;
}

/**
 * Totales de una ventana (desde sinceIso) con el desglose por fase y, en
 * cada nivel, por actor: `oficial` (resultados, usd en las tres tarifas) y
 * `apidojo` (usd = real si existe, si no estimado; usdEstimado y usdReal
 * aparte). `usd` es el total por plan: oficial por plan + apidojo.
 */
function windowSummary(sinceIso, label, days) {
  const window = { label, days, since: sinceIso, ...emptyBucket(), porFase: {} };
  for (const row of db.sumApifyCallsSince(sinceIso)) {
    addRow(window, row);
    const phase = window.porFase[row.phase] || (window.porFase[row.phase] = emptyBucket());
    addRow(phase, row);
  }
  closeBucket(window);
  for (const phase of Object.values(window.porFase)) closeBucket(phase);
  return window;
}

/**
 * Reporte de gasto: hoy, últimos 7 días y últimos `days` días (default 30),
 * cada uno con llamadas, resultados, fallidas, usd por plan (oficial +
 * apidojo) y el desglose por fase y por actor; más la proyección mensual =
 * promedio diario de los últimos 7 × 30.
 * @param {{ days?: number, now?: number }} [options] now: para tests.
 */
function summarizeCosts({ days = 30, now = Date.now() } = {}) {
  const n = Math.max(1, Math.floor(Number(days)) || 30);
  const hoy = windowSummary(startOfTodayIso(now), 'hoy', null);
  const ultimos7 = windowSummary(new Date(now - 7 * DAY_MS).toISOString(), 'últimos 7 días', 7);
  const ventana = windowSummary(new Date(now - n * DAY_MS).toISOString(), `últimos ${n} días`, n);
  const scale = 30 / 7;
  const proyeccionMensual = {
    base: 'promedio diario de los últimos 7 días × 30',
    calls: Math.round(ultimos7.calls * scale),
    results: Math.round(ultimos7.results * scale),
    usd: {
      free: ultimos7.usd.free * scale,
      starter: ultimos7.usd.starter * scale,
      scale: ultimos7.usd.scale * scale,
    },
    oficial: { results: Math.round(ultimos7.oficial.results * scale), usd: usdByPlan(ultimos7.oficial.results * scale) },
    apidojo: { calls: Math.round(ultimos7.apidojo.calls * scale), usd: ultimos7.apidojo.usd * scale },
  };
  return {
    generatedAt: new Date(now).toISOString(),
    plan: getActivePlan(),
    rates: getRates(),
    apidojoRates: getApidojoRates(),
    actores: { oficial: actorLabel(OFFICIAL_ACTOR), apidojo: actorLabel(APIDOJO_ACTOR) },
    hoy,
    ultimos7,
    ventana,
    proyeccionMensual,
  };
}

/**
 * Línea de consola al cerrar un ciclo. El total en USD (real donde Apify
 * lo devolvió, si no el estimado del plan activo); el desglose entre
 * paréntesis, en resultados por fase.
 * @param {{ id: number, calls: number, results: number, usd: number, porFase: Object<string, {results: number}> }} run
 */
function formatCycleCostLine(run) {
  const resultsOf = (phase) => (run.porFase && run.porFase[phase] ? run.porFase[phase].results : 0);
  return (
    `[costo] ciclo #${run.id}: ${run.calls} llamadas, ${run.results} resultados ≈ US$ ${Number(run.usd || 0).toFixed(2)} ` +
    `(monitoreo ${resultsOf('monitoreo')} · busqueda ${resultsOf('busqueda')} · benchmark ${resultsOf('benchmark')} · refresco ${resultsOf('refresco')})`
  );
}

module.exports = {
  PLANS,
  DEFAULT_RATES,
  OFFICIAL_ACTOR,
  APIDOJO_ACTOR,
  APIDOJO_DEFAULTS,
  QUERY_TYPES,
  getRates,
  getApidojoRates,
  getActivePlan,
  isOfficialActor,
  actorLabel,
  usdForItems,
  usdByPlan,
  usdForApidojo,
  usdForCall,
  queryTypeFor,
  describeInput,
  recordApifyCall,
  summarizeCosts,
  formatCycleCostLine,
};
