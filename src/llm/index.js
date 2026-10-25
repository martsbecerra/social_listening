// ==========================================================================
// llm/index.js — Punto único de acceso al LLM según LLM_PROVIDER.
// --------------------------------------------------------------------------
// Todo el código de la app pasa por acá: nadie más debería importar un
// proveedor concreto ni el SDK de Anthropic. Dos entradas, UN solo modelo
// (ver providerConfig.js):
//   - requestStructuredAnalysis: JSON con schema — el análisis de
//     comentarios y la clasificación del monitoreo (src/classifier.js).
//     Instagram usa LLM_PROVIDER. X puede forzar provider/model (Grok).
//   - requestText:               texto plano — subcategoría de reclamos
//     (src/clasificarReclamo.js) e importador (src/importers/).
// ==========================================================================

const { getLlmProvider, getAnalysisModel } = require('./providerConfig');
const anthropic = require('./anthropicProvider');
const openrouter = require('./openrouterProvider');
const { finalizeLlmUsage } = require('./estimateCost');

/** @returns {typeof anthropic} */
function providerModule(provider) {
  return provider === 'openrouter' ? openrouter : anthropic;
}

async function requestStructuredAnalysis({
  system,
  userPrompt,
  schema,
  schemaName,
  provider: providerOverride,
  model: modelOverride,
  jsonFallback = false,
  maxTokens,
  timeoutMs,
}) {
  const provider = providerOverride || getLlmProvider();
  const ctx = { provider, model: modelOverride || getAnalysisModel(provider) };
  let result;
  try {
    result = await providerModule(provider).requestStructuredAnalysis({
      system,
      userPrompt,
      schema,
      schemaName,
      model: modelOverride,
      jsonFallback,
      maxTokens,
      timeoutMs,
    });
  } catch (err) {
    // Lo gastado en los intentos fallidos (ver ./errors.js), con su costo.
    if (err && typeof err === 'object' && err.tokenUsage) err.tokenUsage = finalizeLlmUsage(err.tokenUsage, ctx);
    throw err;
  }
  result.usage = finalizeLlmUsage(result.usage, ctx);
  return result;
}

/**
 * Texto plano con el modelo del proveedor activo (el mismo que el análisis).
 * Propaga los errores de API (err.isApiFailure) — no los traga: quien llama
 * necesita distinguir "se cayó la API" de "el modelo respondió algo raro",
 * porque son dos decisiones distintas.
 * @returns {Promise<{ text: string, usage: import('./usage').TokenUsage | null }>}
 */
async function requestText({ system, userPrompt, maxTokens, timeoutMs }) {
  const provider = getLlmProvider();
  const result = await providerModule(provider).requestText({ system, userPrompt, maxTokens, timeoutMs });
  // Con el costo estimado, como requestStructuredAnalysis: si no, la
  // subcategoría de los reclamos sumaba tokens al análisis sin su costo.
  if (result) result.usage = finalizeLlmUsage(result.usage, { provider, model: getAnalysisModel(provider) });
  return result;
}

module.exports = { requestStructuredAnalysis, requestText };
