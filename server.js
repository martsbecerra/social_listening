// ==========================================================================
// server.js
// --------------------------------------------------------------------------
// Punto de entrada de la aplicación. Levanta un servidor web con Express que:
//   1) Sirve la página web (public/index.html).
//   2) Expone un endpoint /api/analyze que recibe el link de Instagram,
//      llama a Apify (extraer datos) y a Claude (analizarlos), y devuelve
//      el reporte.
// ==========================================================================

// dotenv carga las variables del archivo .env a process.env (APIFY_API_TOKEN, etc.)
require('dotenv').config();

const express = require('express');
const path = require('path');

const { scrapeInstagram } = require('./src/apify');
const { analyzeComments } = require('./src/analyzeComments');
const { resolveMaxCommentsLimit } = require('./src/commentSample');
const { getLlmProvider, requiredLlmEnvKeys, getProviderLabel } = require('./src/llm/providerConfig');

const app = express();

/** Log de alto nivel por tarea del pipeline (no por comentario). */
function logTask(phase, detail = {}) {
  const payload = Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[analyze] ${phase}${payload}`);
}

// Permite leer el cuerpo (body) de las peticiones en formato JSON.
app.use(express.json());

// Sirve los archivos estáticos (la web) desde la carpeta "public".
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Chequeo inicial: avisamos si faltan las claves para que no falle "en silencio".
// --------------------------------------------------------------------------
function checkEnv() {
  const faltantes = [];
  if (!process.env.APIFY_API_TOKEN) faltantes.push('APIFY_API_TOKEN');
  for (const key of requiredLlmEnvKeys()) {
    if (!process.env[key]) faltantes.push(key);
  }
  if (faltantes.length > 0) {
    console.warn(
      `\n⚠️  ATENCIÓN: faltan estas variables en el archivo .env: ${faltantes.join(', ')}` +
      `\n    Copiá ".env.example" como ".env" y completá tus claves.\n`
    );
  }
}

// --------------------------------------------------------------------------
// Valida que el link sea de una publicación de Instagram (post, reel o tv).
// --------------------------------------------------------------------------
function isValidInstagramPostUrl(url) {
  try {
    const u = new URL(url);
    const esInstagram = /(^|\.)instagram\.com$/.test(u.hostname);
    const esPublicacion = /^\/(p|reel|reels|tv)\/[\w-]+/.test(u.pathname);
    return esInstagram && esPublicacion;
  } catch {
    // Si new URL() falla, el texto no es una URL válida.
    return false;
  }
}

// --------------------------------------------------------------------------
// Endpoint principal: recibe el link y devuelve el reporte.
// --------------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body || {};
  const startedAt = Date.now();

  // 1) Validación del link.
  if (!isValidInstagramPostUrl(url)) {
    logTask('validación fallida', { url: url || null });
    return res.status(400).json({
      error: 'Ingresá un link válido de una publicación de Instagram (por ejemplo: https://www.instagram.com/p/XXXXXXXX/).',
    });
  }

  logTask('inicio', { url });

  try {
    // 2) Extraemos datos con Apify (comentarios + datos del posteo).
    logTask('extracción Apify iniciada');
    const scrapeStartedAt = Date.now();
    const { post, comments, scrapeMeta } = await scrapeInstagram(url);
    logTask('extracción Apify completada', {
      ms: Date.now() - scrapeStartedAt,
      comentariosExtraidos: comments?.length ?? 0,
      commentsLimit: scrapeMeta?.commentsLimitRequested ?? null,
      apifyItemsCrudos: scrapeMeta?.rawCommentItems ?? null,
      comentariosEnPost: scrapeMeta?.commentsOnPost ?? null,
      cuenta: post?.ownerUsername ?? null,
    });

    // 3) Si no hay comentarios, no hay nada que analizar.
    if (!comments || comments.length === 0) {
      logTask('sin comentarios', { url, msTotal: Date.now() - startedAt });
      return res.status(422).json({
        error: 'La publicación no tiene comentarios visibles o no se pudieron extraer. Probá con otra publicación.',
      });
    }

    // 4) Analizamos con el LLM configurado (devuelve reporte + CSV de reclamos).
    logTask('análisis LLM iniciado', {
      proveedor: getLlmProvider(),
      comentariosExtraidos: comments.length,
    });
    const analysisStartedAt = Date.now();
    const { report, csv, meta: analysisMeta } = await analyzeComments({ url, post, comments });
    logTask('análisis LLM completado', {
      ms: Date.now() - analysisStartedAt,
      comentariosAnalizados: analysisMeta?.sampleSize ?? comments.length,
      muestraParcial: Boolean(
        analysisMeta?.sampleSize != null &&
        analysisMeta?.totalComments != null &&
        analysisMeta.sampleSize < analysisMeta.totalComments
      ),
      tokens: analysisMeta?.tokenUsage ?? null,
      llmIntentos: analysisMeta?.llmAttempts ?? null,
    });

    logTask('respuesta OK', { msTotal: Date.now() - startedAt });

    // 5) Devolvemos el reporte y el CSV al navegador.
    return res.json({
      report,
      csv,
      meta: {
        // Extraídos por Apify vs enviados a Claude (muestra estable en commentSample.js).
        comentariosExtraidos: comments.length,
        comentariosAnalizados: analysisMeta?.sampleSize ?? comments.length,
        comentariosUnicos: analysisMeta?.totalComments ?? comments.length,
        muestraParcial: Boolean(analysisMeta?.sampleSize < analysisMeta?.totalComments),
        tokenUsage: analysisMeta?.tokenUsage ?? null,
        llmAttempts: analysisMeta?.llmAttempts ?? null,
      },
    });
  } catch (err) {
    logTask('error', {
      msTotal: Date.now() - startedAt,
      message: err.message,
      fase: err.userMessage ? 'servicio externo' : 'interno',
    });
    console.error('Error en /api/analyze:', err);
    // Si alguno de nuestros servicios agregó un "userMessage" amigable, lo usamos.
    return res.status(502).json({
      error: err.userMessage || 'Ocurrió un error al procesar la publicación. Intentá de nuevo en unos minutos.',
    });
  }
});

// --------------------------------------------------------------------------
// Arrancamos el servidor.
// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
checkEnv();
app.listen(PORT, () => {
  const provider = getLlmProvider();
  console.log(`\n✅ Servidor listo en http://localhost:${PORT}`);
  console.log(`   Proveedor LLM: ${getProviderLabel(provider)} (${provider})`);
  console.log(
    `   Límites: COMMENTS_LIMIT (Apify)=${process.env.COMMENTS_LIMIT || 100}, COMMENTS_ANALYSIS_LIMIT (LLM)=${resolveMaxCommentsLimit()}\n`
  );
});
