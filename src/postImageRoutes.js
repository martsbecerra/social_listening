// ==========================================================================
// postImageRoutes.js — Las fotos de los posteos hacia el navegador.
// --------------------------------------------------------------------------
// Dos cosas, separadas de server.js para poder probarlas sin levantar la app
// (ver openspec/changes/monitoreo-fotos, REQ-FOTO-06):
//
//   - withImage(post, plataforma): cómo sale cada posteo en el listado de
//     /api/monitoring/posts. Suma `image` (las direcciones de la miniatura y
//     de la imagen grande, el estado del último intento y las medidas) y saca
//     las columnas crudas image_*: el link original de Instagram no sale del
//     servidor.
//   - GET /api/monitoring/posts/:id/image?plataforma=...&size=thumb|full:
//     manda el archivo. Va bajo /api/, así que el gate de login
//     (src/auth/gate.js) responde 401 sin sesión; data/media no está dentro
//     de public/ y no se sirve como estático.
//
// El archivo se arma con datos de la base, nunca con texto del pedido: el id
// tiene que ser el de un posteo guardado en esa plataforma y con copias
// anotadas, el tamaño es de una lista cerrada, y la carpeta y el nombre
// salen de postImages.imagePaths (que además rechaza un id que no sirva como
// nombre de archivo).
//
// Con POST_IMAGES=0 lo ya guardado se sigue sirviendo: ese interruptor apaga
// las descargas, no las fotos.
// ==========================================================================

const path = require('path');
const db = require('./db');
const postImages = require('./postImages');

const IMAGE_ROUTE = '/api/monitoring/posts/:id/image';
const RAW_COLUMNS = ['image_source_url', 'image_status', 'image_saved_at', 'image_width', 'image_height'];
// El archivo de una dirección no cambia nunca: la dirección lleva la fecha en
// que se guardó (v=), así que el navegador lo puede conservar. "private": son
// datos detrás del login, no los guarda un proxy compartido.
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

function hasImages(plataforma) {
  return Object.prototype.hasOwnProperty.call(postImages.IMAGE_HOSTS, plataforma);
}

function imageUrlFor(id, plataforma, size, savedAt) {
  const query = new URLSearchParams({ plataforma, size, v: savedAt });
  return `/api/monitoring/posts/${encodeURIComponent(id)}/image?${query}`;
}

/**
 * El posteo como va al navegador en el listado.
 * @param {object} post fila de detected_posts (db.listDetectedPosts)
 * @param {string} plataforma
 * @returns {object} el mismo posteo sin las columnas image_* y con `image`:
 *   { thumbUrl, fullUrl, status, width, height }, con las direcciones en
 *   null si no hay copias guardadas; `image: null` si la plataforma no tiene
 *   fotos.
 */
function withImage(post, plataforma) {
  const out = { ...post };
  for (const column of RAW_COLUMNS) delete out[column];
  if (!hasImages(plataforma)) {
    out.image = null;
    return out;
  }
  const savedAt = post.image_saved_at || null;
  out.image = {
    thumbUrl: savedAt ? imageUrlFor(post.id, plataforma, 'thumb', savedAt) : null,
    fullUrl: savedAt ? imageUrlFor(post.id, plataforma, 'full', savedAt) : null,
    status: post.image_status || null,
    width: post.image_width === undefined ? null : post.image_width,
    height: post.image_height === undefined ? null : post.image_height,
  };
  return out;
}

/** Manejador de GET /api/monitoring/posts/:id/image. */
function sendPostImage(req, res) {
  const plataforma = typeof req.query.plataforma === 'string' ? req.query.plataforma.trim() : '';
  const size = typeof req.query.size === 'string' ? req.query.size : '';
  if (!plataforma) return res.status(400).json({ error: 'Falta el parámetro plataforma (instagram | x).' });
  if (!postImages.SIZES.includes(size)) return res.status(400).json({ error: 'Tamaño inválido: thumb o full.' });

  const notFound = () => res.status(404).json({ error: 'Esa publicación no tiene imagen guardada.' });
  const id = String(req.params.id || '');
  let state = null;
  try {
    state = db.getPostImage(id, plataforma);
  } catch (err) {
    state = null;
  }
  // Por id Y plataforma (404 desde otra solapa), y solo con copias anotadas.
  if (!state || !state.savedAt) return notFound();
  const paths = postImages.imagePaths(plataforma, id);
  if (!paths) return notFound();

  return res.sendFile(
    path.basename(paths[size]),
    {
      root: paths.dir,
      dotfiles: 'deny',
      cacheControl: false,
      headers: { 'Cache-Control': CACHE_CONTROL, 'X-Content-Type-Options': 'nosniff' },
    },
    (err) => {
      // La base dice que hay copia y el archivo no está (se restauró la base
      // sin la carpeta): 404, y el próximo refresco la vuelve a bajar.
      if (err && !res.headersSent) notFound();
    }
  );
}

/** Monta la ruta en la app (después del gate de login). */
function register(app) {
  app.get(IMAGE_ROUTE, sendPostImage);
}

module.exports = { register, sendPostImage, withImage, IMAGE_ROUTE, CACHE_CONTROL };
