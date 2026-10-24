'use strict';

// ==========================================================================
// analysisRoutes.js — El análisis de publicación de Instagram hacia el
// navegador.
// --------------------------------------------------------------------------
//   POST  /api/analyze                     { url } → 202 { id, yaEnCurso }
//   GET   /api/analyze/progress?plataforma=&id=      los pasos (o la fila)
//   GET   /api/analisis?plataforma=&limit=           recientes y en curso
//   GET   /api/analisis?plataforma=&url=             ¿ya se analizó ese link?
//   GET   /api/analisis/:id?plataforma=              el análisis entero
//   PATCH /api/analisis/:id/temas?plataforma=        los temas editados
//   GET   /api/analisis/:id/image?plataforma=&size=  la foto
//
// Todo va bajo /api/, detrás del gate de login (src/auth/gate.js). Las
// lecturas piden la plataforma, sin default: un id de otra red es 404. POST
// /api/analyze es la de Instagram (X tiene /api/x/analyze) y valida el link
// con checkAnalyzeUrl antes de gastar nada.
//
// El link original de la foto no sale del servidor: va la dirección propia
// (con la fecha en que se guardó, para que el navegador la conserve), y el
// archivo se arma con datos de la fila, nunca con texto del pedido.
//
// Separada de server.js, como statsRoutes.js, para probarla sin levantar
// la app.
// ==========================================================================

const path = require('path');
const db = require('./db');
const analysisJob = require('./analysisJob');
const progress = require('./analysisProgress');
const postImages = require('./postImages');
const { checkAnalyzeUrl } = require('./platforms/urlPlatform');
const { CACHE_CONTROL } = require('./postImageRoutes');

const PLATAFORMAS = new Set(['instagram', 'x']);
const MAX_TEMAS = 8;
const MAX_TITULO = 120;
const MAX_TEXTO = 1000;

function plataformaDe(req, res) {
  const plataforma = typeof req.query.plataforma === 'string' ? req.query.plataforma.trim() : '';
  if (!PLATAFORMAS.has(plataforma)) {
    res.status(400).json({ error: 'Falta el parámetro plataforma (instagram | x).' });
    return null;
  }
  return plataforma;
}

function imagenDe(analisis) {
  if (!analisis.imageSavedAt || !analisis.postId) return null;
  const url = (size) =>
    `/api/analisis/${analisis.id}/image?${new URLSearchParams({ plataforma: analisis.plataforma, size, v: analisis.imageSavedAt })}`;
  return { thumbUrl: url('thumb'), fullUrl: url('full') };
}

/** Un análisis como va al navegador: sin el link original de la foto. */
function paraNavegador(analisis) {
  if (!analisis) return null;
  const { image, imageSavedAt, ...resto } = analisis;
  return { ...resto, imagen: imagenDe(analisis), imagenEstado: image ? image.status : null };
}

function idDe(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Los temas editados: hasta MAX_TEMAS, con título; texto opcional; los
 * números de comentarios, solo los que existen en el análisis.
 * @returns {Array|null} null si no es una lista válida
 */
function limpiarTemas(raw, cantidadComentarios) {
  if (!Array.isArray(raw) || raw.length > MAX_TEMAS) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const titulo = typeof item.titulo === 'string' ? item.titulo.trim().slice(0, MAX_TITULO) : '';
    const texto = typeof item.texto === 'string' ? item.texto.trim().slice(0, MAX_TEXTO) : '';
    if (!titulo) return null;
    const comentarios = Array.isArray(item.comentarios)
      ? [...new Set(item.comentarios.filter((n) => Number.isInteger(n) && n >= 1 && n <= cantidadComentarios))].sort((a, b) => a - b)
      : [];
    out.push({ titulo, texto, comentarios });
  }
  return out;
}

