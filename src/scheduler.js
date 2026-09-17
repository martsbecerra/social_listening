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
const { runMonitoringCycle } = require('./monitor');
const { processPendingReclamos } = require('./geoWorker');
const { refreshStaleAccountStats } = require('./accountStats');
const { refreshPostMetrics } = require('./metricsRefresh');

const DEFAULT_CRON = '0 */4 * * *';

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
 * Corridas por día a partir del campo de horas de la expresión cron
 * (ej. cada 4 horas -> 6). Cubre los formatos que MONITOR_CRON admite en
 * el .env.example / Infisical: notación de paso (cada N horas), "*" (cada hora), lista
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
 * @param {{ ifBusy?: 'throw'|'skip', plataforma?: string }} [options]
 *   plataforma: acota el ciclo a esa sola (la solapa que apretó el botón);
 *   sin ella corre todo el registro (cron).
 */
async function runCycle({ ifBusy = 'throw', plataforma } = {}) {
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
    return await runCycleUnlocked(plataforma ? [plataforma] : undefined);
  } finally {
    cycleInProgress = false;
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

async function runCycleUnlocked(plataformas) {
  const { checked, newPosts, scrapedAccounts, porPlataforma } = await runMonitoringCycle({ plataformas });
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
    ({ recalculatedAccounts } = await refreshStaleAccountStats({ plataformas }));
  } catch (err) {
    console.error('Error recalculando el benchmark de cuentas:', err.message);
  }

  // Refresco de métricas sin las cuentas que este ciclo ya consultó: las
  // trackeadas que scrapeó el monitoreo y las que acaba de pasar el
  // benchmark (computeAccountStats actualiza sus posteos con esa misma
  // pasada, no hay que pagarla dos veces).
  try {
    await refreshPostMetrics({ plataformas, skipAccounts: mergeSkipAccounts(scrapedAccounts, recalculatedAccounts) });
  } catch (err) {
    console.error('Error refrescando métricas de posteos:', err.message);
  }

  lastRunAt = new Date().toISOString();

  return { checked, newCount, porPlataforma };
}

function startScheduler() {
  const cronExpression = getCronExpression();

  cron.schedule(cronExpression, () => {
    runCycle({ ifBusy: 'skip' }).catch((err) => {
      console.error('Error en el ciclo de monitoreo agendado:', err.message);
    });
  });

  console.log(`✅ Monitoreo automático agendado (cron: "${cronExpression}")`);
}

module.exports = {
  startScheduler,
  runCycle,
  getCronExpression,
  getLastRunAt,
  estimateRunsPerDay,
  getNextRunAt,
};
