// ==========================================================================
// usageContext.js
// --------------------------------------------------------------------------
// "En qué ciclo y en qué fase estamos", viajando con la cadena de llamadas
// asincrónicas (AsyncLocalStorage de node:async_hooks). Así runActorSync
// (src/apify.js) puede registrar cada llamada a Apify con su ciclo (run_id)
// y su fase sin cambiar la firma de todos los callers del medio (adapters,
// monitor, benchmark, refresco).
//
// El scheduler envuelve cada fase del ciclo: 'monitoreo', 'benchmark',
// 'refresco'. Fuera de un ciclo el contexto es null: run_id queda null y la
// fase la fija el caller que la conoce ('validacion' al agregar cuenta o
// hashtag, 'recalc-script', 'analisis'). Una llamada sin contexto ni fase se
// registra igual, como 'desconocida', para no perder el gasto.
// ==========================================================================

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Corre fn con el contexto dado, combinado con el vigente si lo hay (un
 * caller puede fijar solo la fase y heredar el runId del ciclo, o al revés).
 * @param {{ runId?: number|null, phase?: string }} values
 * @param {() => any} fn
 * @returns {any} lo que devuelva fn (promesa incluida)
 */
function runWithContext(values, fn) {
  const current = storage.getStore() || {};
  return storage.run({ ...current, ...(values || {}) }, fn);
}

/** @returns {{ runId?: number|null, phase?: string } | null} null fuera de todo contexto. */
function getContext() {
  return storage.getStore() || null;
}

module.exports = { runWithContext, getContext };
