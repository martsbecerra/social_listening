'use strict';

// ==========================================================================
// analysisRoutes.js — El análisis de publicación de Instagram hacia el
// navegador.
// --------------------------------------------------------------------------
//   POST  /api/analyze                     { url } → 202 { id, yaEnCurso }
//   GET   /api/analyze/progress?plataforma=&id=      los pasos (o la fila)
//   GET   /api/analisis?plataforma=&limit=&q=&f=&ord= recientes / galería y en curso
//   GET   /api/analisis?plataforma=&url=             ¿ya se analizó ese link?
//   GET   /api/analisis/:id?plataforma=              el análisis entero (con `vista`)
//   PATCH /api/analisis/:id/temas?plataforma=        editar los temas
//   GET   /api/analisis/:id/comentarios.csv?plataforma=  el CSV de comentarios
//   GET   /api/analisis/:id/reclamos.csv?plataforma=     el CSV de reclamos
//   GET   /api/analisis/:id/image?plataforma=&size=  la foto
//
// Todo va bajo /api/, detrás del gate de login (src/auth/gate.js). Las
// lecturas piden la plataforma, sin default: un id de otra red es 404. POST
// /api/analyze es la de Instagram (X tiene /api/x/analyze) y valida el link
// con checkAnalyzeUrl antes de gastar nada.
//
// Fase F: GET /api/analisis/:id suma `vista` (analysisMetrics: todo lo
// numérico, contado al leer, con las figuras, los reclamos del posteo y los
// análisis anteriores de la cuenta al día) e `informe` (el de 8 puntos).
// Hasta que la pantalla nueva llegue (F2) conserva los campos que lee la
// solapa de la fase E: en un análisis v2, `temas` va como la lista vieja
// (título y números de comentarios) y `reporteAntes` es el informe nuevo.
//
// El link original de la foto y quién corrió el análisis no salen del
// servidor; el archivo se arma con datos de la fila, nunca con texto del
// pedido.
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
const { buildAnalysisView, columnasDeVista } = require('./analysisMetrics');
const { buildInforme, buildComentariosCsv } = require('./reportBuilder');
const { aplicarCambio, traducirListaVieja } = require('./analysisTemas');

const PLATAFORMAS = new Set(['instagram', 'x']);
const MAX_TEMAS = 8;
const MAX_TITULO = 120;
const MAX_TEXTO = 1000;
const TZ = 'America/Argentina/Buenos_Aires';
const DIA_ISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

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

const esV2 = (analisis) => Boolean(analisis && analisis.resultado && analisis.resultado.version === 2);

/** La vista de analysisMetrics, con lo que se lee al día: figuras, reclamos del posteo y anteriores de la cuenta. */
function vistaDe(analisis) {
  const vista = buildAnalysisView(analisis, {
    figuras: db.getFigurasPorUsernames((analisis.comentarios || []).map((c) => c.usuario)),
    reclamos: db.listReclamosDePost({ plataforma: analisis.plataforma, postUrl: analisis.url }),
    anteriores: db.listAnterioresDeCuenta({
      plataforma: analisis.plataforma,
      cuenta: analisis.cuenta,
      id: analisis.id,
      antesDe: analisis.startedAt,
      postCode: analisis.postCode,
    }),
  });
  vista.imagen = imagenDe(analisis);
  return vista;
}

/**
 * Los temas v2 como los lee la solapa de la fase E: título, texto (solo el
 * de uno agregado a mano; los del modelo no tienen) y los números de sus
 * comentarios. La solapa ya no arma el texto para compartir con ellos: usa
 * el informe, que los nombra.
 */
function temasCompat(vista) {
  return vista.temas.map((t) => ({
    id: t.id,
    titulo: t.nombre,
    texto: t.manual ? t.texto || '' : '',
    comentarios: vista.comentarios.filter((c) => c.temaId === t.id).map((c) => c.n),
  }));
}

/** El análisis entero: lo de siempre, `vista` e `informe`; en un v2, los campos de la fase E armados desde la vista. */
function completoParaNavegador(analisis) {
  const base = paraNavegador(analisis);
  const vista = vistaDe(analisis);
  const informe = buildInforme(vista);
  if (!esV2(analisis)) return { ...base, vista, informe };
  const { comentarios, ...resto } = base;
  return { ...resto, comentarios, temas: temasCompat(vista), reporteAntes: informe, reporteDespues: '', vista, informe };
}

