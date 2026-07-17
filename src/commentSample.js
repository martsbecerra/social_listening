// ==========================================================================
// commentSample.js
// --------------------------------------------------------------------------
// Ordena y limita los comentarios antes de mandarlos a Claude.
// Apify no garantiza el mismo orden entre corridas; acá fijamos uno estable
// para que la misma extracción produzca el mismo prompt (y clasificaciones
// alineadas por número de ítem).
// ==========================================================================

// Mismo tope que antes: costo/latencia; si hay más, isPartial = true.
const MAX_COMMENTS_TO_SEND = 150;

/** Clave de orden: más recientes primero; empate por @usuario. */
function commentSortKey(c) {
  const ts = c.timestamp ? new Date(c.timestamp).getTime() : 0;
  const safeTs = Number.isFinite(ts) ? ts : 0;
  return { ts: safeTs, username: (c.username || '').toLowerCase() };
}

/**
 * @param {Array} comments Lista normalizada desde apify.js
 * @param {number} [max]
 * @returns {{ sample: Array, total: number, isPartial: boolean }}
 */
function prepareCommentSample(comments, max = MAX_COMMENTS_TO_SEND) {
  const total = comments.length;
  const sorted = [...comments].sort((a, b) => {
    const ka = commentSortKey(a);
    const kb = commentSortKey(b);
    if (kb.ts !== ka.ts) return kb.ts - ka.ts;
    return ka.username.localeCompare(kb.username, 'es');
  });
  const sample = sorted.slice(0, max);
  return {
    sample,
    total,
    isPartial: total > sample.length,
  };
}

module.exports = { prepareCommentSample, MAX_COMMENTS_TO_SEND };
