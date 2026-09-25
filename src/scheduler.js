// ==========================================================================
// scheduler.js
// --------------------------------------------------------------------------
// Agenda el ciclo de monitoreo para que corra solo, cada 4 horas, usando
// "node-cron" (una librería chica que solo necesita un string cron estándar
// y ejecuta la función dentro de este mismo proceso Node).
//
// No sabe de plataformas: el ciclo recorre el registro de src/platforms/ y
// cada paso posterior (benchmark, refresco de métricas) decide por las
// capabilities de cada adapter. "Actualizar ahora" desde una solapa pasa
// `plataforma` y el ciclo se acota a esa sola.
//
// IMPORTANTE: esto SOLO corre mientras el proceso de Node quede abierto. Si
// cerrás la terminal o la PC se suspende, esa corrida se saltea en silencio.
// El día que se despliegue a un hosting siempre encendido, no hace falta
// cambiar nada acá.
// ==========================================================================

const cron = require('node-cron');
const db = require('./db');
const { runMonitoringCycle } = require('./monitor');
const { listPlatformIds } = require('./platforms');
const { processPendingReclamos } = require('./geoWorker');
const { refreshStaleAccountStats, benchmarkLimiter } = require('./accountStats');
const { refreshPostMetrics, refreshLimiter } = require('./metricsRefresh');
const { runWithContext } = require('./usageContext');
const { formatCycleCostLine, reconcileRealCosts } = require('./apifyCost');
const { apifyLimiter } = require('./apify');
const progress = require('./monitoringProgress');

// Corridas a las 8, 12, 16 y 20 (hora local del server): sin las de 0 y 4,
// que costaban lo mismo y casi no traían nada. Configurable con MONITOR_CRON.
const DEFAULT_CRON = '0 8,12,16,20 * * *';

// Plataformas que corre el ciclo AUTOMÁTICO (el cron). X está en stand by
// (su detección no funciona hoy), así que por defecto el cron corre solo
// Instagram; MONITOR_PLATFORMS=instagram,x la vuelve a sumar sin tocar
// código. "Actualizar ahora" no mira esto: corre la plataforma de la
// solapa que apretó el botón, X incluida.
const DEFAULT_CRON_PLATFORMS = ['instagram'];

// Heartbeat del ciclo en curso (Cambio G — diagnóstico del cuelgue real de
// ~30 min): si pasan estos ms sin que NINGUNA llamada termine (ni de
// detección, ni de benchmark, ni de refresco), se loguea un snapshot de la
// fase actual y qué tareas siguen activas en cada limitador — exactamente
// lo que hubiera hecho falta para saber qué llamada quedó colgada. Siempre
// activo mientras corre un ciclo, sin flag de DEBUG (a propósito).
const HEARTBEAT_STALE_MS = 15000;
const HEARTBEAT_CHECK_MS = 15000;

// Momento en que terminó la última corrida (cron o "Actualizar ahora"), para
// el pie de página. En memoria nomás: si el server reinicia, vuelve a null
// hasta la próxima corrida — el frontend lo maneja ocultando el dato en vez
// de inventar una hora.
let lastRunAt = null;

// Un solo ciclo a la vez: el clasificador es lento (await por posteo) y dos
// corridas en paralelo (cron + botón, o dos pestañas) llegan las dos a
// isKnownPost === false y la segunda revienta con UNIQUE al insertar.
let cycleInProgress = false;

function getCronExpression() {
  return process.env.MONITOR_CRON || DEFAULT_CRON;
}

function getLastRunAt() {
  return lastRunAt;
}

/**
 * Plataformas del ciclo automático según MONITOR_PLATFORMS (lista separada
 * por comas, ids del registro de src/platforms/). Vacía o ausente: el
 * default (solo Instagram). Un id desconocido se ignora con aviso; si no
 * queda ninguno válido, el default. Orden y duplicados: como se escribió,
 * sin repetidos.
 * @param {(msg: string) => void} [log] para tests
 * @returns {string[]}
 */
