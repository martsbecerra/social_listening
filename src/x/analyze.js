// ==========================================================================
// analyze.js — Orquesta fetch ya hecho: muestra → Grok → KPIs → reporte X.
// ==========================================================================

const db = require('../db');
const { CLASSIFICATION_SYSTEM_PROMPT } = require('./prompt');
const { ANALYSIS_JSON_SCHEMA } = require('./analysisSchema');
const { prepareXSample } = require('./sample');
const { validateAndNormalizeAnalysis } = require('./validate');
const { buildWhatsAppReport } = require('./reportBuilder');
const { buildUserPrompt } = require('./userPrompt');
const { requestStructuredAnalysis } = require('../llm');
const { getOpenRouterXModel } = require('./grokModel');
const { buildReclamosFromAnalysis } = require('./reclamosFromAnalysis');
const { applyInfluencerAccountTypes } = require('./influencers');

async function analyzeXThread({ url, post, items, influencerMap }) {
  const grokModel = getOpenRouterXModel();
  const { sample, total, isPartial } = prepareXSample({ post, items }, influencerMap);

  const userPrompt = buildUserPrompt({
    url,
    post,
    sample,
    total,
    isPartial,
    influencerMap,
  });

  let parsed;
  let tokenUsage = null;
  let llmAttempts = null;
  try {
    const llmResult = await requestStructuredAnalysis({
      system: CLASSIFICATION_SYSTEM_PROMPT,
      userPrompt,
      schema: ANALYSIS_JSON_SCHEMA,
      schemaName: 'analisis_x',
      provider: 'openrouter',
      model: grokModel,
      jsonFallback: true,
    });
    parsed = llmResult.parsed;
    tokenUsage = llmResult.usage ?? null;
    llmAttempts = llmResult.attempts ?? null;
  } catch (err) {
    if (err.userMessage) throw err;
    const e = new Error(`Grok falló: ${err.message}`);
    e.userMessage = 'El análisis de X (Grok vía OpenRouter) falló. Intentá de nuevo en unos minutos.';
    throw e;
  }

  let { qualitative, classifications } = validateAndNormalizeAnalysis(
    parsed,
    sample.length,
    sample
  );
  classifications = applyInfluencerAccountTypes(sample, classifications, influencerMap);

  for (const reclamo of buildReclamosFromAnalysis({ url, sample, classifications })) {
    db.upsertReclamo(reclamo);
  }

  const reportResult = buildWhatsAppReport({
    url,
    post,
    sample,
    isPartial,
    classifications,
    qualitative,
    influencerMap,
  });

  return {
    ...reportResult,
    meta: {
      ...reportResult.meta,
      sampleSize: sample.length,
      totalComments: total,
      llmProvider: 'openrouter',
      llmModel: grokModel,
      tokenUsage,
      llmAttempts,
    },
  };
}

module.exports = { analyzeXThread };
