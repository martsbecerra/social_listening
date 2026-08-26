// ==========================================================================
// llm/index.js — Punto único de acceso al LLM según LLM_PROVIDER.
// --------------------------------------------------------------------------
// Todo el código de la app pasa por acá: nadie más debería importar un
// proveedor concreto ni el SDK de Anthropic. Dos entradas, una por tarea:
//   - requestStructuredAnalysis: análisis de comentarios (JSON con schema)
//   - requestText:               clasificación del monitoreo (texto plano)
// ==========================================================================

const { getLlmProvider, getAnalysisModel } = require('./providerConfig');
const anthropic = require('./anthropicProvider');
const openrouter = require('./openrouterProvider');
const { finalizeLlmUsage } = require('./estimateCost');

/** @returns {typeof anthropic} */
function providerModule(provider) {
  return provider === 'openrouter' ? openrouter : anthropic;
}

async function requestStructuredAnalysis({ system, userPrompt, schema, schemaName }) {
  const provider = getLlmProvider();
  const result = await providerModule(provider).requestStructuredAnalysis({
    system,
    userPrompt,
    schema,
    schemaName,
  });
  result.usage = finalizeLlmUsage(result.usage, {
    provider,
    model: getAnalysisModel(provider),
  });
  return result;
}

/**
 * Texto plano con el modelo clasificador del proveedor activo.
 * Propaga los errores de API (err.isApiFailure) — no los traga: el
 * clasificador necesita distinguir "se cayó la API" de "el modelo respondió
 * algo raro", porque son dos decisiones distintas (ver src/classifier.js).
 * @returns {Promise<{ text: string, usage: import('./usage').TokenUsage | null }>}
 */
async function requestText({ system, userPrompt, maxTokens }) {
  const provider = getLlmProvider();
  return providerModule(provider).requestText({ system, userPrompt, maxTokens });
}

module.exports = { requestStructuredAnalysis, requestText };
