// ==========================================================================
// analysisCost.js — Lo que va a costar un análisis de publicación, antes de
// gastar: la confirmación que pide el trabajo (src/analysisJob.js) cuando
// Instagram informa más de ANALISIS_CONFIRMAR_DESDE (1.000) comentarios.
// --------------------------------------------------------------------------
// - Apify cobra cada ítem del actor de comentarios (un comentario o una
//   respuesta) a la tarifa del plan: la pasa quien llama
//   (apifyCost.usdForItems(1), 0,0023 en Starter).
// - El modelo, lo medido en la repetición autorizada del 24/10/2026 (150
//   comentarios en tres tandas de 50: US$ 0,305; la síntesis, US$ 0,048; las
//   subcategorías, US$ 0,004): ANALISIS_USD_POR_COMENTARIO (0,0021) por
//   comentario clasificado más ANALISIS_USD_FIJO (0,06).
// Es un estimado: lo real queda en la fila (usd_apify, usd_modelo). La
// publicación ya se trajo cuando se pregunta: no entra.
// Sin dependencias (no carga la base).
// ==========================================================================

const DEFAULTS = { usdPorComentario: 0.0021, usdFijo: 0.06, confirmarDesde: 1000 };

function numeroDelEnv(variable, fallback, { entero = false } = {}) {
  const raw = process.env[variable];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return entero ? Math.floor(n) : n;
}

/** Lo que cuesta el modelo, del .env o lo medido. */
function tarifasModelo() {
  return {
    usdPorComentario: numeroDelEnv('ANALISIS_USD_POR_COMENTARIO', DEFAULTS.usdPorComentario),
    usdFijo: numeroDelEnv('ANALISIS_USD_FIJO', DEFAULTS.usdFijo),
  };
}

/** Desde cuántos comentarios (según Instagram) se pide confirmación: ANALISIS_CONFIRMAR_DESDE, 1.000. */
function confirmarDesde() {
  return numeroDelEnv('ANALISIS_CONFIRMAR_DESDE', DEFAULTS.confirmarDesde, { entero: true });
}

/**
 * El costo de traer `items` ítems y clasificar `analizar` (por defecto,
 * los mismos).
 * @param {number} items
 * @param {{ usdPorItemApify: number, analizar?: number }} opts
 * @returns {{ items: number, apify: number, modelo: number, total: number }}
 */
function estimarAnalisis(items, { usdPorItemApify, analizar = items }) {
  const n = Math.max(0, Math.floor(Number(items) || 0));
  const m = Math.max(0, Math.floor(Number(analizar) || 0));
  const { usdPorComentario, usdFijo } = tarifasModelo();
  const apify = n * (Number(usdPorItemApify) || 0);
  const modelo = m > 0 ? m * usdPorComentario + usdFijo : 0;
  return { items: n, apify, modelo, total: apify + modelo };
}

/**
 * Las opciones de la confirmación para una publicación con `comentarios`
 * según Instagram: "todo" (hasta el tope de ítems; `completo` dice si
 * entran todos) y "parcial" (ANALISIS_CONFIRMAR_DESDE ítems), cada una con
 * su costo. El modelo clasifica hasta `topeAnalisis` (COMMENTS_ANALYSIS_LIMIT).
 * @param {number} comentarios post.commentsCount
 * @param {{ tope: number, topeAnalisis: number, usdPorItemApify: number }} opts
 * @returns {Array<{ alcance: 'todo'|'parcial', items: number, completo: boolean, apify: number, modelo: number, total: number }>}
 */
function opcionesDeConfirmacion(comentarios, { tope, topeAnalisis, usdPorItemApify }) {
  const n = Math.max(0, Math.floor(Number(comentarios) || 0));
  const todo = Math.min(n, tope);
  const opciones = [{ alcance: 'todo', completo: n <= tope, ...estimarAnalisis(todo, { usdPorItemApify, analizar: Math.min(todo, topeAnalisis) }) }];
  const parcial = Math.min(confirmarDesde(), tope);
  if (parcial > 0 && parcial < todo) {
    opciones.push({ alcance: 'parcial', completo: false, ...estimarAnalisis(parcial, { usdPorItemApify, analizar: Math.min(parcial, topeAnalisis) }) });
  }
  return opciones;
}

module.exports = { estimarAnalisis, opcionesDeConfirmacion, confirmarDesde, tarifasModelo, DEFAULTS };
