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
    const { report, csv, meta: analysisMeta } = await analyzeComments({ url, post, comments });

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
      },
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
// Arrancamos el servidor.
// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
checkEnv();
app.listen(PORT, () => {
  console.log(`\n✅ Servidor listo en http://localhost:${PORT}\n`);
});
