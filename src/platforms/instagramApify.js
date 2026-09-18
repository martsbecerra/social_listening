// ==========================================================================
// platforms/instagramApify.js — Proveedor apify/instagram-scraper del
// adapter de Instagram (IG_ACTOR=apify).
// --------------------------------------------------------------------------
// Es el código que tenía src/platforms/instagram.js antes del cambio de
// actor (septiembre 2026), movido acá SIN cambios de lógica: con
// IG_ACTOR=apify el monitoreo se comporta exactamente como antes. La
// fachada instagram.js elige entre este proveedor y instagramApidojo.js y
// expone el mismo contrato hacia el resto de la app (platforms/index.js).
//
// Este actor cobra por resultado devuelto (item del dataset, incluidos los
// items de error no_items / not_found) y no ofrece búsqueda por palabra
// clave: por eso no exporta scrapeSearch.
//
// NOTA sobre nombres de campos: igual que en src/apify.js, los nombres que
// devuelve el actor pueden variar según la versión (ver README). Si algo
// aparece vacío, revisar una corrida real en el panel de Apify.
// ==========================================================================

const { runActorSync, isQuotaExceededError } = require('../apify');

const PROVIDER_ID = 'apify';
const ACTOR_ID = 'apify~instagram-scraper';

function buildProfileUrl(username) {
  return `https://www.instagram.com/${username}/`;
}

function buildHashtagUrl(tag) {
  return `https://www.instagram.com/explore/tags/${tag}/`;
}

/**
 * Corre el actor de ESTE proveedor (mismo runActorSync genérico de apify.js).
 * apify.js ya marca `code` (AUTH_INVALID / RATE_LIMITED / QUOTA_EXCEEDED, ver
 * platforms/errors.js); acá queda el respaldo por texto para la cuota, por
 * si el error llegara por otro camino sin código.
 */
async function runActor(input) {
  try {
    return await runActorSync(input, { actorId: ACTOR_ID, plataforma: 'instagram' });
  } catch (err) {
    if (err && !err.code && isQuotaExceededError(err)) err.code = 'QUOTA_EXCEEDED';
    throw err;
  }
}

/**
 * Chequea contra Apify que la cuenta/hashtag realmente exista antes de
 * guardarla, para no quedar cada 4hs consultando una página inexistente por
 * un typo. El actor no tira error HTTP para esto: devuelve un item con
 * "error": "not_found" (cuentas) o "no_items" (hashtags) en vez de datos
 * reales, así que basta con mirar ese campo. Cuesta un resultado.
 */
async function validateAccount(account) {
  const items = await runActor({
    directUrls: [buildProfileUrl(account)],
    resultsType: 'posts',
    resultsLimit: 1,
  });
  const first = Array.isArray(items) && items[0];
  if (first && first.error) {
    const e = new Error(`Cuenta no encontrada: ${account}`);
    e.userMessage = `No encontramos la cuenta @${account} en Instagram. Revisá que esté bien escrita.`;
    throw e;
  }
}

async function validateHashtag(tag) {
  const items = await runActor({
    directUrls: [buildHashtagUrl(tag)],
    resultsType: 'posts',
    resultsLimit: 1,
  });
  const first = Array.isArray(items) && items[0];
  if (first && first.error) {
    const e = new Error(`Hashtag no encontrado: ${tag}`);
    e.userMessage = `No encontramos contenido para el hashtag #${tag}. Revisá que esté bien escrito.`;
    throw e;
  }
}

/**
 * Tipo de posteo (reel|imagen|carrusel), para el benchmark de
 * src/accountStats.js. Probamos varios nombres de campo posibles del actor
 * y si ninguno aparece, devolvemos null (misma filosofía "pick" que ya usa
 * normalizePost acá y en apify.js).
 */
function derivePostType(raw) {
  const productType = String(raw.productType || '').toLowerCase();
  if (productType === 'clips') return 'reel';
  if (productType === 'carousel_container') return 'carrusel';

  const type = String(raw.type || '').toLowerCase();
  if (type === 'sidecar') return 'carrusel';
  if (type === 'video') return 'reel';
  if (type === 'image') return 'imagen';

  if (typeof raw.isVideo === 'boolean') return raw.isVideo ? 'reel' : 'imagen';

  return null;
}

// Apify (apify/instagram-scraper) devuelve -1 en likesCount cuando el autor
// ocultó el contador de "me gusta" del posteo — no es un dato real, es un
// centinela de "no disponible" (confirmado: es un comportamiento documentado
// del actor, no un error de parseo nuestro). Lo tratamos igual que "sin
// dato" — null, nunca -1 ni 0 — para no inventar un valor ni contaminar la
// mediana de account_stats. No hay documentación de que commentsCount use el
// mismo centinela, pero por las dudas (y porque un comentario negativo nunca
// puede ser real) se aplica el mismo criterio ahí también.
function nullIfMissingSentinel(value) {
  return typeof value === 'number' && value < 0 ? null : value;
}

