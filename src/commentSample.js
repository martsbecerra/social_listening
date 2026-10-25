// ==========================================================================
// commentSample.js
// --------------------------------------------------------------------------
// Punto 5 — input estable hacia Claude.
// Apify no garantiza orden ni unicidad entre corridas; acá deduplicamos,
// ordenamos con criterios fijos y recortamos la muestra. Misma lista de
// comentarios → mismo prompt → clasificaciones alineadas por índice.
// ==========================================================================

// 3.000 por defecto (decisión del dueño, fase G; eran 300): comentarios y
// respuestas, como COMMENTS_LIMIT. El análisis de Instagram los clasifica
// en tandas de 50 (src/analyzeComments.js), así que no chocan con el tope
// de salida del modelo. X tiene su propio tope y su propia variable
// (src/x/sample.js).
const DEFAULT_MAX_COMMENTS_TO_SEND = 3000;
// Tope duro por costo/latencia aunque el .env pida más: el de Instagram, y
// el de X, que no cambió (manda todo el hilo en una sola llamada).
const HARD_CAP_INSTAGRAM = 5000;
const HARD_CAP_COMMENTS = 500;

/**
 * Límite de comentarios enviados al análisis (distinto de COMMENTS_LIMIT de Apify,
 * que controla cuántos trae el scraper). COMMENTS_ANALYSIS_LIMIT es el de
 * Instagram; X lee X_COMMENTS_ANALYSIS_LIMIT (subir uno no sube el otro: X
 * manda todo el hilo en una sola llamada).
 * @param {number} [defaultMax] el de Instagram si no se pasa (X manda el suyo).
 * @param {string} [variable] la variable del .env que lo pisa.
 */
function resolveMaxCommentsLimit(defaultMax = DEFAULT_MAX_COMMENTS_TO_SEND, variable = 'COMMENTS_ANALYSIS_LIMIT') {
  const raw = process.env[variable];
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(Math.floor(n), variable === 'COMMENTS_ANALYSIS_LIMIT' ? HARD_CAP_INSTAGRAM : HARD_CAP_COMMENTS);
  }
  return defaultMax;
}

/** Timestamp numérico seguro para comparar (null/inválido → 0). */
function timestampMs(c) {
  const ts = c.timestamp ? new Date(c.timestamp).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Orden determinístico para elegir la muestra cuando hay más comentarios que el tope:
 *   1) Cuentas verificadas primero (señal política relevante en la metodología).
 *   2) Más likes en el comentario.
 *   3) Más recientes.
 *   4) @usuario (locale es).
 *   5) id de Apify si existe.
 *   6) Texto del comentario (último desempate).
 */
function compareCommentsForSample(a, b) {
  if (a.isVerified !== b.isVerified) {
    return (b.isVerified ? 1 : 0) - (a.isVerified ? 1 : 0);
  }

  // Likes sin dato (null) cuentan como 0 para ordenar.
  const likesA = Number(a.likesCount) || 0;
  const likesB = Number(b.likesCount) || 0;
  if (likesB !== likesA) return likesB - likesA;

  const tb = timestampMs(b);
  const ta = timestampMs(a);
  if (tb !== ta) return tb - ta;

  const userCmp = (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase(), 'es');
  if (userCmp !== 0) return userCmp;

  const idA = a.apifyId != null ? String(a.apifyId) : '';
  const idB = b.apifyId != null ? String(b.apifyId) : '';
  if (idA && idB) {
    const idCmp = idA.localeCompare(idB);
    if (idCmp !== 0) return idCmp;
  }

  return (a.text || '').localeCompare(b.text || '', 'es');
}

/**
 * Elimina duplicados exactos (mismo @usuario + mismo texto) preservando el primero
 * en el orden original de Apify, para no contar dos veces la misma fila. Dos
 * respuestas iguales a comentarios distintos ("¡Gracias!" de la cuenta a dos
 * vecinos) no son la misma fila: el comentario al que responden entra en la clave.
 */
function dedupeComments(comments) {
  const seen = new Set();
  const out = [];
  for (const c of comments) {
    const key = `${(c.username || '').toLowerCase()}\n${c.text || ''}\n${c.esRespuesta ? `↳${c.parentApifyId ?? ''}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * @param {Array} comments Lista normalizada desde apify.js
 * @param {number} [max] Si no se pasa, usa COMMENTS_ANALYSIS_LIMIT o 300.
 * @returns {{ sample: Array, total: number, totalBeforeDedupe: number, isPartial: boolean, maxUsed: number }}
 */
function prepareCommentSample(comments, max = resolveMaxCommentsLimit()) {
  const totalBeforeDedupe = comments.length;
  const deduped = dedupeComments(comments);
  const total = deduped.length;

  const sorted = [...deduped].sort(compareCommentsForSample);
  const sample = sorted.slice(0, max);

  return {
    sample,
    total,
    totalBeforeDedupe,
    isPartial: total > sample.length,
    maxUsed: max,
  };
}

/**
 * Cada respuesta va detrás de su comentario, así la tanda lee la charla
 * seguida (las de un mismo comentario, de la más vieja a la más nueva, como
 * se leen en Instagram). Una respuesta cuyo comentario no está en la lista
 * queda en su lugar, y el resto no se mueve: sin respuestas, la lista queda
 * igual.
 * @param {Array} lista comentarios normalizados (apifyId, esRespuesta, parentApifyId)
 */
function ordenarConRespuestas(lista) {
  const padres = new Set(lista.filter((c) => !c.esRespuesta && c.apifyId != null).map((c) => String(c.apifyId)));
  const padreDe = (c) => (c.esRespuesta && c.parentApifyId != null && padres.has(String(c.parentApifyId)) ? String(c.parentApifyId) : null);
  const hijas = new Map();
  for (const c of lista) {
    const p = padreDe(c);
    if (p === null) continue;
    if (!hijas.has(p)) hijas.set(p, []);
    hijas.get(p).push(c);
  }
  if (hijas.size === 0) return lista;
  const out = [];
  for (const c of lista) {
    if (padreDe(c) !== null) continue;
    out.push(c);
    const suyas = !c.esRespuesta && c.apifyId != null ? hijas.get(String(c.apifyId)) : null;
    if (suyas) out.push(...[...suyas].sort((a, b) => timestampMs(a) - timestampMs(b) || compareCommentsForSample(a, b)));
  }
  return out;
}

/** Texto aclaratorio cuando la muestra es parcial (metodología + criterio de priorización). */
const PARTIAL_SAMPLE_DISCLOSURE =
  'Análisis realizado sobre muestra parcial provista (priorizadas cuentas verificadas y comentarios con más likes).';

module.exports = {
  prepareCommentSample,
  resolveMaxCommentsLimit,
  compareCommentsForSample,
  dedupeComments,
  ordenarConRespuestas,
  DEFAULT_MAX_COMMENTS_TO_SEND,
  PARTIAL_SAMPLE_DISCLOSURE,
};
