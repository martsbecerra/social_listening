// ==========================================================================
// commentSample.js
// --------------------------------------------------------------------------
// Punto 5 — input estable hacia Claude.
// Apify no garantiza orden ni unicidad entre corridas; acá deduplicamos,
// ordenamos con criterios fijos y recortamos la muestra. Misma lista de
// comentarios → mismo prompt → clasificaciones alineadas por índice.
// ==========================================================================

const DEFAULT_MAX_COMMENTS_TO_SEND = 150;
// Tope duro por costo/latencia aunque Infisical pida más.
const HARD_CAP_COMMENTS = 500;

/**
 * Límite de comentarios enviados al análisis (distinto de COMMENTS_LIMIT de Apify,
 * que controla cuántos trae el scraper).
 */
function resolveMaxCommentsLimit() {
  const raw = process.env.COMMENTS_ANALYSIS_LIMIT;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(Math.floor(n), HARD_CAP_COMMENTS);
  }
  return DEFAULT_MAX_COMMENTS_TO_SEND;
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
 * en el orden original de Apify, para no contar dos veces la misma fila.
 */
function dedupeComments(comments) {
  const seen = new Set();
  const out = [];
  for (const c of comments) {
    const key = `${(c.username || '').toLowerCase()}\n${c.text || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * @param {Array} comments Lista normalizada desde apify.js
 * @param {number} [max] Si no se pasa, usa COMMENTS_ANALYSIS_LIMIT o 150.
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

/** Texto aclaratorio cuando la muestra es parcial (metodología + criterio de priorización). */
const PARTIAL_SAMPLE_DISCLOSURE =
  'Análisis realizado sobre muestra parcial provista (priorizadas cuentas verificadas y comentarios con más likes).';

module.exports = {
  prepareCommentSample,
  resolveMaxCommentsLimit,
  compareCommentsForSample,
  dedupeComments,
  DEFAULT_MAX_COMMENTS_TO_SEND,
  PARTIAL_SAMPLE_DISCLOSURE,
};
