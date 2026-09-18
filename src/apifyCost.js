// ==========================================================================
// apifyCost.js
// --------------------------------------------------------------------------
// Cuánto gasta la app en Apify. Apify cobra por resultado devuelto (item
// del dataset, incluidos los items de error no_items / not_found), a una
// tarifa por 1000 que depende del plan. Acá viven:
//   - las tarifas y el plan activo (.env: APIFY_PLAN, APIFY_RATE_FREE,
//     APIFY_RATE_STARTER, APIFY_RATE_SCALE),
//   - el registro de cada llamada (recordApifyCall, lo llama runActorSync),
//   - el reporte por ventana y por fase (summarizeCosts, lo usan
//     scripts/costo-apify.js y GET /api/monitoring/costs),
//   - la línea "[costo] ciclo #N ..." que imprime el scheduler.
// Nada de acá puede tirar abajo una llamada real ni un ciclo:
// recordApifyCall atrapa sus errores y los loguea.
//
// La columna usd de las tablas se calcula al registrar con la tarifa del
// plan activo; los reportes recalculan desde los resultados guardados con
// las tres tarifas a la vez, así cambiar de plan no invalida el histórico.
// ==========================================================================

const db = require('./db');

const PLANS = ['free', 'starter', 'scale'];
const DEFAULT_RATES = { free: 2.7, starter: 2.3, scale: 1.9 };
const DAY_MS = 24 * 60 * 60 * 1000;

function parseRate(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Tarifas en USD por 1000 resultados, por plan (del .env o los defaults). Se leen en cada llamada, no al cargar. */
function getRates() {
  return {
    free: parseRate(process.env.APIFY_RATE_FREE, DEFAULT_RATES.free),
    starter: parseRate(process.env.APIFY_RATE_STARTER, DEFAULT_RATES.starter),
    scale: parseRate(process.env.APIFY_RATE_SCALE, DEFAULT_RATES.scale),
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

/** USD que cuestan `items` resultados en el plan dado (default: el activo). */
function usdForItems(items, plan = getActivePlan()) {
  const count = Number(items) || 0;
  const rates = getRates();
  const rate = rates[plan] ?? rates.starter;
  return (count * rate) / 1000;
}

/** Los mismos resultados valuados con las tres tarifas: { free, starter, scale }. */
function usdByPlan(items) {
  return { free: usdForItems(items, 'free'), starter: usdForItems(items, 'starter'), scale: usdForItems(items, 'scale') };
}

/**
 * target / results_type para la fila, a partir del input del actor. Todas
 * las llamadas de la app usan directUrls; el resto es por si algún actor
 * futuro identifica la corrida de otra forma.
 */
function describeInput(input) {
  const i = input || {};
  let target = null;
  if (Array.isArray(i.directUrls) && i.directUrls.length > 0) target = i.directUrls.join(', ');
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
 * @param {{ runId?: number|null, phase?: string, plataforma?: string, input?: object,
 *   items?: number, ok: boolean, error?: string|null, durationMs?: number, at?: string }} call
 */
function recordApifyCall(call) {
  try {
    const { target, resultsType } = describeInput(call.input);
    const items = Number(call.items) || 0;
    db.insertApifyCall({
      at: call.at,
      runId: call.runId ?? null,
      phase: call.phase || 'desconocida',
      plataforma: call.plataforma || 'instagram',
      target,
      resultsType,
      items,
      ok: Boolean(call.ok),
      error: call.error ?? null,
      durationMs: call.durationMs,
      usd: usdForItems(items),
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

/** Totales de una ventana (desde sinceIso) con el desglose por fase, cada usd en las tres tarifas. */
function windowSummary(sinceIso, label, days) {
  const porFase = {};
  let calls = 0;
  let results = 0;
  let failed = 0;
  for (const row of db.sumApifyCallsSince(sinceIso)) {
    porFase[row.phase] = { calls: row.calls, results: row.results, failed: row.failed, usd: usdByPlan(row.results) };
    calls += row.calls;
    results += row.results;
    failed += row.failed;
  }
  return { label, days, since: sinceIso, calls, results, failed, usd: usdByPlan(results), porFase };
}

/**
 * Reporte de gasto: hoy, últimos 7 días y últimos `days` días (default 30),
 * cada uno con llamadas, resultados, fallidas, usd por plan y desglose por
 * fase; más la proyección mensual = promedio diario de los últimos 7 × 30.
 * @param {{ days?: number, now?: number }} [options] now: para tests.
 */
function summarizeCosts({ days = 30, now = Date.now() } = {}) {
  const n = Math.max(1, Math.floor(Number(days)) || 30);
  const hoy = windowSummary(startOfTodayIso(now), 'hoy', null);
  const ultimos7 = windowSummary(new Date(now - 7 * DAY_MS).toISOString(), 'últimos 7 días', 7);
  const ventana = windowSummary(new Date(now - n * DAY_MS).toISOString(), `últimos ${n} días`, n);
  const dailyCalls = ultimos7.calls / 7;
  const dailyResults = ultimos7.results / 7;
  const proyeccionMensual = {
    base: 'promedio diario de los últimos 7 días × 30',
    calls: Math.round(dailyCalls * 30),
    results: Math.round(dailyResults * 30),
    usd: usdByPlan(dailyResults * 30),
  };
  return {
    generatedAt: new Date(now).toISOString(),
    plan: getActivePlan(),
    rates: getRates(),
    hoy,
    ultimos7,
    ventana,
    proyeccionMensual,
  };
}

/**
 * Línea de consola al cerrar un ciclo. El total en USD (plan activo); el
 * desglose entre paréntesis, en resultados por fase.
 * @param {{ id: number, calls: number, results: number, usd: number, porFase: Object<string, {results: number}> }} run
 */
function formatCycleCostLine(run) {
  const resultsOf = (phase) => (run.porFase && run.porFase[phase] ? run.porFase[phase].results : 0);
  return (
    `[costo] ciclo #${run.id}: ${run.calls} llamadas, ${run.results} resultados ≈ US$ ${Number(run.usd || 0).toFixed(2)} ` +
    `(monitoreo ${resultsOf('monitoreo')} · benchmark ${resultsOf('benchmark')} · refresco ${resultsOf('refresco')})`
  );
}

module.exports = {
  PLANS,
  DEFAULT_RATES,
  getRates,
  getActivePlan,
  usdForItems,
  usdByPlan,
  describeInput,
  recordApifyCall,
  summarizeCosts,
  formatCycleCostLine,
};
