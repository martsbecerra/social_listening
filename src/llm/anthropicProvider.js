// ==========================================================================
// anthropicProvider.js — Structured Outputs vía API de Anthropic.
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');
const { ANALYSIS_JSON_SCHEMA } = require('../analysisSchema');

const client = new Anthropic();
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

async function requestStructuredAnalysis({ system, userPrompt }) {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

  const requestParams = {
    model,
    max_tokens: 8000,
    system,
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
  } else if (err.userMessage) {
    e.userMessage = err.userMessage;
  } else {
    e.userMessage = 'El servicio de análisis (Claude) falló. Intentá de nuevo en unos minutos.';
  }
  return e;
}

module.exports = { requestStructuredAnalysis };
