// ==========================================================================
// sample.js — Muestra estable del hilo X hacia el LLM.
// Prioriza RTs y handles del padrón; tope = COMMENTS_ANALYSIS_LIMIT.
// ==========================================================================

const { resolveMaxCommentsLimit } = require('../commentSample');
const { normalizeHandle } = require('./influencersParse');

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.id || `${normalizeHandle(item.username)}\n${item.text || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function compareItems(a, b, influencerMap) {
  const aPadron = influencerMap?.has(normalizeHandle(a.username)) ? 1 : 0;
  const bPadron = influencerMap?.has(normalizeHandle(b.username)) ? 1 : 0;
  if (bPadron !== aPadron) return bPadron - aPadron;

  const rtA = Number(a.retweets) || 0;
  const rtB = Number(b.retweets) || 0;
  if (rtB !== rtA) return rtB - rtA;

  const likesA = Number(a.likes) || 0;
  const likesB = Number(b.likes) || 0;
  if (likesB !== likesA) return likesB - likesA;

  return (a.username || '').localeCompare(b.username || '', 'es');
}

/**
 * El post original siempre va primero (index 1). El resto se recorta.
 */
function prepareXSample({ post, items }, influencerMap, max = resolveMaxCommentsLimit()) {
  const original = { ...post, kind: 'original' };
  const rest = dedupeItems((items || []).filter((item) => item && item.kind !== 'original'));
  const sorted = [...rest].sort((a, b) => compareItems(a, b, influencerMap));
  const capped = sorted.slice(0, Math.max(0, max - 1));
  const sample = [original, ...capped];
  const total = 1 + rest.length;
  return {
    sample,
    total,
    isPartial: total > sample.length,
    maxUsed: max,
  };
}

const PARTIAL_SAMPLE_DISCLOSURE =
  'Análisis realizado sobre muestra parcial del hilo (priorizados RTs y cuentas del padrón ANTIK-PRO).';

module.exports = { prepareXSample, dedupeItems, compareItems, PARTIAL_SAMPLE_DISCLOSURE };
