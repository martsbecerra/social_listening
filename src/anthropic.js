// ==========================================================================
// anthropic.js
// --------------------------------------------------------------------------
// Orquesta la llamada a Claude:
//   1) Muestra ordenada de comentarios (commentSample.js)
//   2) Structured Outputs: JSON validado por la API (analysisSchema.js)
//   3) Normalización + heurísticas (validateAnalysis.js, classificationHeuristics.js)
//   4) Reporte y CSV en reportBuilder.js + sentimentAggregate.js
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');
const { CLASSIFICATION_SYSTEM_PROMPT } = require('./prompt');
const { ANALYSIS_JSON_SCHEMA } = require('./analysisSchema');
const { prepareCommentSample } = require('./commentSample');
const { validateAndNormalizeAnalysis } = require('./validateAnalysis');
const { buildWhatsAppReport } = require('./reportBuilder');

const client = new Anthropic();

// Si el parse falla (JSON roto), reintentamos una vez antes de fallar al usuario.
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

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

  let parsed;
  try {
    parsed = await requestStructuredAnalysis({ model, userPrompt });
  } catch (err) {
    if (err.userMessage) throw err;
    throw mapAnthropicError(err);
  }

  const { qualitative, classifications } = validateAndNormalizeAnalysis(
    parsed,
    sample.length,
    sample
  );

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

/**
 * messages.parse + output_config.format: la respuesta cae en parsed_output.
 */
async function requestStructuredAnalysis({ model, userPrompt }) {
  const requestParams = {
    model,
    max_tokens: 8000,
    system: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    output_config: {
      format: jsonSchemaOutputFormat(ANALYSIS_JSON_SCHEMA),
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= STRUCTURED_OUTPUT_MAX_ATTEMPTS; attempt++) {
    try {
      const message = await client.messages.parse(requestParams);
      // parsed_output lo rellena el SDK al parsear el bloque de texto JSON.
      if (message.parsed_output != null) {
        return message.parsed_output;
      }
      lastError = new Error('parsed_output es null');
    } catch (err) {
      lastError = err;
      console.warn(`Structured output intento ${attempt}/${STRUCTURED_OUTPUT_MAX_ATTEMPTS} falló:`, err.message);
    }
  }

  const e = new Error(`Structured output falló: ${lastError?.message || 'desconocido'}`);
  e.userMessage =
    'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
  throw e;
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

/** Datos del post + lista numerada de comentarios (debe coincidir con index del JSON). */
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

  return `Clasificá cada comentario siguiendo las REGLAS DE DESEMPATE del system prompt. Completá los campos del JSON de salida (posteoSobre, classifications, insights y textos 7–8). Respondé únicamente con JSON que cumpla el schema; no escribas el reporte de WhatsApp en texto libre.

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
