// ==========================================================================
// scheduler.js
// --------------------------------------------------------------------------
// Agenda el ciclo de monitoreo para que corra solo, cada 4 horas, usando
// "node-cron" (una librería chica que solo necesita un string cron estándar
// y ejecuta la función dentro de este mismo proceso Node).
//
// IMPORTANTE: esto SOLO corre mientras el proceso de Node quede abierto. Si
// cerrás la terminal o la PC se suspende, esa corrida se saltea en silencio.
// El día que se despliegue a un hosting siempre encendido, no hace falta
// cambiar nada acá.
// ==========================================================================

const cron = require('node-cron');
const { runMonitoringCycle } = require('./monitor');
const { notifyNewPost } = require('./notify');
const { processPendingReclamos } = require('./geoWorker');
const { refreshStaleAccountStats } = require('./accountStats');
const db = require('./db');

const DEFAULT_CRON = '0 */4 * * *';

// Momento en que terminó la última corrida (cron o "Actualizar ahora"), para
// el pie de página. En memoria nomás: si el server reinicia, vuelve a null
// hasta la próxima corrida — el frontend lo maneja ocultando el dato en vez
// de inventar una hora.
let lastRunAt = null;

function getCronExpression() {
  return process.env.MONITOR_CRON || DEFAULT_CRON;
}

function getLastRunAt() {
  return lastRunAt;
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
 * Corre un ciclo de monitoreo completo y notifica cada posteo pendiente.
 * Además de los recién detectados en esta corrida, reintenta los de
 * corridas anteriores cuyo email haya fallado (ver db.listUnnotified) — así
 * un problema pasajero de SMTP no hace que un posteo se pierda para siempre.
 * Exportada aparte para poder llamarla a mano (botón "Actualizar ahora").
 */
async function runCycleAndNotify() {
  const { checked, newPosts } = await runMonitoringCycle();

  const pending = db.listUnnotified();
  for (const post of pending) {
    await notifyNewPost(post);
  }

  try {
    await processPendingReclamos();
  } catch (err) {
    console.error('Error geocodificando reclamos pendientes:', err.message);
  }

  try {
    await refreshStaleAccountStats();
  } catch (err) {
    console.error('Error recalculando el benchmark de cuentas:', err.message);
  }

  lastRunAt = new Date().toISOString();

  return { checked, newCount: newPosts.length };
}

function startScheduler() {
  const cronExpression = getCronExpression();

  cron.schedule(cronExpression, () => {
    runCycleAndNotify().catch((err) => {
      console.error('Error en el ciclo de monitoreo agendado:', err.message);
    });
  });

  console.log(`✅ Monitoreo automático agendado (cron: "${cronExpression}")`);
}

module.exports = {
  startScheduler,
  runCycleAndNotify,
  getCronExpression,
  getLastRunAt,
  estimateRunsPerDay,
  getNextRunAt,
};
