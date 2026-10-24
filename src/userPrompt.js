// ==========================================================================
// userPrompt.js — Los mensajes de usuario del análisis de publicación de
// Instagram (src/analyzeComments.js): uno por tanda de comentarios a
// clasificar y el de la síntesis, con todo lo clasificado.
// ==========================================================================

const { formatKnownAccountTypesPromptBlock } = require('./accountRegistry');

const fmt = (n) => (n === null || n === undefined ? 'N/D' : n);

function postBlock({ url, post }) {
  return `=== DATOS DEL POSTEO ===
Autor (nombre): ${fmt(post.ownerFullName)}
Usuario: @${fmt(post.ownerUsername)}
Link: ${url}
Likes del posteo: ${fmt(post.likesCount)}
Cantidad de comentarios (total del posteo): ${fmt(post.commentsCount)}
Reproducciones de video (si aplica): ${fmt(post.videoPlayCount)}
Texto / caption del posteo: ${post.caption ? post.caption : 'N/D'}`;
}

function commentHead(c) {
  const verified = c.isVerified ? ' [VERIFICADA]' : '';
  const likes = c.likesCount == null ? 'likes sin dato' : `${c.likesCount} likes`;
  const fecha = c.timestamp ? ` | ${c.timestamp}` : '';
  return { verified, datos: `${likes}${fecha}` };
}

/**
 * Una tanda: los comentarios numerados desde 1 (el index de la respuesta es
 * el de esta lista, no el de la muestra entera).
 * @param {{ url: string, post: object, batch: Array, numero: number, tandas: number, registry: object }} params
 */
function buildBatchPrompt({ url, post, batch, numero, tandas, registry }) {
  const commentsText = batch
    .map((c, i) => {
      const { verified, datos } = commentHead(c);
      return `${i + 1}. @${c.username}${verified} (${datos}): ${c.text}`;
    })
    .join('\n');
  const knownBlock = formatKnownAccountTypesPromptBlock(batch, registry);
  return `Clasificá cada comentario siguiendo las REGLAS DE DESEMPATE del system prompt: un ítem en classifications por cada comentario numerado (index 1-based, el número de esta lista). Respondé únicamente con JSON según el schema.

${postBlock({ url, post })}
${knownBlock}
=== COMENTARIOS (tanda ${numero} de ${tandas}: ${batch.length}) ===
${commentsText}

=== FIN DE LOS DATOS ===`;
}

const TONO = { positivo: 'positivo', negativo: 'negativo', neutral: 'neutral', ruido: 'ruido' };

/**
 * La síntesis: todos los comentarios de la muestra numerados desde 1, con
 * el tono y el tipo de cuenta que les dio su tanda ("sin clasificar" si la
 * tanda falló o el modelo no lo devolvió).
 * @param {{ url: string, post: object, sample: Array, classifications: Array<object|null>, analizados: number }} params
 */
function buildSynthesisPrompt({ url, post, sample, classifications, analizados }) {
  const commentsText = sample
    .map((c, i) => {
      const { verified, datos } = commentHead(c);
      const row = classifications[i];
      const tono = row ? `[${TONO[row.sentiment] || row.sentiment} · ${row.accountType}]` : '[sin clasificar]';
      return `${i + 1}. @${c.username}${verified} ${tono} (${datos}): ${c.text}`;
    })
    .join('\n');
  const total = post.commentsCount;
  const notaMuestra =
    Number.isFinite(total) && analizados < total
      ? `\nNOTA: Se analizaron ${analizados} de los ${total} comentarios del posteo.\n`
      : '';
  return `Con los comentarios ya clasificados de abajo, completá posteoSobre, los insights, posturaAudiencia, lecturaEstrategica y temasConversacion (cada tema con los números de sus comentarios). Respondé únicamente con JSON según el schema.

${postBlock({ url, post })}
${notaMuestra}
=== COMENTARIOS (${sample.length}) ===
${commentsText}

=== FIN DE LOS DATOS ===`;
}

module.exports = { buildBatchPrompt, buildSynthesisPrompt };