function cronPlatforms(log = console.warn) {
  const raw = String(process.env.MONITOR_PLATFORMS ?? '').trim();
  if (!raw) return [...DEFAULT_CRON_PLATFORMS];
  const known = listPlatformIds();
  const wanted = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = wanted.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    log(`[monitor] MONITOR_PLATFORMS: se ignoran plataformas desconocidas: ${unknown.join(', ')} (válidas: ${known.join(', ')}).`);
  }
  const valid = [...new Set(wanted.filter((id) => known.includes(id)))];
  if (valid.length === 0) {
    log(`[monitor] MONITOR_PLATFORMS="${raw}" no deja ninguna plataforma válida: se usa el default (${DEFAULT_CRON_PLATFORMS.join(', ')}).`);
    return [...DEFAULT_CRON_PLATFORMS];
  }
  return valid;
}

/**
 * Corridas por día a partir del campo de horas de la expresión cron
 * (ej. cada 4 horas -> 6). Cubre los formatos que MONITOR_CRON admite en
 * el .env.example: notación de paso (cada N horas), "*" (cada hora), lista
 * de horas fijas ("6,12,18") y una sola hora fija.
 */
function estimateRunsPerDay(cronExpression) {
  const hourField = String(cronExpression || '').trim().split(/\s+/)[1] || '*';
  if (hourField === '*') return 24;
  const step = hourField.match(/^\*\/(\d+)$/);
  if (step) return Math.max(1, Math.round(24 / Number(step[1])));
  const fixedHours = hourField.split(',').filter(Boolean).length;
  return fixedHours > 0 ? fixedHours : 1;
}

/**
 * Lista ordenada de horas (0-23) en las que dispara la expresión cron, para
 * el mismo subconjunto de formatos que ya interpreta estimateRunsPerDay
 * ("*", paso "*" + N, lista fija de horas).
 */
function parseHourField(hourField) {
  if (hourField === '*') return Array.from({ length: 24 }, (_, i) => i);
  const step = hourField.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Math.max(1, Number(step[1]));
    const hours = [];
    for (let h = 0; h < 24; h += n) hours.push(h);
    return hours;
  }
  const fixed = hourField
    .split(',')
    .map(Number)
    .filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
  return fixed.length > 0 ? fixed.sort((a, b) => a - b) : [0];
}

/**
 * Próxima vez que va a disparar el cron, a partir de "from" (por defecto,
 * ahora). Mismo formato de MONITOR_CRON que ya soporta el resto de este
 * archivo — no depende de una librería de parseo de cron aparte.
 * @returns {Date}
 */
function getNextRunAt(cronExpression, from = new Date()) {
  const parts = String(cronExpression || '').trim().split(/\s+/);
  const minuteField = parts[0] || '0';
  const hourField = parts[1] || '*';
  const minute = Number.isFinite(Number(minuteField)) ? Number(minuteField) : 0;
  const hours = parseHourField(hourField);

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const hour of hours) {
      const candidate = new Date(from);
      candidate.setDate(candidate.getDate() + dayOffset);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate > from) return candidate;
    }
  }
  // No debería pasar (parseHourField siempre devuelve al menos una hora
  // válida), pero por las dudas: mismo horario mañana.
  const fallback = new Date(from);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(hours[0], minute, 0, 0);
  return fallback;
}

/**
 * Corre un ciclo de monitoreo completo: detecta y clasifica posteos nuevos,
 * geocodifica reclamos pendientes y refresca benchmark/métricas de cuentas
 * (en las plataformas que lo soportan). Exportada aparte para poder
 * llamarla a mano (botón "Actualizar ahora").
 *
 * @param {{ ifBusy?: 'throw'|'skip', plataforma?: string, plataformas?: string[], trigger?: 'cron'|'manual' }} [options]
 *   plataforma: acota el ciclo a esa sola (la solapa que apretó el botón).
 *   plataformas: lista explícita (el cron pasa cronPlatforms()). Sin
 *   ninguna de las dos corre todo el registro.
 *   trigger: quién disparó el ciclo, para la fila de monitoring_runs (el
 *   cron pasa 'cron'; el botón "Actualizar ahora" queda en 'manual') y
 *   para que un error de plataforma solo se tire al usuario en una corrida
 *   manual (ver runMonitoringCycle).
 */