function register(app) {
  app.post('/api/analyze', (req, res) => {
    const { url } = req.body || {};
    const guard = checkAnalyzeUrl(url, 'instagram');
    if (!guard.ok) return res.status(400).json({ error: guard.error });
    try {
      const started = analysisJob.start({ url, analizadoPor: req.auth ? req.auth.email : null });
      if (!started) {
        return res.status(400).json({ error: 'Ingresá el link de una publicación de Instagram (…/p/… o …/reel/…).' });
      }
      return res.status(202).json(started);
    } catch (err) {
      console.error('Error en POST /api/analyze:', err);
      return res.status(500).json({ error: 'No se pudo arrancar el análisis. Revisá la consola del servidor.' });
    }
  });

  app.get('/api/analyze/progress', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Falta el id del análisis.' });
    const view = progress.getView(id, plataforma);
    if (view) return res.json(view);
    // Ya no está en memoria (terminó hace rato o se reinició el servidor): la fila.
    const fila = db.getAnalisis(id, plataforma);
    if (!fila) return res.status(404).json({ error: 'No existe ese análisis.' });
    return res.json({ id: fila.id, estado: fila.estado, error: fila.error, startedAt: fila.startedAt, finishedAt: fila.finishedAt, pasos: null });
  });

  app.get('/api/analisis', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    try {
      if (req.query.url !== undefined) {
        const norm = analysisJob.normalizeAnalysisUrl(String(req.query.url));
        if (!norm) return res.status(400).json({ error: 'Ese link no es de una publicación.' });
        return res.json({
          ultimo: paraNavegador(db.findAnalisisByUrl({ plataforma, url: norm.url })),
          enCurso: plataforma === 'instagram' ? analysisJob.enCursoDe(norm.url) : null,
        });
      }
      // "propio": lo arrancó el mismo correo (cualquier sesión de esa
      // persona; sin login, todos). Al cargar, la solapa sigue solo esos (el
      // de otra persona no le bloquea "Analizar"); el correo no sale de acá.
      const quien = (req.auth && req.auth.email) || null;
      return res.json({
        recientes: db.listAnalisis({ plataforma, limit: req.query.limit }).map(paraNavegador),
        enCurso:
          plataforma === 'instagram'
            ? analysisJob.listEnCurso().map((a) => ({ id: a.id, url: a.url, propio: (a.analizadoPor || null) === quien }))
            : [],
      });
    } catch (err) {
      console.error('Error en GET /api/analisis:', err);
      return res.status(500).json({ error: 'No se pudieron leer los análisis.' });
    }
  });

  app.get('/api/analisis/:id', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const id = idDe(req);
    const analisis = id ? db.getAnalisis(id, plataforma) : null;
    if (!analisis) return res.status(404).json({ error: 'No existe ese análisis.' });
    return res.json(paraNavegador(analisis));
  });

  app.patch('/api/analisis/:id/temas', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const id = idDe(req);
    const analisis = id ? db.getAnalisis(id, plataforma) : null;
    if (!analisis || analisis.estado !== 'ok') return res.status(404).json({ error: 'No existe ese análisis.' });
    const temas = limpiarTemas(req.body && req.body.temas, analisis.comentarios.length);
    if (!temas) {
      return res.status(400).json({ error: `Los temas tienen que ser una lista de hasta ${MAX_TEMAS}, cada uno con su título.` });
    }
    db.updateAnalisisTemas(id, plataforma, temas);
    return res.json({ temas });
  });

  app.get('/api/analisis/:id/image', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const size = typeof req.query.size === 'string' ? req.query.size : '';
    if (!postImages.SIZES.includes(size)) return res.status(400).json({ error: 'Tamaño inválido: thumb o full.' });
    const notFound = () => res.status(404).json({ error: 'Ese análisis no tiene imagen guardada.' });
    const id = idDe(req);
    const analisis = id ? db.getAnalisis(id, plataforma) : null;
    if (!analisis || !analisis.imageSavedAt || !analisis.postId) return notFound();
    const paths = postImages.imagePaths(plataforma, analisis.postId);
    if (!paths) return notFound();
    return res.sendFile(
      path.basename(paths[size]),
      { root: paths.dir, dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': CACHE_CONTROL, 'X-Content-Type-Options': 'nosniff' } },
      (err) => {
        if (err && !res.headersSent) notFound();
      }
    );
  });
}

module.exports = { register, paraNavegador, limpiarTemas, MAX_TEMAS };
