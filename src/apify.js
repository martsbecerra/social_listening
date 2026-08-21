// ==========================================================================
// apify.js
// --------------------------------------------------------------------------
// Se encarga de hablar con Apify para extraer (scrapear) los datos de
// Instagram: los comentarios de la publicación y los datos del posteo en sí.
//
// Usamos el actor oficial "apify/instagram-scraper".
//
// DECISIÓN: endpoint SINCRÓNICO (run-sync-get-dataset-items)
// --------------------------------------------------------------------------
// Apify ofrece dos formas de correr un actor:
//   1) Sincrónica: una sola llamada HTTP que se queda esperando hasta que
//      el scraping termina y te devuelve directamente los resultados.
//   2) Asincrónica: arrancás el run, después consultás el estado en un bucle
//      ("¿ya terminó? ¿ya terminó?") y al final pedís el dataset.
//
// Elegimos la SINCRÓNICA porque es mucho más simple de programar y de
// entender: una llamada = un resultado, sin bucles de espera. Para analizar
// los comentarios de UN posteo suele terminar en menos de 1-2 minutos, muy
// por debajo del límite (~5 min) que Apify mantiene la conexión abierta.
//
// Contra: si un posteo tuviera MUCHÍSIMOS comentarios y el scraping tardara
// más que ese límite, la conexión se cortaría. En ese caso convendría el
// flujo asincrónico. Para este caso de uso, el sincrónico es lo correcto.
// ==========================================================================

// Nombre del actor en la API (el "/" se escribe como "~")
const APIFY_ACTOR = 'apify~instagram-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';

// Cuánto esperamos como máximo antes de cortar por nuestra cuenta (5 min).
const REQUEST_TIMEOUT_MS = 300000;

/**
 * Corre el actor de Apify de forma sincrónica y devuelve los items del dataset.
 * @param {object} input - La configuración (input) que espera el actor.
 * @returns {Promise<Array>} Lista de items scrapeados.
 */
