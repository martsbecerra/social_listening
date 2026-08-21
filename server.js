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
const db = require('./src/db');
const monitor = require('./src/monitor');
const { startScheduler, runCycleAndNotify } = require('./src/scheduler');
const { collectTematicas } = require('./src/tematica');

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
      costUsd: analysisMeta?.tokenUsage?.costUsd ?? null,
      costSource: analysisMeta?.tokenUsage?.costSource ?? null,
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
// Monitoreo automático: config, tabla de posteos detectados, disparo manual.
// --------------------------------------------------------------------------
app.get('/api/monitoring/posts', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  // El límite subió de 100 a 5000: la tabla ahora pagina/filtra/ordena del
  // lado del cliente (Tabulator), así que el frontend pide todo de una vez.
  const pageSize = Math.min(5000, Math.max(1, Number(req.query.pageSize) || 20));
  const { posts, total } = db.listDetectedPosts({ page, pageSize });
  res.json({ posts, total, page, pageSize });
});

app.get('/api/monitoring/config', (req, res) => {
  res.json(monitor.loadConfig());
});

// Borra un registro puntual de la tabla (ej. algo que no sirve o quedó mal).
app.delete('/api/monitoring/posts/:id', (req, res) => {
  db.deletePost(req.params.id);
  res.json({ ok: true });
});

// Corrige a mano el sentimiento de un registro (por si Haiku se equivocó).
const VALID_SENTIMENTS = ['positivo', 'neutral', 'negativo'];
app.patch('/api/monitoring/posts/:id', (req, res) => {
  const { sentiment } = req.body || {};
  if (!VALID_SENTIMENTS.includes(sentiment)) {
    return res.status(400).json({ error: 'Sentimiento inválido.' });
  }
  db.updateSentiment(req.params.id, sentiment);
  res.json({ ok: true });
});

app.post('/api/monitoring/accounts', async (req, res) => {
  try {
    res.json(await monitor.addAccount(req.body && req.body.account));
  } catch (err) {
    res.status(400).json({ error: err.userMessage || err.message });
  }
});

app.delete('/api/monitoring/accounts/:account', (req, res) => {
  res.json(monitor.removeAccount(req.params.account));
});

app.post('/api/monitoring/keywords', async (req, res) => {
  try {
    res.json(await monitor.addKeyword(req.body && req.body.keyword));
  } catch (err) {
    res.status(400).json({ error: err.userMessage || err.message });
  }
});

app.delete('/api/monitoring/keywords/:keyword', (req, res) => {
  res.json(monitor.removeKeyword(req.params.keyword));
});

// Dispara un ciclo de monitoreo a mano, sin esperar los 4hs del cron
// (útil para probar o para una demo).
app.post('/api/monitoring/run-now', async (req, res) => {
  try {
    const result = await runCycleAndNotify();
    res.json(result);
  } catch (err) {
    console.error('Error en /api/monitoring/run-now:', err);
    res.status(502).json({ error: err.userMessage || 'Falló el ciclo de monitoreo. Revisá la consola del servidor.' });
  }
});

// Genera título + sentimiento para posteos guardados que todavía no lo
// tienen (posteos de antes de esta funcionalidad, o que fallaron al clasificar).
app.post('/api/monitoring/backfill-classification', async (req, res) => {
  try {
    const result = await monitor.backfillClassification();
    res.json(result);
  } catch (err) {
    console.error('Error en /api/monitoring/backfill-classification:', err);
    res.status(502).json({ error: err.userMessage || 'Falló la clasificación. Revisá la consola del servidor.' });
  }
});

app.get('/api/reclamos', (req, res) => {
  const reclamos = db.listReclamos().map((row) => ({
    id: row.id,
    username: row.username,
    commentText: row.commentText,
    postUrl: row.postUrl,
    tematica: row.tematica,
    direccionDetectada: row.direccionDetectada,
    direccionNormalizada: row.direccionNormalizada,
    lat: row.lat,
    lng: row.lng,
    postedAt: row.postedAt,
  }));
  const mapped = reclamos.filter(
    (row) => row.lat != null && row.lng != null && row.direccionNormalizada
  );
  res.json({ tematicas: collectTematicas(mapped), reclamos });
});

// --------------------------------------------------------------------------
// Arrancamos el servidor.
// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
checkEnv();
startScheduler();
const server = app.listen(PORT, () => {
  const provider = getLlmProvider();
  console.log(`\n✅ Servidor listo en http://localhost:${PORT}`);
  console.log(`   Proveedor LLM: ${getProviderLabel(provider)} (${provider})`);
  console.log(
    `   Límites: COMMENTS_LIMIT (Apify)=${process.env.COMMENTS_LIMIT || 100}, COMMENTS_ANALYSIS_LIMIT (LLM)=${resolveMaxCommentsLimit()}\n`
  );
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n❌ El puerto ${PORT} ya está en uso.` +
      `\n   Liberálo con: npm run stop\n`
    );
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  console.log(`\n${signal} recibido. Cerrando servidor...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
