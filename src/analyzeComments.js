// ==========================================================================
// analyzeComments.js
// --------------------------------------------------------------------------
// El análisis de publicación de Instagram con el modelo (Anthropic u
// OpenRouter), en dos partes:
//   1) Muestra estable (commentSample.js): sin repetidos, en orden fijo,
//      hasta COMMENTS_ANALYSIS_LIMIT (300 por defecto).
//   2) Clasificación en TANDAS de BATCH_SIZE (100) comentarios por llamada,
//      hasta BATCH_CONCURRENCY a la vez: tono, tipo de cuenta y reclamos con
//      ubicación (TANDA_JSON_SCHEMA). Una tanda que falla deja sus
//      comentarios sin clasificar (null) y el análisis sigue; si fallan
//      todas, tira. Antes era una sola llamada con todo, y 300 comentarios
//      chocaban con el tope de salida del modelo.
//   3) Síntesis: con todo lo clasificado, los textos del informe y hasta 8
//      temas con los números de sus comentarios (SINTESIS_JSON_SCHEMA).
//   4) Registro de cuentas, reclamos (subcategoría y guardado, conservando
//      la gestión de los que ya existían) y el reporte (reportBuilder.js).
// "Analizados" son los clasificados de verdad: lo que el modelo no devolvió
// no cuenta (validateAnalysis.js ya no lo completa como neutral).
//
// El LLM y la subcategoría se llaman por el objeto del módulo (llm.,
// clasificarReclamo.) para que los tests los puedan reemplazar.
// ==========================================================================

const { TANDA_SYSTEM_PROMPT, SINTESIS_SYSTEM_PROMPT } = require('./prompt');
const { TANDA_JSON_SCHEMA, SINTESIS_JSON_SCHEMA } = require('./analysisSchema');
const { prepareCommentSample } = require('./commentSample');
const { normalizeBatchClassifications, applyHeuristicsToClassified, normalizeSynthesis } = require('./validateAnalysis');
const { buildWhatsAppReport } = require('./reportBuilder');
const { countTones } = require('./sentimentAggregate');
const { buildBatchPrompt, buildSynthesisPrompt } = require('./userPrompt');
const llm = require('./llm');
const { getLlmProvider, getProviderLabel } = require('./llm/providerConfig');
const { buildReclamosFromAnalysis } = require('./reclamosFromAnalysis');
const clasificarReclamo = require('./clasificarReclamo');
const { addTokenUsage } = require('./llm/usage');
const db = require('./db');
const {
  loadAccountRegistry,
  saveAccountRegistry,
  applyRegistryAccountTypes,
  recordAccountTypesFromRun,
} = require('./accountRegistry');

const BATCH_SIZE = 100;
const BATCH_CONCURRENCY = 3;
const BATCH_MAX_TOKENS = 8000;
const SYNTHESIS_MAX_TOKENS = 6000;
const INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

const NO_PASOS = { start() {}, update() {}, done() {}, skip() {} };

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Corre las tareas de a `limit` a la vez, en orden de lista. */
async function runPool(tasks, limit) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function llmError(err, provider) {
  if (err && err.userMessage) return err;
  const label = getProviderLabel(provider);
  const e = new Error(`${label} falló: ${err && err.message}`);
  e.userMessage = `El servicio de análisis (${label}) falló. Intentá de nuevo en unos minutos.`;
  return e;
}

/**
 * @param {{ url: string, post: object, comments: Array, pasos?: { start: Function, update: Function, done: Function, skip: Function } }} params
 *   pasos: los avisos del progreso (src/analysisProgress.js) para los pasos
 *   'tono', 'temas' y 'reclamos'; opcional.
 * @returns {Promise<object>} el reporte (report, csv, temas, reportParts),
 *   lo que guarda la fila del análisis (qualitative, sample,
 *   classifications, tonos, numeros, metricas, reclamos) y tokenUsage.
 */
