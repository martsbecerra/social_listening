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
const { analyzeComments } = require('./src/anthropic');
const db = require('./src/db');
const monitor = require('./src/monitor');
const { startScheduler, runCycleAndNotify } = require('./src/scheduler');

const app = express();

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
  if (!process.env.ANTHROPIC_API_KEY) faltantes.push('ANTHROPIC_API_KEY');
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

  // 1) Validación del link.
  if (!isValidInstagramPostUrl(url)) {
    return res.status(400).json({
      error: 'Ingresá un link válido de una publicación de Instagram (por ejemplo: https://www.instagram.com/p/XXXXXXXX/).',
    });
  }

  try {
    // 2) Extraemos datos con Apify (comentarios + datos del posteo).
    const { post, comments } = await scrapeInstagram(url);

    // 3) Si no hay comentarios, no hay nada que analizar.
    if (!comments || comments.length === 0) {
      return res.status(422).json({
        error: 'La publicación no tiene comentarios visibles o no se pudieron extraer. Probá con otra publicación.',
      });
    }

    // 4) Analizamos con Claude (devuelve el reporte de texto y el CSV de reclamos).
    const { report, csv } = await analyzeComments({ url, post, comments });

    // 5) Devolvemos el reporte y el CSV al navegador.
    return res.json({
      report,
      csv,
      meta: { comentariosAnalizados: comments.length },
    });
  } catch (err) {
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

// --------------------------------------------------------------------------
// Arrancamos el servidor.
// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
checkEnv();
startScheduler();
app.listen(PORT, () => {
  console.log(`\n✅ Servidor listo en http://localhost:${PORT}\n`);
});
