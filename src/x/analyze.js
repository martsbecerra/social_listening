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
const { asignarSubcategorias } = require('../clasificarReclamo');
const { addTokenUsage } = require('../llm/usage');

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

  const reclamos = buildReclamosFromAnalysis({ url, sample, classifications });
  if (reclamos.length > 0) {
    const { subcategorias, usage: subUsage, llamadas } = await asignarSubcategorias(
      reclamos.map((r) => ({
        categoria: r.categoria,
        texto: r.textoOriginal,
        direccionDetectada: r.direccionDetectada,
      }))
    );
    reclamos.forEach((r, i) => {
      r.subcategoria = subcategorias[i] || '';
    });
    if (subUsage) {
      tokenUsage = tokenUsage ? addTokenUsage(tokenUsage, subUsage) : subUsage;
    }
    if (llamadas > 0) {
      const conSub = subcategorias.filter(Boolean).length;
      console.log(
        `[x-reclamos] ${reclamos.length} reclamo(s), ${conSub} con subcategoría asignada (${llamadas} llamada/s al LLM).`
      );
    }
  }
  for (const reclamo of reclamos) {
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
