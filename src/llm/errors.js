// ==========================================================================
// llm/errors.js — Lo que los dos proveedores dicen igual cuando algo falla.
// --------------------------------------------------------------------------
//   - SALIDA_CORTADA: la respuesta llegó al tope de salida (max_tokens) y
//     quedó cortada. Otro intento igual se corta igual (y se cobra igual),
//     así que no se reintenta: quien llama decide (el análisis de
//     publicación parte la tanda en dos, src/analyzeComments.js). Con un
//     modelo que razona antes de contestar, el razonamiento también cuenta
//     para ese tope: pasó en la corrida real de la fase F (24/10/2026), una
//     tanda de 100 comentarios necesitaba unos 21.000 tokens de salida.
//   - conGasto: todo error de una llamada lleva lo ya gastado
//     (err.tokenUsage), porque un intento fallido también se cobra; si no,
//     el costo del análisis quedaba corto.
// ==========================================================================

const SALIDA_CORTADA = 'SALIDA_CORTADA';

/** @param {number} [maxTokens] el tope con que se pidió */
function salidaCortadaError(maxTokens) {
  const e = new Error(`la respuesta se cortó en el tope de salida${Number.isFinite(maxTokens) ? ` (${maxTokens} tokens)` : ''}`);
  e.code = SALIDA_CORTADA;
  e.userMessage = 'La respuesta del modelo se cortó por larga y no se pudo leer. Intentá de nuevo en unos minutos.';
  return e;
}

/**
 * Le pone al error lo ya gastado (si no traía) y lo devuelve.
 * @template {unknown} E
 * @param {E} err
 * @param {import('./usage').TokenUsage | null} usage
 * @returns {E}
 */
function conGasto(err, usage) {
  if (usage && err && typeof err === 'object' && !(/** @type {any} */ (err).tokenUsage)) {
    /** @type {any} */ (err).tokenUsage = usage;
  }
  return err;
}

module.exports = { SALIDA_CORTADA, salidaCortadaError, conGasto };
