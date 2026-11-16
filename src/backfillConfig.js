// ==========================================================================
// backfillConfig.js
// --------------------------------------------------------------------------
// BACKFILL_MAX: cuántos posteos clasifica como mucho una invocación de
// POST /api/monitoring/backfill-classification (monitor.backfillClassification).
// Cada uno es una llamada al modelo: el tope acota el gasto de un clic. Lo que
// queda se hace en la próxima invocación. Entero positivo, por defecto 200;
// server.js lo valida al arrancar. Sin dependencias.
// ==========================================================================

const { leerEnteroPositivo } = require('./envEntero');

const DEFAULT_BACKFILL_MAX = 200;

function resolveBackfillMax(env = process.env) {
  return leerEnteroPositivo(env, 'BACKFILL_MAX', DEFAULT_BACKFILL_MAX);
}

module.exports = { resolveBackfillMax, DEFAULT_BACKFILL_MAX };
