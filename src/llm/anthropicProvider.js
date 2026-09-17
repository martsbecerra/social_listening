// ==========================================================================
// anthropicProvider.js — API de Anthropic (SDK oficial).
// --------------------------------------------------------------------------
// Dos modos de uso, en espejo con openrouterProvider.js:
//   - requestStructuredAnalysis: Structured Outputs (análisis de post)
//   - requestText:               texto plano (clasificador del monitoreo)
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');
const { ANALYSIS_JSON_SCHEMA } = require('../analysisSchema');
const { addTokenUsage, fromAnthropicUsage } = require('./usage');
const { getAnalysisModel, getClassifierModel } = require('./providerConfig');

const client = new Anthropic();
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

async function requestStructuredAnalysis({ system, userPrompt, schema }) {
  const model = getAnalysisModel('anthropic');

  const requestParams = {
    model,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: userPrompt }],
    output_config: {
      format: jsonSchemaOutputFormat(schema || ANALYSIS_JSON_SCHEMA),
    },
  };

  let lastError;
  let usage = null;
  for (let attempt = 1; attempt <= STRUCTURED_OUTPUT_MAX_ATTEMPTS; attempt++) {
    try {
      const message = await client.messages.parse(requestParams);
      const callUsage = fromAnthropicUsage(message.usage);
      if (callUsage) usage = usage ? addTokenUsage(usage, callUsage) : callUsage;
      if (message.parsed_output != null) {
        return { parsed: message.parsed_output, usage, attempts: attempt };
      }
      lastError = new Error('parsed_output es null');
    } catch (err) {
      lastError = err;
      console.warn(
        `Anthropic structured output intento ${attempt}/${STRUCTURED_OUTPUT_MAX_ATTEMPTS} falló:`,
        err.message
      );
      if (attempt === STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
        throw mapAnthropicError(err);
      }
    }
  }

  const e = new Error(`Structured output falló: ${lastError?.message || 'desconocido'}`);
  e.userMessage =
    'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
  throw e;
}

/**
 * Texto plano, sin schema — lo que necesita el clasificador del monitoreo.
 * No reintenta ni traga errores: quien llama decide qué hacer (ver
 * src/classifier.js).
 * @returns {Promise<{ text: string, usage: import('./usage').TokenUsage | null }>}
 */
async function requestText({ system, userPrompt, maxTokens = 200 }) {
  const model = getClassifierModel('anthropic');

  let message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    throw mapAnthropicError(err);
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return { text, usage: fromAnthropicUsage(message.usage) };
}

function mapAnthropicError(err) {
  console.error('Error llamando a Claude:', err);
  const e = new Error(`Claude falló: ${err.message}`);
  e.isApiFailure = true;
  e.status = err.status;
  const mensajeApi = err.error?.error?.message || '';
  if (err.status === 401) {
    e.userMessage = 'La clave de Anthropic (ANTHROPIC_API_KEY) es inválida. Revisá Infisical.';
  } else if (err.status === 400 && /credit balance is too low/i.test(mensajeApi)) {
    e.userMessage =
      'Tu cuenta de Anthropic no tiene crédito suficiente. Cargá saldo en https://console.anthropic.com/settings/billing e intentá de nuevo.';
  } else if (err.status === 429) {
    e.userMessage = 'Se alcanzó el límite de uso de Claude por el momento. Esperá unos minutos e intentá de nuevo.';
  } else if (err.userMessage) {
    e.userMessage = err.userMessage;
  } else {
    e.userMessage = 'El servicio de análisis (Claude) falló. Intentá de nuevo en unos minutos.';
  }
  return e;
}

module.exports = { requestStructuredAnalysis, requestText };
