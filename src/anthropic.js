// ==========================================================================
// anthropic.js
// --------------------------------------------------------------------------
// Orquesta la llamada a Claude:
//   1) Muestra estable (commentSample.js)
//   2) Todos los comentarios al LLM; accountType fijo si hay registro (opción B)
//   3) Structured Outputs (analysisSchema.js)
//   4) Normalización + heurísticas + override de accountType (accountRegistry.js)
//   5) Reporte (reportBuilder.js + sentimentAggregate.js)
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');
const { CLASSIFICATION_SYSTEM_PROMPT } = require('./prompt');
const { ANALYSIS_JSON_SCHEMA } = require('./analysisSchema');
const { prepareCommentSample } = require('./commentSample');
const { validateAndNormalizeAnalysis } = require('./validateAnalysis');
const { buildWhatsAppReport } = require('./reportBuilder');
const {
  loadAccountRegistry,
  saveAccountRegistry,
  countRegisteredInSample,
  formatKnownAccountTypesPromptBlock,
  applyRegistryAccountTypes,
  recordAccountTypesFromRun,
} = require('./accountRegistry');

const client = new Anthropic();

const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

/**
 * @param {{url: string, post: object, comments: Array}} params
 * @returns {Promise<{report: string, csv: string, meta: object}>}
 */
async function analyzeComments({ url, post, comments }) {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const registry = await loadAccountRegistry();
  const { sample, total, isPartial } = prepareCommentSample(comments);
  const registeredCount = countRegisteredInSample(sample, registry);

  const userPrompt = buildUserPrompt({
    url,
    post,
    sample,
    total,
    isPartial,
    registry,
  });

  let parsed;
  try {
    parsed = await requestStructuredAnalysis({ model, userPrompt });
  } catch (err) {
    if (err.userMessage) throw err;
    throw mapAnthropicError(err);
  }

  let { qualitative, classifications } = validateAndNormalizeAnalysis(
    parsed,
    sample.length,
    sample
  );

  classifications = applyRegistryAccountTypes(sample, classifications, registry);

  const registryStats = recordAccountTypesFromRun(sample, classifications, registry);
  try {
    await saveAccountRegistry(registry);
  } catch (err) {
    console.warn('No se pudo guardar account-types.json:', err.message);
  }

  const reportResult = buildWhatsAppReport({
    url,
    post,
    sample,
    isPartial,
    sampleSize: sample.length,
    totalComments: total,
    classifications,
    qualitative,
  });

  return {
    ...reportResult,
    meta: {
      ...reportResult.meta,
      accountRegistry: {
        ...registryStats,
        comentariosConTipoRegistrado: registeredCount,
        comentariosTipoInferidoPorLLM: sample.length - registeredCount,
      },
    },
  };
}

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

/** Todos los comentarios de la muestra van al LLM (índices 1..n). */
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

module.exports = { analyzeComments };
