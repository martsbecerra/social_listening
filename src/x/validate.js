// ==========================================================================
// validate.js — Normaliza el JSON de clasificación X.
// ==========================================================================

const { SENTIMENTS, ACCOUNT_TYPES } = require('./analysisSchema');
const { normalizeTematica } = require('../tematica');
const { normalizeCategoria } = require('../categoriaReclamo');

const SENTIMENT_SET = new Set(SENTIMENTS);
const ACCOUNT_SET = new Set(ACCOUNT_TYPES);
const EMPTY_INSIGHT = 'Sin registros en esta categoría';

function pickEnum(value, allowed, fallback) {
  if (typeof value === 'string' && allowed.has(value)) return value;
  return fallback;
}

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
      tematica: normalizeTematica(r.tematica),
      categoria: normalizeCategoria(r.categoria),
    });
  }
  return out;
}

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

function threadUrlSet(sample) {
  const set = new Set();
  for (const item of sample) {
    if (item?.url) set.add(String(item.url).trim());
    if (item?.id) {
      set.add(String(item.id));
      set.add(`https://x.com/i/web/status/${item.id}`);
    }
  }
  return set;
}

function refHasThreadUrl(ref, urls) {
  for (const url of urls) {
    if (url && ref.includes(url)) return true;
  }
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(ref);
}

function normalizeInsightRefs(raw, sample) {
  const urls = threadUrlSet(sample);
  const lines = Array.isArray(raw)
    ? raw.map((s) => (s == null ? '' : String(s).trim())).filter(Boolean)
    : [];
  const kept = [];
  for (const line of lines) {
    if (/^n\/?d$/i.test(line) || line === EMPTY_INSIGHT) continue;
    if (urls.size > 0 && !refHasThreadUrl(line, urls)) continue;
    kept.push(line);
    if (kept.length >= 2) break;
  }
  return kept;
}

function validateAndNormalizeAnalysis(parsed, sampleLength, sample = []) {
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('Structured output vacío o inválido.');
    e.userMessage =
      'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
    throw e;
  }
  const p = parsed;
  const qualitative = {
    posteoSobre: typeof p.posteoSobre === 'string' ? p.posteoSobre.trim() : 'N/D',
    insightApoyo: normalizeInsightRefs(p.insightApoyo, sample),
    insightCriticas: normalizeInsightRefs(p.insightCriticas, sample),
    insightReclamos: normalizeInsightRefs(p.insightReclamos, sample),
    insightMedios: normalizeInsightRefs(p.insightMedios, sample),
    insightOrganica: normalizeInsightRefs(p.insightOrganica, sample),
    insightEstetica: normalizeInsightRefs(p.insightEstetica, sample),
  };
  const classifications = normalizeClassifications(p.classifications, sampleLength);
  return { qualitative, classifications };
}

module.exports = {
  validateAndNormalizeAnalysis,
  normalizeInsightRefs,
  EMPTY_INSIGHT,
};
