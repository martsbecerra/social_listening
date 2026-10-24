// ==========================================================================
// classificationHeuristics.js
// --------------------------------------------------------------------------
// Reglas determinísticas en Node que refuerzan el prompt (punto 4): casos
// tan claros que no dependen de la interpretación del modelo.
// ==========================================================================

/**
 * Comentario sin letras ni números (solo emojis, símbolos o vacío).
 */
function isEmojiOrSymbolOnly(text) {
  const t = (text || '').trim();
  if (!t) return true;
  return !/[\p{L}\p{N}]/u.test(t);
}

/** Solo menciones @usuario sin texto de opinión. */
function isMentionsOnly(text) {
  const t = (text || '').trim();
  if (!t) return true;
  const sinMenciones = t.replace(/@[\w.]+/g, '').trim();
  return sinMenciones.length === 0;
}

/** Patrones típicos de spam/sorteo (sin posición política clara). */
function looksLikeSpamOrSorteo(text) {
  const t = (text || '').toLowerCase();
  if (t.length < 3) return true;
  return (
    /\b(sorteo|ganá|ganar|participá|link en bio|dm me|seguí y|taggea|etiquetá a)\b/i.test(t) ||
    /\b(free|giveaway)\b/i.test(t)
  );
}

/**
 * Aplica overrides conservadores por comentario (misma longitud que sample).
 * Desde la fase F no hay tipo de cuenta: las reglas fijan tono, postura,
 * tema, pedido y reclamos; lo demás queda como lo dijo el modelo.
 *
 * @param {Array<{ text: string }>} sample
 * @param {Array<{ sentiment: string, postura: string, tema: number, pedido: boolean, reclamosGeo: Array }>} classifications
 */
function applyClassificationHeuristics(sample, classifications) {
  return classifications.map((row, i) => {
    const text = sample[i]?.text ?? '';

    // Primero casos sin opinión política (no pisan un reclamo geolocalizable del modelo).
    if (isEmojiOrSymbolOnly(text) || isMentionsOnly(text)) {
      return { ...row, sentiment: 'neutral', postura: 'neutra', pedido: false, reclamosGeo: [] };
    }

    if (looksLikeSpamOrSorteo(text)) {
      return { ...row, sentiment: 'ruido', postura: 'neutra', tema: 0, pedido: false, reclamosGeo: [] };
    }

    // El ruido no tiene postura, tema, pedido ni reclamos.
    if (row.sentiment === 'ruido') {
      return { ...row, postura: 'neutra', tema: 0, pedido: false, reclamosGeo: [] };
    }

    return row;
  });
}

module.exports = {
  applyClassificationHeuristics,
  isEmojiOrSymbolOnly,
  isMentionsOnly,
  looksLikeSpamOrSorteo,
};
