// ==========================================================================
// analyze.js — Orquesta fetch ya hecho: muestra → LLM → KPIs → reporte X.
// ==========================================================================

const db = require('../db');
const { CLASSIFICATION_SYSTEM_PROMPT } = require('./prompt');
const { ANALYSIS_JSON_SCHEMA } = require('./analysisSchema');
const { prepareXSample } = require('./sample');
const { validateAndNormalizeAnalysis } = require('./validate');
const { buildWhatsAppReport } = require('./reportBuilder');
const { buildUserPrompt } = require('./userPrompt');
const { requestStructuredAnalysis } = require('../llm');
const { getLlmProvider, getProviderLabel } = require('../llm/providerConfig');
const { buildReclamosFromAnalysis } = require('./reclamosFromAnalysis');
const { applyInfluencerAccountTypes } = require('./influencers');

async function analyzeXThread({ url, post, items, influencerMap }) {
  const provider = getLlmProvider();
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
      llmProvider: provider,
      tokenUsage,
      llmAttempts,
    },
  };
}

module.exports = { analyzeXThread };
