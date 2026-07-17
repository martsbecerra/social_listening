// ==========================================================================
// validateAnalysis.js
// --------------------------------------------------------------------------
// Normaliza el JSON que devuelve Claude (structured output) antes de armar
// el reporte. La API ya valida el schema, pero acá corregimos enums raros,
// filas de CSV incompletas y comentarios que el modelo omitió por index.
// ==========================================================================

const { SENTIMENTS, ACCOUNT_TYPES } = require('./analysisSchema');

const SENTIMENT_SET = new Set(SENTIMENTS);
const ACCOUNT_SET = new Set(ACCOUNT_TYPES);

/** Si el valor no está en el enum acordado, usamos fallback (no rompe el agregado). */
function pickEnum(value, allowed, fallback) {
  if (typeof value === 'string' && allowed.has(value)) return value;
  return fallback;
}

/** Descarta entradas sin dirección detectada; completa campos vacíos con N/D. */
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
      tematica: typeof r.tematica === 'string' && r.tematica.trim() ? r.tematica.trim() : 'N/D',
    });
  }
  return out;
}

/**
 * Pasa de lista con index a array paralelo a sample[0..n-1].
 * Índices faltantes → neutral (excluido del % en sentimentAggregate.js).
 */
function normalizeClassifications(rawList, sampleLength) {
  const byIndex = new Map();
  if (Array.isArray(rawList)) {
    for (const row of rawList) {
      if (!row || typeof row.index !== 'number' || row.index < 1) continue;
      byIndex.set(row.index, {
        sentiment: pickEnum(row.sentiment, SENTIMENT_SET, 'neutral'),
        accountType: pickEnum(row.accountType, ACCOUNT_SET, 'vecino'),
        reclamosGeo: sanitizeReclamosGeo(row.reclamosGeo),
      });
    }
  }

  const out = [];
  for (let i = 1; i <= sampleLength; i++) {
    out.push(
      byIndex.get(i) || {
        sentiment: 'neutral',
        accountType: 'vecino',
        reclamosGeo: [],
      }
    );
  }
  return out;
}

/** El template exige 2 líneas por insight; rellenamos con N/D si hace falta. */
function normalizeInsightPair(raw) {
  const lines = Array.isArray(raw) ? raw.map((s) => (s == null ? '' : String(s).trim())).filter(Boolean) : [];
  while (lines.length < 2) lines.push('N/D');
  return lines.slice(0, 2);
}

/**
 * Punto de entrada tras message.parsed_output.
 *
 * @param {unknown} parsed Salida de message.parsed_output
 * @param {number} sampleLength Cantidad de comentarios en la muestra
 * @returns {{ qualitative: object, classifications: Array }}
 */
function validateAndNormalizeAnalysis(parsed, sampleLength) {
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('Structured output vacío o inválido.');
    e.userMessage =
      'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
    throw e;
  }

  const p = /** @type {Record<string, unknown>} */ (parsed);

  const qualitative = {
    posteoSobre: typeof p.posteoSobre === 'string' ? p.posteoSobre.trim() : 'N/D',
    insightApoyo: normalizeInsightPair(p.insightApoyo),
    insightCriticas: normalizeInsightPair(p.insightCriticas),
    insightReclamos: normalizeInsightPair(p.insightReclamos),
    insightMedios: normalizeInsightPair(p.insightMedios),
    posturaAudiencia:
      typeof p.posturaAudiencia === 'string' ? p.posturaAudiencia.trim() : 'N/D',
    lecturaEstrategica:
      typeof p.lecturaEstrategica === 'string' ? p.lecturaEstrategica.trim() : 'N/D',
  };

  const classifications = normalizeClassifications(p.classifications, sampleLength);

  return { qualitative, classifications };
}

module.exports = { validateAndNormalizeAnalysis, normalizeClassifications };
