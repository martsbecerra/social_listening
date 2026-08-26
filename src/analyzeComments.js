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
const { buildReclamosFromAnalysis } = require('./reclamosFromAnalysis');
const { asignarSubcategorias } = require('./clasificarReclamo');
const { addTokenUsage } = require('./llm/usage');
const db = require('./db');
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

  // Guarda los reclamos con ubicación en la tabla `reclamos` (geo_status
  // 'pendiente' — geoWorker.js los geocodifica después, no acá: es local a
  // SQLite, no pega a la red, así que no agrega latencia perceptible.
  //
  // Antes de guardar va el paso 2 de la clasificación: la categoría ya vino en
  // el structured output de arriba, falta la subcategoría. Es UNA sola llamada
  // para todos los reclamos de este análisis (ver clasificarReclamo.js), y si
  // falla los deja con subcategoría vacía en vez de tirar el análisis entero.
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
        `[reclamos] ${reclamos.length} reclamo(s), ${conSub} con subcategoría asignada (${llamadas} llamada/s al LLM).`
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
