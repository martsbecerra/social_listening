// ==========================================================================
// userPrompt.js — Arma el mensaje de usuario para la fase de clasificación LLM.
// ==========================================================================

const { formatKnownAccountTypesPromptBlock } = require('./accountRegistry');

function buildUserPrompt({ url, post, sample, total, isPartial, registry }) {
  const commentsText = sample
    .map((c, i) => {
      const verified = c.isVerified ? ' [VERIFICADA]' : '';
      const likes = `${c.likesCount} likes`;
      const fecha = c.timestamp ? ` | ${c.timestamp}` : '';
      return `${i + 1}. @${c.username}${verified} (${likes}${fecha}): ${c.text}`;
    })
    .join('\n');

  const fmt = (n) => (n === null || n === undefined ? 'N/D' : n);

  const notaMuestra = isPartial
    ? `\nNOTA: Solo se listan ${sample.length} comentarios (de ${total} únicos tras deduplicar). La muestra prioriza cuentas verificadas y comentarios con más likes.\n`
    : '';

  const knownBlock = formatKnownAccountTypesPromptBlock(sample, registry);

  return `Clasificá cada comentario siguiendo las REGLAS DE DESEMPATE del system prompt. Completá posteoSobre, classifications (un ítem por cada comentario numerado), insights y textos 7–8. Respondé únicamente con JSON según el schema.

=== DATOS DEL POSTEO ===
Autor (nombre): ${fmt(post.ownerFullName)}
Usuario: @${fmt(post.ownerUsername)}
Link: ${url}
Likes del posteo: ${fmt(post.likesCount)}
Cantidad de comentarios (total del posteo): ${fmt(post.commentsCount)}
Reproducciones de video (si aplica): ${fmt(post.videoPlayCount)}
Texto / caption del posteo: ${post.caption ? post.caption : 'N/D'}
${notaMuestra}${knownBlock}
=== COMENTARIOS (${sample.length}) ===
${commentsText}

=== FIN DE LOS DATOS ===`;
}

module.exports = { buildUserPrompt };
