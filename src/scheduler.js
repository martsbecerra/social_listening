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
const db = require('./db');

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

  return { checked, newCount: newPosts.length };
}

function startScheduler() {
  const cronExpression = process.env.MONITOR_CRON || '0 */4 * * *';

  cron.schedule(cronExpression, () => {
    runCycleAndNotify().catch((err) => {
      console.error('Error en el ciclo de monitoreo agendado:', err.message);
    });
  });

  console.log(`✅ Monitoreo automático agendado (cron: "${cronExpression}")`);
}

module.exports = { startScheduler, runCycleAndNotify };
