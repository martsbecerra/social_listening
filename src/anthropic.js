// ==========================================================================
// anthropic.js
// --------------------------------------------------------------------------
// Orquesta la llamada a Claude:
//   1) Muestra ordenada de comentarios (commentSample.js)
//   2) Clasificación + textos cualitativos vía tool use (analysisTool.js)
//   3) Reporte y CSV armados en Node (reportBuilder.js + sentimentAggregate.js)
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { CLASSIFICATION_SYSTEM_PROMPT } = require('./prompt');
const { ANALYSIS_TOOL, ANALYSIS_TOOL_NAME } = require('./analysisTool');
const { prepareCommentSample } = require('./commentSample');
const { buildWhatsAppReport } = require('./reportBuilder');

const client = new Anthropic();

/**
 * Punto de entrada usado por server.js.
 *
 * @param {{url: string, post: object, comments: Array}} params
 * @returns {Promise<{report: string, csv: string}>}
 */
async function analyzeComments({ url, post, comments }) {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const { sample, total, isPartial } = prepareCommentSample(comments);
  const userPrompt = buildUserPrompt({ url, post, sample, total, isPartial });

  let message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: 8000,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [ANALYSIS_TOOL],
      // Forzamos el tool para no recibir prosa suelta sin JSON.
      tool_choice: { type: 'tool', name: ANALYSIS_TOOL_NAME },
    });
  } catch (err) {
    throw mapAnthropicError(err);
  }

  const toolInput = extractToolInput(message);
  const classifications = normalizeClassifications(toolInput.classifications, sample.length);

  const qualitative = {
    posteoSobre: toolInput.posteoSobre,
    insightApoyo: toolInput.insightApoyo,
    insightCriticas: toolInput.insightCriticas,
    insightReclamos: toolInput.insightReclamos,
    insightMedios: toolInput.insightMedios,
    posturaAudiencia: toolInput.posturaAudiencia,
    lecturaEstrategica: toolInput.lecturaEstrategica,
  };

  return buildWhatsAppReport({
    url,
    post,
    sample,
    isPartial,
    sampleSize: sample.length,
    totalComments: total,
    classifications,
    qualitative,
  });
}

/** Busca el bloque tool_use con el payload estructurado de la respuesta. */
function extractToolInput(message) {
  const block = message.content.find(
    (b) => b.type === 'tool_use' && b.name === ANALYSIS_TOOL_NAME
  );
  if (!block || !block.input || typeof block.input !== 'object') {
    const e = new Error('Claude no devolvió la clasificación estructurada esperada.');
    e.userMessage =
      'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
    throw e;
  }
  return block.input;
}

/**
 * Claude devuelve classifications con index 1-based; acá alineamos a un array
 * paralelo a sample[0..n]. Si falta un índice, neutral (no suma al %).
 */
function normalizeClassifications(rawList, sampleLength) {
  const byIndex = new Map();
  if (Array.isArray(rawList)) {
    for (const row of rawList) {
      if (!row || typeof row.index !== 'number') continue;
      byIndex.set(row.index, {
        sentiment: row.sentiment || 'neutral',
        accountType: row.accountType || 'vecino',
        reclamosGeo: Array.isArray(row.reclamosGeo) ? row.reclamosGeo : [],
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

/** Mensajes amigables para el front (server.js lee err.userMessage). */
function mapAnthropicError(err) {
  console.error('Error llamando a Claude:', err);
  const e = new Error(`Claude falló: ${err.message}`);
  const mensajeApi = err.error?.error?.message || '';
  if (err.status === 401) {
    e.userMessage = 'La clave de Anthropic (ANTHROPIC_API_KEY) es inválida. Revisá el archivo .env.';
  } else if (err.status === 400 && /credit balance is too low/i.test(mensajeApi)) {
    e.userMessage =
      'Tu cuenta de Anthropic no tiene crédito suficiente. Cargá saldo en https://console.anthropic.com/settings/billing e intentá de nuevo.';
  } else if (err.status === 429) {
    e.userMessage = 'Se alcanzó el límite de uso de Claude por el momento. Esperá unos minutos e intentá de nuevo.';
  } else {
    e.userMessage = 'El servicio de análisis (Claude) falló. Intentá de nuevo en unos minutos.';
  }
  return e;
}

/** Datos del post + lista numerada de comentarios (debe coincidir con index del tool). */
function buildUserPrompt({ url, post, sample, total, isPartial }) {
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
    ? `\nNOTA: Solo se listan ${sample.length} comentarios (de ${total} extraídos). Clasificá únicamente los numerados abajo.\n`
    : '';

  return `Clasificá cada comentario y completá los textos cualitativos. Usá la herramienta entregar_analisis (no escribas el reporte en texto libre).

=== DATOS DEL POSTEO ===
Autor (nombre): ${fmt(post.ownerFullName)}
Usuario: @${fmt(post.ownerUsername)}
Link: ${url}
Likes del posteo: ${fmt(post.likesCount)}
Cantidad de comentarios (total del posteo): ${fmt(post.commentsCount)}
Reproducciones de video (si aplica): ${fmt(post.videoPlayCount)}
Texto / caption del posteo: ${post.caption ? post.caption : 'N/D'}
${notaMuestra}
=== COMENTARIOS (${sample.length}) ===
${commentsText}

=== FIN DE LOS DATOS ===`;
}

module.exports = { analyzeComments };