async function runActorSync(input) {
  const token = process.env.APIFY_API_TOKEN;
  const url = `${APIFY_BASE}/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  // AbortController nos deja cancelar la llamada si tarda demasiado, para
  // devolver un mensaje claro en vez de quedar colgados.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (err) {
    // Si abortamos por timeout, el error se llama "AbortError".
    if (err.name === 'AbortError') {
      const e = new Error('Apify tardó demasiado en responder.');
      e.userMessage = 'La extracción tardó demasiado. Puede que la publicación tenga muchísimos comentarios. Probá de nuevo o con otra publicación.';
      throw e;
    }
    const e = new Error(`Error de red al llamar a Apify: ${err.message}`);
    e.userMessage = 'No se pudo conectar con el servicio de extracción. Revisá tu conexión a internet e intentá de nuevo.';
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const e = new Error(`Apify respondió ${resp.status}: ${text}`);
    e.userMessage = mapApifyError(resp.status);
    throw e;
  }

  return resp.json();
}

/**
 * Traduce un código de error HTTP de Apify a un mensaje entendible para el usuario.
 */
function mapApifyError(status) {
  if (status === 401 || status === 403) {
    return 'La clave de Apify (APIFY_API_TOKEN) es inválida o no tiene permisos. Revisá el archivo .env.';
  }
  if (status === 404) {
    return 'No se encontró el actor de Apify o la URL. Verificá el link de la publicación.';
  }
  if (status === 429) {
    return 'Se alcanzó el límite de uso de Apify por el momento. Esperá unos minutos e intentá de nuevo.';
  }
  return 'El servicio de extracción (Apify) falló al procesar la publicación. Intentá de nuevo en unos minutos.';
}

/**
 * Extrae comentarios y datos del posteo de una URL de Instagram.
 *
 * Hacemos DOS corridas del actor en paralelo:
 *   - Una en modo "comments" -> trae los comentarios.
 *   - Una en modo "posts"    -> trae los datos del posteo (caption, likes, etc.).
 *
 * Correrlas en paralelo (Promise.all) hace que no sea mucho más lento que una.
 * Además, en la corrida de comentarios pedimos "addParentData: true" para que
 * cada comentario venga acompañado de info del posteo, como respaldo por si la
 * corrida de "posts" no trajera datos.
 *
 * @param {string} postUrl - URL de la publicación de Instagram.
 * @returns {Promise<{post: object, comments: Array}>}
 */
async function scrapeInstagram(postUrl) {
  const commentsInput = {
    directUrls: [postUrl],
    resultsType: 'comments',
    resultsLimit: Number(process.env.COMMENTS_LIMIT || 100),
    addParentData: true,
  };

  const postInput = {
    directUrls: [postUrl],
    resultsType: 'posts',
    resultsLimit: 1,
  };

  const commentsLimitRequested = commentsInput.resultsLimit;

  const [commentItems, postItems] = await Promise.all([
    runActorSync(commentsInput),
    runActorSync(postInput),
  ]);

  const rawCommentItems = Array.isArray(commentItems) ? commentItems.length : 0;
  const post = normalizePost(postItems, commentItems, postUrl);
  const comments = normalizeComments(commentItems);

  const scrapeMeta = {
    commentsLimitRequested,
    rawCommentItems,
    commentsOnPost: post.commentsCount,
    comentariosTrasNormalizar: comments.length,
  };

  if (
    Number.isFinite(commentsLimitRequested) &&
    rawCommentItems > 0 &&
    rawCommentItems < commentsLimitRequested
  ) {
    const apifyFreeHint =
      rawCommentItems <= 15
        ? ' Apify en plan gratuito suele devolver ~15 comentarios (una página); con plan pago podés pedir más (hasta ~50 por post en este actor).'
        : '';
    console.warn(
      `[apify] Apify devolvió ${rawCommentItems} ítems de comentarios, menos que COMMENTS_LIMIT=${commentsLimitRequested}.${apifyFreeHint}` +
      (post.commentsCount != null && post.commentsCount > rawCommentItems
        ? ` Instagram reporta ${post.commentsCount} comentarios en el post.`
        : '')
    );
  }

  return { post, comments, scrapeMeta };
}

/**
 * Toma los datos crudos del posteo y los deja en un formato limpio y predecible.
 * Los nombres de campos que devuelve Apify pueden variar según la versión del
 * actor, por eso probamos varias alternativas ("??" usa la primera que exista).
 */
function normalizePost(postItems, commentItems, postUrl) {
  const raw = (Array.isArray(postItems) && postItems[0]) || {};

  // Respaldo: si la corrida de "posts" vino vacía, intentamos con la info de
  // posteo que viene adjunta a los comentarios (parent data).
  const parent = (Array.isArray(commentItems) && commentItems[0]) || {};

  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

  return {
    url: postUrl,
    ownerFullName: pick(raw.ownerFullName, parent.ownerFullName, 'N/D'),
    ownerUsername: pick(raw.ownerUsername, parent.ownerUsername, 'N/D'),
    caption: pick(raw.caption, parent.caption, ''),
    likesCount: pick(raw.likesCount, parent.likesCount, null),
    commentsCount: pick(raw.commentsCount, parent.commentsCount, null),
    videoPlayCount: pick(raw.videoPlayCount, raw.videoViewCount, parent.videoPlayCount, null),
  };
}

/**
 * Deja cada comentario en un formato limpio con solo los campos que necesitamos.
 * El orden del array no se garantiza; commentSample.js lo normaliza antes del análisis.
 */
function normalizeComments(commentItems) {
  if (!Array.isArray(commentItems)) return [];

  return commentItems
    // Nos quedamos solo con items que realmente tengan texto de comentario.
    .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => ({
      // id opcional de Apify: desempate estable en commentSample.js si hay empates.
      apifyId: c.id ?? c.commentId ?? c.pk ?? null,
      username: c.ownerUsername || (c.owner && c.owner.username) || 'desconocido',
      isVerified: Boolean(
        c.ownerIsVerified ?? (c.owner && c.owner.is_verified) ?? false
      ),
      likesCount: Number(c.likesCount || 0),
      timestamp: c.timestamp || null,
      text: c.text.trim(),
    }));
}

module.exports = { scrapeInstagram, runActorSync, mapApifyError };