/**
 * Dado un item crudo del actor (resultsType: 'posts'), lo deja en el formato
 * predecible que espera el orquestador (ver platforms/index.js). Mismo estilo
 * defensivo ("pick" con varias alternativas) que normalizePost() en
 * src/apify.js.
 *
 * Este actor no trae seguidores a nivel de posteo: `followers` queda null y
 * el benchmark los consulta aparte (fetchAccountFollowers).
 */
function normalizePost(raw, { account, sourceType, sourceQuery = null }) {
  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');
  const shortCode = pick(raw.shortCode, raw.code);
  const id = String(pick(raw.id, shortCode, raw.pk));
  const url = pick(raw.url, shortCode && `https://www.instagram.com/p/${shortCode}/`);
  const hashtags = Array.isArray(raw.hashtags) ? raw.hashtags.join(' ') : '';

  return {
    id,
    account: pick(raw.ownerUsername, raw.owner && raw.owner.username, account, 'N/D'),
    url,
    caption: pick(raw.caption, ''),
    hashtagsText: hashtags,
    likes: nullIfMissingSentinel(pick(raw.likesCount, null)),
    comments: nullIfMissingSentinel(pick(raw.commentsCount, null)),
    postedAt: pick(raw.timestamp, null),
    postType: derivePostType(raw),
    followers: null,
    sourceType,
    sourceQuery,
  };
}

/**
 * Solo scrapea — el filtrado de relevancia se hace después, en el
 * orquestador (runMonitoringCycle).
 *
 * `lookback` usa la sintaxis del actor ("1 day"); `undefined` = sin filtro
 * de fecha (camino del benchmark, que filtra los 3 meses por su cuenta).
 */
async function scrapeAccount(username, { resultsLimit, lookback }) {
  const items = await runActor({
    directUrls: [buildProfileUrl(username)],
    resultsType: 'posts',
    resultsLimit,
    onlyPostsNewerThan: lookback,
    skipPinnedPosts: true,
  });

  // Cuando no hay posteos nuevos (o la cuenta no tiene datos en esa
  // ventana), el actor devuelve un item con "error": "no_items"/"not_found"
  // en vez de un posteo real — hay que descartarlo, si no queda guardado
  // como si fuera un posteo (con el link del perfil en vez de uno real).
  return (Array.isArray(items) ? items : [])
    .filter((raw) => !raw.error)
    .map((raw) => normalizePost(raw, { account: username, sourceType: 'account' }));
}

async function scrapeHashtag(tag, { resultsLimit }) {
  const items = await runActor({
    directUrls: [buildHashtagUrl(tag)],
    resultsType: 'posts',
    resultsLimit,
  });

  return (Array.isArray(items) ? items : [])
    .filter((raw) => !raw.error)
    .map((raw) => normalizePost(raw, { account: null, sourceType: 'hashtag' }));
}

/**
 * Cantidad de seguidores de una cuenta. Los items de "posts" de este actor
 * NO traen este dato (solo ownerFullName/ownerUsername/ownerId a nivel de
 * posteo) — hace falta una corrida aparte con resultsType "details" sobre
 * la URL del perfil, que devuelve followersCount en el nivel superior del
 * item. La llama accountStats.computeAccountStats con la cadencia del
 * benchmark, solo cuando los posteos no trajeron el dato.
 *
 * Nunca tira: sin token de Apify, cuenta privada, actor caído o cualquier
 * otro error, devuelve null (la columna de seguidores queda en "-", el
 * resto del ciclo de monitoreo sigue sin verse afectado).
 * @returns {Promise<number|null>}
 */
async function fetchAccountFollowers(username) {
  try {
    const items = await runActor({
      directUrls: [buildProfileUrl(username)],
      resultsType: 'details',
      resultsLimit: 1,
    });
    const raw = (Array.isArray(items) && items[0]) || null;
    if (!raw || raw.error) return null;
    const value = Number(raw.followersCount);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    console.error(`No se pudieron traer los seguidores de @${username}:`, err.message);
    return null;
  }
}

module.exports = {
  id: PROVIDER_ID,
  ACTOR_ID,
  buildProfileUrl,
  buildHashtagUrl,
  validateAccount,
  validateHashtag,
  scrapeAccount,
  scrapeHashtag,
  normalizePost,
  derivePostType,
  fetchAccountFollowers,
};
