// ==========================================================================
// validateAnalysis.js
// --------------------------------------------------------------------------
// Normaliza el JSON que devuelve el modelo (structured output) en el
// análisis de publicación de Instagram, antes de armar el reporte. La API ya
// valida el schema, pero acá corregimos enums raros, filas de CSV
// incompletas, índices que no existen y temas con números de comentarios que
// no están en la muestra.
//
// Un comentario que el modelo NO devolvió queda sin clasificar (null), no
// como neutral: "analizados" es la cantidad de clasificados de verdad
// (src/analyzeComments.js), y un relleno contaba de más.
// ==========================================================================

const { SENTIMENTS, ACCOUNT_TYPES, TIPOS_UBICACION } = require('./analysisSchema');
const { applyClassificationHeuristics } = require('./classificationHeuristics');
const { normalizeTematica } = require('./tematica');
const { normalizeCategoria } = require('./categoriaReclamo');
const { MAX_TEMAS } = require('./temasConversacion');

const SENTIMENT_SET = new Set(SENTIMENTS);
const ACCOUNT_SET = new Set(ACCOUNT_TYPES);

/** Si el valor no está en el enum acordado, usamos fallback (no rompe el agregado). */
function pickEnum(value, allowed, fallback) {
  if (typeof value === 'string' && allowed.has(value)) return value;
  return fallback;
}

/** Descarta entradas sin dirección detectada; temática libre normalizada. */
function sanitizeReclamosGeo(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const direccionDetectada =
      typeof r.direccionDetectada === 'string' ? r.direccionDetectada.trim() : '';
    if (!direccionDetectada) continue;
    out.push({
      direccionDetectada,
      direccionNormalizada:
        typeof r.direccionNormalizada === 'string' && r.direccionNormalizada.trim()
          ? r.direccionNormalizada.trim()
          : 'N/D',
      tematica: normalizeTematica(r.tematica),
      categoria: normalizeCategoria(r.categoria),
      // De acá sale la `precision` con la que se guarda el reclamo
      // (reclamosFromAnalysis.js). Si el modelo manda un valor fuera del enum
      // se descarta y el reclamo queda como dirección puntual, que es el caso
      // mayoritario y el comportamiento anterior.
      tipoUbicacion: TIPOS_UBICACION.includes(r.tipoUbicacion) ? r.tipoUbicacion : null,
    });
  }
  return out;
}

/**
 * Las clasificaciones de UNA tanda, en un array paralelo a la tanda: el
 * ítem i es el comentario i+1 de la lista que se le mandó. Lo que el modelo
 * no devolvió (o devolvió con un índice que no existe) queda null.
 * @param {unknown} rawList parsed.classifications
 * @param {number} batchLength
 * @returns {Array<{ sentiment: string, accountType: string, reclamosGeo: Array } | null>}
 */
function normalizeBatchClassifications(rawList, batchLength) {
  const out = new Array(batchLength).fill(null);
  if (!Array.isArray(rawList)) return out;
  for (const row of rawList) {
    if (!row || !Number.isInteger(row.index) || row.index < 1 || row.index > batchLength) continue;
    if (out[row.index - 1]) continue; // el primero gana
    out[row.index - 1] = {
      sentiment: pickEnum(row.sentiment, SENTIMENT_SET, 'neutral'),
      accountType: pickEnum(row.accountType, ACCOUNT_SET, 'vecino'),
      reclamosGeo: sanitizeReclamosGeo(row.reclamosGeo),
    };
  }
  return out;
}

/**
 * Las heurísticas de classificationHeuristics.js, solo sobre lo
 * clasificado: lo sin clasificar sigue null.
 */
function applyHeuristicsToClassified(sample, classifications) {
  return classifications.map((row, i) => (row ? applyClassificationHeuristics([sample[i]], [row])[0] : null));
}

/** El template exige 2 líneas por insight; rellenamos con N/D si hace falta. */
function normalizeInsightPair(raw) {
  const lines = Array.isArray(raw) ? raw.map((s) => (s == null ? '' : String(s).trim())).filter(Boolean) : [];
  while (lines.length < 2) lines.push('N/D');
  return lines.slice(0, 2);
}

/**
 * Los temas de la síntesis: título y texto, y los números de sus
 * comentarios que existen en la muestra (sin repetidos, en orden). Un tema
 * sin título o sin texto se descarta; a lo sumo MAX_TEMAS.
 */
function normalizeTemasConComentarios(raw, sampleLength, validos = null) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const titulo = typeof item.titulo === 'string' ? item.titulo.trim() : '';
    const texto = typeof item.texto === 'string' ? item.texto.trim() : '';
    if (!titulo || !texto) continue;
    const comentarios = Array.isArray(item.comentarios)
      ? [...new Set(item.comentarios.filter((n) => Number.isInteger(n) && n >= 1 && n <= sampleLength && (!validos || validos.has(n))))].sort((a, b) => a - b)
      : [];
    out.push({ titulo, texto, comentarios });
    if (out.length >= MAX_TEMAS) break;
  }
  return out;
}

/**
 * La síntesis (posteo sobre, insights, postura, lectura y temas).
 * @param {unknown} parsed
 * @param {number} sampleLength
 * @param {Set<number>|null} [validos] los números (desde 1) que un tema puede
 *   nombrar: los comentarios clasificados. Sin él, cualquiera de la muestra.
 */
function normalizeSynthesis(parsed, sampleLength, validos = null) {
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('Structured output de la síntesis vacío o inválido.');
    e.userMessage = 'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
    throw e;
  }
  const p = /** @type {Record<string, unknown>} */ (parsed);
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : 'N/D');
  return {
    posteoSobre: text(p.posteoSobre),
    insightApoyo: normalizeInsightPair(p.insightApoyo),
    insightCriticas: normalizeInsightPair(p.insightCriticas),
    insightReclamos: normalizeInsightPair(p.insightReclamos),
    insightMedios: normalizeInsightPair(p.insightMedios),
    posturaAudiencia: text(p.posturaAudiencia),
    lecturaEstrategica: text(p.lecturaEstrategica),
    temasConversacion: normalizeTemasConComentarios(p.temasConversacion, sampleLength, validos),
  };
}

module.exports = {
  normalizeBatchClassifications,
  applyHeuristicsToClassified,
  normalizeSynthesis,
  normalizeTemasConComentarios,
};