async function runCycle({ ifBusy = 'throw', plataforma, plataformas, trigger = 'manual' } = {}) {
  if (cycleInProgress) {
    if (ifBusy === 'skip') {
      console.log('[monitor] ya hay un ciclo en curso; se saltea este disparo.');
      return { checked: 0, newCount: 0, skipped: true };
    }
    const err = new Error('Ya hay un ciclo de monitoreo en curso');
    err.userMessage = 'Ya hay un ciclo de monitoreo en curso. Esperá a que termine.';
    err.code = 'CYCLE_IN_PROGRESS';
    throw err;
  }

  cycleInProgress = true;
  try {
    return await runCycleUnlocked(plataformas || (plataforma ? [plataforma] : undefined), trigger);
  } finally {
    cycleInProgress = false;
  }
}

/** "42s"/"1m 12s": duración legible para los logs de ciclo y heartbeat. */
function formatDurationMs(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Activas de un limitador para el snapshot del heartbeat, formateadas "target (Ns)". */
function formatActiveTargets(limiter) {
  const active = limiter.activeTargets();
  if (active.length === 0) return '(ninguna)';
  return active.map(({ target, elapsedMs }) => `${target || '?'} (${formatDurationMs(elapsedMs)})`).join(', ');
}

/**
 * Mientras corre un ciclo: si pasan HEARTBEAT_STALE_MS sin que se registre
 * ningún tick de progreso, loguea la fase actual y qué está activo en cada
 * limitador. Se repite cada vez que el chequeo encuentra que sigue sin
 * actividad — mientras el cuelgue continúe, sigue avisando.
 */
function startHeartbeat() {
  return setInterval(() => {
    const lastActivityAt = progress.getLastActivityAt();
    if (lastActivityAt == null) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs < HEARTBEAT_STALE_MS) return;

    const current = progress.getProgress();
    const faseTexto = current ? `${current.phase} (${current.done}/${current.total}, ${current.percent}%)` : '(ninguna fase activa)';
    console.warn(
      `[heartbeat] ${formatDurationMs(idleMs)} sin que termine ninguna llamada. Fase: ${faseTexto}. ` +
        `Activos — apify: [${formatActiveTargets(apifyLimiter)}], benchmark: [${formatActiveTargets(benchmarkLimiter)}], ` +
        `refresco: [${formatActiveTargets(refreshLimiter)}].`
    );
  }, HEARTBEAT_CHECK_MS);
}

/**
 * Abre la fila del ciclo en monitoring_runs, corre las fases y la cierra con
 * los totales de gasto en Apify (ver src/apifyCost.js), pase lo que pase.
 * El registro nunca frena el ciclo: si la base falla al abrir, el ciclo
 * corre igual sin run_id; si falla al cerrar, se loguea.
 */
async function runCycleUnlocked(plataformas, trigger = 'manual') {
  const cycleStartedAt = Date.now();
  const plataformaTexto = plataformas ? plataformas.join(',') : 'todas';
  console.log(`[ciclo] inicio (trigger=${trigger}, plataforma=${plataformaTexto})`);

  let runId = null;
  try {
    runId = db.startMonitoringRun({ trigger, plataforma: plataformaTexto });
  } catch (err) {
    console.error('[costo] No se pudo abrir el registro del ciclo:', err.message);
  }

  progress.startCycle();
  const heartbeat = startHeartbeat();
  let newCount = 0;
  let cycleError = null;
  try {
    const result = await runCyclePhases(plataformas, runId, trigger);
    newCount = result.newCount;
    return result;
  } catch (err) {
    cycleError = err;
    throw err;
  } finally {
    clearInterval(heartbeat);
    progress.endCycle();
    console.log(
      `[ciclo] fin (duración ${formatDurationMs(Date.now() - cycleStartedAt)}, resultado=${cycleError ? 'error' : 'ok'}${
        cycleError ? `: ${cycleError.message}` : ''
      })`
    );
    if (runId != null) {
      try {
        console.log(formatCycleCostLine(db.finishMonitoringRun(runId, { newPosts: newCount })));
      } catch (err) {
        console.error('[costo] No se pudo cerrar el registro del ciclo:', err.message);
      }
    }
    // Costo real de las llamadas de ciclos ANTERIORES (las de este todavía
    // no están asentadas en Apify): lecturas gratis de la API, nunca tira.
    const reconciled = await reconcileRealCosts();
    if (reconciled.updated > 0) {
      console.log(
        `[costo] costo real conciliado en ${reconciled.updated} llamada(s) anteriores: US$ ${reconciled.usdReal.toFixed(4)} ` +
          `(estimado US$ ${reconciled.usdEstimado.toFixed(4)})` +
          (reconciled.pending + reconciled.failed > 0 ? `; ${reconciled.pending + reconciled.failed} siguen pendientes` : '')
      );
    }
  }
}

