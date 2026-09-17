// ==========================================================================
// platforms/instagram.js — Adapter de Instagram para el monitoreo.
// --------------------------------------------------------------------------
// Todo lo específico de Instagram vive acá: URLs, el actor de Apify y los
// nombres de campos que devuelve. La lógica vino SIN CAMBIOS de src/monitor.js
// (que queda como orquestador agnóstico de plataforma). La dependencia va en
// un solo sentido: monitor.js importa este módulo, nunca al revés.
//
// El contrato del adapter está documentado en platforms/index.js. Apify es
// un detalle interno de ESTE adapter: el orquestador no sabe qué fuente hay
// detrás, solo ve capabilities, isConfigured() y errores con `code`.
//
// NOTA sobre nombres de campos: igual que en src/apify.js, los nombres que
// devuelve el actor pueden variar según la versión (ver README). Si algo
// aparece vacío, revisar una corrida real en el panel de Apify.
// ==========================================================================

const { runActorSync, isQuotaExceededError } = require('../apify');

const PLATFORM_ID = 'instagram';
const ACTOR_ID = 'apify~instagram-scraper';

function buildProfileUrl(username) {
  return `https://www.instagram.com/${username}/`;
}

function buildHashtagUrl(tag) {
  return `https://www.instagram.com/explore/tags/${tag}/`;
}

function isConfigured() {
  return Boolean((process.env.APIFY_API_TOKEN || '').trim());
}

/**
 * Corre el actor de ESTA plataforma (mismo runActorSync genérico de apify.js).
 * apify.js ya marca `code` (AUTH_INVALID / RATE_LIMITED / QUOTA_EXCEEDED, ver
 * platforms/errors.js); acá queda el respaldo por texto para la cuota, por
 * si el error llegara por otro camino sin código.
 */
async function runActor(input) {
  try {
    return await runActorSync(input, { actorId: ACTOR_ID });
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
 * reales, así que basta con mirar ese campo.
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
 * src/accountStats.js. Sin verificar contra una corrida real de Apify
 * todavía (ver ese archivo) — probamos varios nombres de campo posibles del
 * actor y si ninguno aparece, devolvemos null (misma filosofía "pick" que ya
 * usa normalizePost acá y en apify.js).
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
 * Dado un item crudo del actor (resultsType: 'posts'), lo deja en un formato
 * predecible. Mismo estilo defensivo ("pick" con varias alternativas) que
 * normalizePost() en src/apify.js.
 *
 * sourceType indica de dónde salió ('account' o 'hashtag') — el orquestador
 * lo usa para decidir cómo evaluar la relevancia de un posteo sin caption.
 */
function normalizePost(raw, { account, sourceType }) {
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
    sourceType,
  };
}

/**
 * Solo scrapea — el filtrado de relevancia se hace después, en el
 * orquestador (runMonitoringCycle), porque combina coincidencia de texto con
 * detección semántica (ver classifyRelevance en src/classifier.js).
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
 * Cantidad de seguidores de una cuenta. Los items de "posts" NO traen este
 * dato (confirmado contra la doc del actor apify/instagram-scraper: solo
 * ownerFullName/ownerUsername/ownerId a nivel de posteo) — hace falta una
 * corrida aparte con resultsType "details" sobre la URL del perfil, que
 * devuelve followersCount en el nivel superior del item. Se llama desde
 * accountStats.computeAccountStats, con la misma cadencia que el benchmark
 * (cuando la cuenta aparece con un posteo nuevo y nunca se calculó o pasaron
 * BENCHMARK_RECALC_DAYS desde el último cálculo, o en un recálculo forzado
 * por script) — no en cada corrida de 4hs.
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
  id: PLATFORM_ID,
  label: 'Instagram',
  // Metadata propia de este adapter, no parte del contrato genérico.
  actorId: ACTOR_ID,
  /**
   * Qué sabe hacer esta plataforma además de detectar posteos (ver
   * platforms/index.js). Instagram tiene todo: benchmark por cuenta
   * (mediana de likes/comentarios), seguidores y refresco de métricas de
   * posteos ya guardados.
   */
  capabilities: { benchmark: true, followers: true, metricsRefresh: true },
  isConfigured,
  validateAccount,
  validateHashtag,
  scrapeAccount,
  scrapeHashtag,
  normalizePost,
  buildProfileUrl,
  fetchAccountFollowers,
  /**
   * Qué métricas expone esta plataforma, para que el frontend arme las
   * columnas leyendo de acá en vez de hardcodearlas, y para que el
   * orquestador sepa qué campos guardar y refrescar. `label` es el nombre
   * que se muestra en la UI; `primary` marca LA métrica a destacar de la
   * plataforma (en Instagram son los likes; en TikTok va a ser playCount).
   */
  metrics: [
    { key: 'likes', label: 'Likes', primary: true },
    { key: 'comments', label: 'Coment.', primary: false },
  ],
};
