// ==========================================================================
// analyzeComments.js
// --------------------------------------------------------------------------
// Orquesta el análisis LLM (Anthropic u OpenRouter):
//   1) Muestra estable (commentSample.js)
//   2) Structured Outputs (analysisSchema.js)
//   3) Normalización + heurísticas + registro de cuentas
//   4) Reporte (reportBuilder.js + sentimentAggregate.js)
// ==========================================================================

const { CLASSIFICATION_SYSTEM_PROMPT } = require('./prompt');
const { prepareCommentSample } = require('./commentSample');
const { validateAndNormalizeAnalysis } = require('./validateAnalysis');
const { buildWhatsAppReport } = require('./reportBuilder');
const { buildUserPrompt } = require('./userPrompt');
const { requestStructuredAnalysis } = require('./llm');
const { getLlmProvider, getProviderLabel } = require('./llm/providerConfig');
const {
  loadAccountRegistry,
  saveAccountRegistry,
  countRegisteredInSample,
  applyRegistryAccountTypes,
  recordAccountTypesFromRun,
} = require('./accountRegistry');

/**
 * @param {{url: string, post: object, comments: Array}} params
 * @returns {Promise<{report: string, csv: string, meta: object}>}
 */
async function analyzeComments({ url, post, comments }) {
  const provider = getLlmProvider();
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
  let tokenUsage = null;
  let llmAttempts = null;
  try {
    const llmResult = await requestStructuredAnalysis({
      system: CLASSIFICATION_SYSTEM_PROMPT,
      userPrompt,
    });
    parsed = llmResult.parsed;
    tokenUsage = llmResult.usage ?? null;
    llmAttempts = llmResult.attempts ?? null;
  } catch (err) {
    if (err.userMessage) throw err;
    const label = getProviderLabel(provider);
    const e = new Error(`${label} falló: ${err.message}`);
    e.userMessage = `El servicio de análisis (${label}) falló. Intentá de nuevo en unos minutos.`;
    throw e;
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
      llmProvider: provider,
      tokenUsage,
      llmAttempts,
      accountRegistry: {
        ...registryStats,
        comentariosConTipoRegistrado: registeredCount,
        comentariosTipoInferidoPorLLM: sample.length - registeredCount,
      },
    },
  };
}

module.exports = { analyzeComments };