/** Une listas de cuentas por plataforma ({ instagram: [...] }) para skipAccounts de refreshPostMetrics. */
function mergeSkipAccounts(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [plataforma, accounts] of Object.entries(source || {})) {
      merged[plataforma] = [...(merged[plataforma] || []), ...(accounts || [])];
    }
  }
  return merged;
}

// Las tres fases con Apify van envueltas en su contexto ('monitoreo',
// 'benchmark', 'refresco') para que cada llamada a Apify se registre con
// su ciclo y su fase (src/usageContext.js). Solo medición: la lógica de
// cada fase no cambia.
async function runCyclePhases(plataformas, runId, trigger) {
  const { checked, newPosts, scrapedAccounts, porPlataforma } = await runWithContext(
    { runId, phase: 'monitoreo' },
    () => runMonitoringCycle({ plataformas, trigger })
  );
  const newCount = (newPosts || []).length;

  try {
    await processPendingReclamos();
  } catch (err) {
    console.error('Error geocodificando reclamos pendientes:', err.message);
  }

  // Benchmark DESPUÉS de guardar los posteos nuevos: solo se recalculan las
  // cuentas que acaban de aparecer con un posteo (nunca calculadas, o con
  // el último cálculo de BENCHMARK_RECALC_DAYS o más), así ese posteo ya
  // sale con benchmark en este mismo ciclo. Cada módulo recorre solo las
  // plataformas (del subconjunto pedido) cuyo adapter tiene esa capability:
  // "Actualizar ahora" en una solapa sin benchmark no gasta nada acá.
  let recalculatedAccounts = {};
  try {
    ({ recalculatedAccounts } = await runWithContext({ runId, phase: 'benchmark' }, () => refreshStaleAccountStats({ plataformas })));
  } catch (err) {
    console.error('Error recalculando el benchmark de cuentas:', err.message);
  }

  // Refresco de métricas sin las cuentas que este ciclo ya consultó: las
  // trackeadas que scrapeó el monitoreo y las que acaba de pasar el
  // benchmark (computeAccountStats actualiza sus posteos con esa misma
  // pasada, no hay que pagarla dos veces).
  try {
    await runWithContext({ runId, phase: 'refresco' }, () =>
      refreshPostMetrics({ plataformas, skipAccounts: mergeSkipAccounts(scrapedAccounts, recalculatedAccounts) })
    );
  } catch (err) {
    console.error('Error refrescando métricas de posteos:', err.message);
  }

  lastRunAt = new Date().toISOString();

  return { checked, newCount, porPlataforma };
}

function startScheduler() {
  const cronExpression = getCronExpression();
  const plataformas = cronPlatforms();

  cron.schedule(cronExpression, () => {
    runCycle({ ifBusy: 'skip', trigger: 'cron', plataformas }).catch((err) => {
      console.error('Error en el ciclo de monitoreo agendado:', err.message);
    });
  });

  const fuera = listPlatformIds().filter((id) => !plataformas.includes(id));
  console.log(
    `✅ Monitoreo automático agendado (cron: "${cronExpression}", plataformas: ${plataformas.join(', ')}` +
      (fuera.length > 0 ? `; ${fuera.join(', ')} fuera del ciclo automático, MONITOR_PLATFORMS para sumarla` : '') +
      ')'
  );
}

module.exports = {
  startScheduler,
  runCycle,
  getCronExpression,
  getLastRunAt,
  estimateRunsPerDay,
  getNextRunAt,
  cronPlatforms,
  DEFAULT_CRON_PLATFORMS,
};