async function analyzeComments({ url, post, comments, pasos = NO_PASOS }) {
  const provider = getLlmProvider();
  const registry = await loadAccountRegistry();
  const { sample, total: unicos, isPartial: recortadaPorLaApp } = prepareCommentSample(comments);
  let tokenUsage = null;
  const sumUsage = (usage) => {
    if (usage) tokenUsage = tokenUsage ? addTokenUsage(tokenUsage, usage) : usage;
  };

  // ---- 1) tandas
  const tandas = chunk(sample, BATCH_SIZE);
  const porTanda = new Array(tandas.length);
  let hechos = 0;
  let fallidas = 0;
  const tonoDesde = Date.now();
  pasos.start('tono', `0 de ${INT.format(sample.length)}`);
  await runPool(
    tandas.map((tanda, t) => async () => {
      try {
        const result = await llm.requestStructuredAnalysis({
          system: TANDA_SYSTEM_PROMPT,
          userPrompt: buildBatchPrompt({ url, post, batch: tanda, numero: t + 1, tandas: tandas.length, registry }),
          schema: TANDA_JSON_SCHEMA,
          schemaName: 'tanda_instagram',
          maxTokens: BATCH_MAX_TOKENS,
        });
        porTanda[t] = normalizeBatchClassifications(result.parsed && result.parsed.classifications, tanda.length);
        sumUsage(result.usage);
      } catch (err) {
        porTanda[t] = new Array(tanda.length).fill(null);
        fallidas += 1;
        console.warn(`[analisis] la tanda ${t + 1} de ${tandas.length} falló (${tanda.length} comentarios sin clasificar): ${err && err.message}`);
      }
      hechos += tanda.length;
      pasos.update('tono', `${INT.format(hechos)} de ${INT.format(sample.length)}`);
    }),
    BATCH_CONCURRENCY
  );
  let classifications = porTanda.flat();
  classifications = applyHeuristicsToClassified(sample, classifications);
  classifications = classifications.map((row, i) => (row ? applyRegistryAccountTypes([sample[i]], [row], registry)[0] : null));
  const analizados = classifications.filter(Boolean).length;
  if (analizados === 0) {
    pasos.done('tono', 'no se pudo clasificar');
    throw llmError(new Error('ninguna tanda devolvió clasificaciones'), provider);
  }
  const segundos = Math.round((Date.now() - tonoDesde) / 1000);
  pasos.done(
    'tono',
    `${INT.format(analizados)} clasificados · ${segundos} s${fallidas ? ` · ${fallidas === 1 ? 'una tanda falló' : `${fallidas} tandas fallaron`}` : ''}`
  );

  // ---- 2) síntesis
  const temasDesde = Date.now();
  pasos.start('temas');
  let qualitative;
  try {
    const result = await llm.requestStructuredAnalysis({
      system: SINTESIS_SYSTEM_PROMPT,
      userPrompt: buildSynthesisPrompt({ url, post, sample, classifications, analizados }),
      schema: SINTESIS_JSON_SCHEMA,
      schemaName: 'sintesis_instagram',
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });
    qualitative = normalizeSynthesis(result.parsed, sample.length);
    sumUsage(result.usage);
  } catch (err) {
    pasos.done('temas', 'falló');
    throw llmError(err, provider);
  }
  const nTemas = qualitative.temasConversacion.length;
  pasos.done('temas', `${nTemas === 1 ? '1 tema' : `${nTemas} temas`} · ${Math.round((Date.now() - temasDesde) / 1000)} s`);

  // ---- 3) registro de cuentas
  recordAccountTypesFromRun(sample, classifications, registry);
  try {
    await saveAccountRegistry(registry);
  } catch (err) {
    console.warn('No se pudo guardar account-types.json:', err.message);
  }

  // ---- 4) reclamos: la categoría ya vino en la tanda; la subcategoría es
  // una llamada aparte para todos (clasificarReclamo.js), que nunca tira.
  const reclamos = buildReclamosFromAnalysis({ url, sample, classifications });
  if (reclamos.length > 0) {
    pasos.start('reclamos', `${reclamos.length} con ubicación`);
    const { subcategorias, usage: subUsage, llamadas } = await clasificarReclamo.asignarSubcategorias(
      reclamos.map((r) => ({
        categoria: r.categoria,
        texto: r.textoOriginal,
        direccionDetectada: r.direccionDetectada,
      }))
    );
    reclamos.forEach((r, i) => {
      r.subcategoria = subcategorias[i] || '';
    });
    sumUsage(subUsage);
    if (llamadas > 0) {
      const conSub = subcategorias.filter(Boolean).length;
      console.log(`[reclamos] ${reclamos.length} reclamo(s), ${conSub} con subcategoría asignada (${llamadas} llamada/s al LLM).`);
    }
    // Re-analizar la misma publicación no le borra la gestión a sus
    // reclamos (estado, geocodificado): ver db.upsertReclamo.
    for (const reclamo of reclamos) db.upsertReclamo(reclamo, { conservarGestion: true });
    pasos.done('reclamos', reclamos.length === 1 ? '1 reclamo' : `${reclamos.length} reclamos`);
  } else {
    pasos.skip('reclamos', 'sin reclamos con ubicación');
  }

  // ---- 5) el reporte
  const totalPost = Number.isFinite(post.commentsCount) ? post.commentsCount : null;
  const isPartial = totalPost !== null ? analizados < totalPost : analizados < unicos;
  const reportResult = buildWhatsAppReport({
    url,
    post,
    sample,
    isPartial,
    sampleSize: analizados,
    totalComments: unicos,
    classifications,
    qualitative,
    analizados,
    totalPost: totalPost !== null ? totalPost : unicos,
    priorizada: recortadaPorLaApp,
  });

  return {
    ...reportResult,
    qualitative,
    sample,
    classifications,
    tonos: countTones(classifications),
    numeros: { traidos: comments.length, unicos, enviados: sample.length, analizados, tandas: tandas.length, fallidas },
    metricas: {
      positivoPct: reportResult.meta.positivoPct,
      negativoPct: reportResult.meta.negativoPct,
      nivel: reportResult.meta.performanceLevel,
    },
    reclamos: reclamos.length,
    tokenUsage,
  };
}

module.exports = { analyzeComments, BATCH_SIZE, BATCH_CONCURRENCY };