function idDe(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Los temas editados de un análisis v1 (fase E): hasta MAX_TEMAS, con
 * título; texto opcional; los números de comentarios, solo los que existen.
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

/** "comentarios-jorgemacri-2026-10-24.csv": la cuenta y el día del análisis en Argentina. */
function nombreCsv(prefijo, analisis) {
  const cuenta = String(analisis.cuenta || 'publicacion').replace(/[^A-Za-z0-9._-]/g, '-');
  const d = new Date(analisis.finishedAt || analisis.startedAt || Date.now());
  return `${prefijo}-${cuenta}-${DIA_ISO.format(Number.isNaN(d.getTime()) ? new Date() : d)}.csv`;
}

function enviarCsv(res, nombre, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nombre}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  // El BOM hace que Excel en Windows abra bien los acentos y la "ñ".
  return res.send(`﻿${csv}`);
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
      // La galería (fase F): búsqueda, filtro y orden; sin ellos, los más
      // recientes (la tira y el inicio).
      const texto = (v) => (typeof v === 'string' ? v : '');
      const galeria = db.listAnalisisGaleria({
        plataforma,
        q: texto(req.query.q).slice(0, 100),
        f: texto(req.query.f) || 'all',
        ord: texto(req.query.ord) || 'recent',
        limit: req.query.limit,
      });
      // "propio": lo arrancó el mismo correo (cualquier sesión de esa
      // persona; sin login, todos). Al cargar, la solapa sigue solo esos (el
      // de otra persona no le bloquea "Analizar"); el correo no sale de acá.
      const quien = (req.auth && req.auth.email) || null;
      return res.json({
        recientes: galeria.items.map(paraNavegador),
        total: galeria.total,
        desde: galeria.desde,
        coinciden: galeria.coinciden,
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
    if (analisis.estado !== 'ok') return res.json(paraNavegador(analisis));
    try {
      return res.json(completoParaNavegador(analisis));
    } catch (err) {
      console.error(`Error armando el análisis #${id}:`, err);
      return res.status(500).json({ error: 'No se pudo armar el análisis.' });
    }
  });

  // v1: la lista entera, como en la fase E. v2: un cambio ({ accion:
  // 'renombrar' | 'agregar' | 'quitar', id, nombre, texto }) o la lista vieja
  // de la solapa de la fase E, que se traduce a ese cambio. Responde el
  // análisis entero, como GET.
  app.patch('/api/analisis/:id/temas', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const id = idDe(req);
    const analisis = id ? db.getAnalisis(id, plataforma) : null;
    if (!analisis || analisis.estado !== 'ok') return res.status(404).json({ error: 'No existe ese análisis.' });
    const body = req.body || {};
    if (!esV2(analisis)) {
      const temas = limpiarTemas(body.temas, analisis.comentarios.length);
      if (!temas) {
        return res.status(400).json({ error: `Los temas tienen que ser una lista de hasta ${MAX_TEMAS}, cada uno con su título.` });
      }
      // Las columnas de la galería, con la misma cuenta que la vista (la estrella cambia con los temas).
      db.updateAnalisisTemas(id, plataforma, temas, { columnas: columnasDeVista(buildAnalysisView({ ...analisis, temas })) });
      return res.json({ temas });
    }
    try {
      const cambio = Array.isArray(body.temas) ? traducirListaVieja(temasCompat(vistaDe(analisis)), body.temas) : body;
      if (cambio) {
        const temas = aplicarCambio(analisis.temas, cambio);
        // Unir temas puede cambiar la estrella y el hecho dominante: todas las columnas de la galería.
        db.updateAnalisisTemas(id, plataforma, temas, { columnas: columnasDeVista(buildAnalysisView({ ...analisis, temas })) });
      }
      return res.json(completoParaNavegador(db.getAnalisis(id, plataforma)));
    } catch (err) {
      if (err && err.userMessage) return res.status(400).json({ error: err.userMessage });
      console.error(`Error editando los temas del análisis #${id}:`, err);
      return res.status(500).json({ error: 'No se pudieron guardar los temas.' });
    }
  });

  app.get('/api/analisis/:id/comentarios.csv', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const id = idDe(req);
    const analisis = id ? db.getAnalisis(id, plataforma) : null;
    if (!analisis || analisis.estado !== 'ok') return res.status(404).json({ error: 'No existe ese análisis.' });
    return enviarCsv(res, nombreCsv('comentarios', analisis), buildComentariosCsv(buildAnalysisView(analisis)));
  });

  app.get('/api/analisis/:id/reclamos.csv', (req, res) => {
    const plataforma = plataformaDe(req, res);
    if (!plataforma) return undefined;
    const id = idDe(req);
    const analisis = id ? db.getAnalisis(id, plataforma) : null;
    if (!analisis || analisis.estado !== 'ok' || !analisis.csv || !(analisis.reclamos > 0)) {
      return res.status(404).json({ error: 'Ese análisis no tiene reclamos con ubicación.' });
    }
    return enviarCsv(res, nombreCsv('reclamos', analisis), analisis.csv);
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
