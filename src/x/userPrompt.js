// ==========================================================================
// userPrompt.js — Mensaje de usuario para clasificar un hilo de X.
// ==========================================================================

const { formatInfluencerPromptBlock } = require('./influencers');

function fmt(n) {
  return n == null ? 'N/D' : n;
}

function buildUserPrompt({ url, post, sample, total, isPartial, influencerMap }) {
  const itemsText = sample
    .map((item, i) => {
      const kind = item.kind === 'original' ? 'POST ORIGINAL' : item.kind === 'quote' ? 'QT' : 'REPLY';
      const stats = `${fmt(item.likes)} likes, ${fmt(item.retweets)} RTs, ${fmt(item.replies)} replies`;
      const link = item.url ? ` | ${item.url}` : '';
      return `${i + 1}. [${kind}] @${item.username || 'desconocido'} (${stats}${link}): ${item.text || ''}`;
    })
    .join('\n');

  const nota = isPartial
    ? `\nNOTA: Solo se listan ${sample.length} ítems (de ${total} en el hilo normalizado). La muestra prioriza RTs y el padrón ANTIK-PRO.\n`
    : '';

  const knownBlock = formatInfluencerPromptBlock(sample, influencerMap);

  return `Clasificá cada ítem numerado. Completá posteoSobre, classifications (un ítem por cada número) e insights 3–8. Respondé únicamente con JSON según el schema.

=== DATOS DEL POSTEO ===
Autor: ${fmt(post.authorName || post.displayName)} / @${fmt(post.authorHandle || post.username)}
Link: ${url}
Likes: ${fmt(post.likes)} | RTs: ${fmt(post.retweets)} | QTs: ${fmt(post.quotes)} | Respuestas: ${fmt(post.replies)} | Guardados: ${fmt(post.bookmarks)} | Vistas: ${fmt(post.views)}
Texto: ${post.text || 'N/D'}
${nota}${knownBlock}
=== HILO (${sample.length}) ===
${itemsText}

=== FIN DE LOS DATOS ===`;
}

module.exports = { buildUserPrompt };
