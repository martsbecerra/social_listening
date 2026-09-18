// ==========================================================================
// platforms/instagramApidojo.js — Proveedor apidojo/instagram-scraper-api
// del adapter de Instagram (IG_ACTOR=apidojo, el default).
// --------------------------------------------------------------------------
// Por qué este actor (septiembre 2026): apify/instagram-scraper cobra por
// resultado (2,30 usd por 1.000 en plan Starter) y no busca por palabra
// clave. Este cobra POR CONSULTA con posteos incluidos (perfil 0,005 usd
// con 10; hashtag 0,015 con 30; búsqueda 0,015 con 20) más 0,0005 usd por
// posteo extra, no necesita login ni cookies, trae los seguidores del
// autor en cada posteo y tiene la búsqueda por palabra clave nativa de
// Instagram. No devuelve comentarios: por eso el análisis de una
// publicación (src/apify.js) sigue con el actor oficial.
//
// Cómo se le habla (mismo endpoint sincrónico que runActorSync ya usa):
//   - startUrls: URLs planas de perfil (instagram.com/usuario/), de hashtag
//     (instagram.com/explore/tags/tag/) o de búsqueda; o keywords: ["texto"]
//     para buscar por palabra clave.
//   - maxItems: tope TOTAL del run. Como se manda UNA fuente por run (una
//     cuenta, un hashtag, una búsqueda), funciona como tope por fuente y el
//     costo de cada llamada es predecible. Nunca se manda un run sin
//     maxItems: el default del actor es infinito y cada posteo se cobra.
//   - until: "YYYY-MM-DD", solo posteos creados desde esa fecha inclusive.
//     Reemplaza al onlyPostsNewerThan ("1 day") del actor oficial. Como
//     tiene granularidad de día, lo anterior a la ventana real
//     (MONITOR_LOOKBACK) se descarta acá, del lado nuestro, por createdAt —
//     eso cubre también los posteos fijados más viejos que la ventana (el
//     actor oficial lo hacía con skipPinnedPosts).
//   - customMapFunction: NO se usa. Filtrar ahí está penalizado por el actor.
//
// Salida por posteo (verificada contra una corrida real el 2026-09-18, ver
// test/fixtures/apidojo/): type "post", id (el id numérico de Instagram, el
// MISMO que devuelve el actor oficial: detected_posts dedupea por ese id y
// el refresco de métricas cruza por él), code, url (/p/{code}/, también
// igual), createdAt (ISO), caption (puede venir null), likeCount y
// commentCount (pueden venir null: quedan null, nunca 0), isVideo, video
// { playCount, duration }, isCarousel + carouselMedia[], isPinned,
// isPaidPartnership, isLikeAndViewCountsDisabled, location, audio, owner
// { username, isVerified, ... }. Los posteos de un perfil vienen del más
// nuevo al más viejo. Un perfil inexistente devuelve una lista vacía (no un
// item de error); igual se descarta cualquier item con noResults/error o
// sin id/url, por si el actor cambia.
//
// Seguidores: owner.followerCount viene SOLO en las consultas de perfil
// (detección de cuentas trackeadas, benchmark, refresco); en los posteos de
// hashtag y de búsqueda el owner llega sin ese dato. OJO: ese número es el
// del PERFIL CONSULTADO, no el del autor de cada item: en un posteo en
// colaboración (aparece en la grilla de la cuenta consultada pero su owner
// es otra cuenta) el actor repite los seguidores del perfil consultado
// (visto en el ciclo real del 2026-09-18: @somos100barrios quedó con los 54
// de @somoslupaa). Por eso `followers` solo se toma cuando el owner del item
// ES la cuenta consultada; si no, queda null. La caché se actualiza
// con cada respuesta que lo trae (monitor.rememberFollowers): una cuenta
// que apareció por hashtag queda sin seguidores hasta que el benchmark
// consulte su perfil. No hay consulta aparte de "details":
// fetchAccountFollowers devuelve null sin llamar a nadie, y una cuenta que
// no devuelve posteos se queda con el último valor conocido.
// ==========================================================================

const { runActorSync, isQuotaExceededError } = require('../apify');

const PROVIDER_ID = 'apidojo';
const ACTOR_ID = 'apidojo~instagram-scraper-api';
// Si un caller no pasa resultsLimit válido, se manda este tope en vez de
// ningún tope (ver el encabezado). Avisa en consola.
const FALLBACK_MAX_ITEMS = 10;

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

function buildProfileUrl(username) {
  return `https://www.instagram.com/${username}/`;
}

function buildHashtagUrl(tag) {
  return `https://www.instagram.com/explore/tags/${tag}/`;
}

/** Mismo runActorSync genérico (cola, reintento del 402, registro de costo); respaldo por texto para la cuota como en el otro proveedor. */
async function runActor(input) {
  try {
    return await runActorSync(input, { actorId: ACTOR_ID, plataforma: 'instagram' });
  } catch (err) {
    if (err && !err.code && isQuotaExceededError(err)) err.code = 'QUOTA_EXCEEDED';
    throw err;
  }
}

/**
 * Traduce el lookback del orquestador ("1 day", "6 hours", "2 weeks",
 * "30 minutes") a milisegundos. null si viene vacío o no se entiende: sin
 * ventana (camino del benchmark y del refresco, que piden "los últimos N").
 */
function parseLookbackMs(lookback) {
  if (lookback === undefined || lookback === null || lookback === '') return null;
  const m = String(lookback)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|days?|weeks?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const key = unit.startsWith('min') ? 'minute' : unit.startsWith('hour') ? 'hour' : unit.startsWith('week') ? 'week' : 'day';
  return n > 0 ? n * UNIT_MS[key] : null;
}

/**
 * Fecha UTC (YYYY-MM-DD) para `until`: el día en que arranca la ventana
 * (ahora − lookback). Con MONITOR_LOOKBACK="1 day" es la fecha UTC de ayer.
 * undefined = sin filtro de fecha.
 */
function untilDateFor(lookback, now = Date.now()) {
  const ms = parseLookbackMs(lookback);
  if (ms == null) return undefined;
  return new Date(now - ms).toISOString().slice(0, 10);
}

function maxItemsFor(resultsLimit) {
  const n = Number(resultsLimit);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  console.warn(`[apidojo] resultsLimit inválido (${resultsLimit}): se manda maxItems=${FALLBACK_MAX_ITEMS}.`);
  return FALLBACK_MAX_ITEMS;
}

/** Item que no es un posteo: vacío, o con noResults / error. (Un perfil inexistente devuelve lista vacía; esto es por si el actor cambia.) */
function isNoResults(raw) {
  if (!raw || typeof raw !== 'object') return true;
  if (raw.noResults === true) return true;
  return raw.error !== undefined && raw.error !== null && raw.error !== false && raw.error !== '';
}

/** Contador: entero >= 0; cualquier otra cosa (ausente, oculto, negativo) es "sin dato" = null, nunca 0. */
function countOrNull(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** createdAt a ISO (acepta ISO, epoch en segundos o milisegundos). null si no hay fecha. */
function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractHashtags(caption) {
  return (String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || []).join(' ');
}

/**
 * Tipo de posteo con los MISMOS valores que account_stats (reel | imagen |
 * carrusel), para que el benchmark existente siga sirviendo. Nombres
 * verificados en la salida real: isCarousel (+ carouselMedia[]) e isVideo;
 * `type` es siempre "post". El carrusel se mira antes que el video (un
 * carrusel puede contener un video). Los nombres del actor oficial quedan
 * como respaldo por si este cambia; sin ningún indicador, null (cae a la
 * mediana global).
 */
function derivePostType(raw) {
  if (raw.isCarousel === true || (Array.isArray(raw.carouselMedia) && raw.carouselMedia.length > 1)) return 'carrusel';
  if (raw.isVideo === true || (raw.video && typeof raw.video === 'object')) return 'reel';
  if (raw.isVideo === false) return 'imagen';
  const type = String(raw.productType || raw.type || '').toLowerCase();
  if (type === 'carousel_container' || type === 'sidecar') return 'carrusel';
  if (type === 'clips' || type === 'video') return 'reel';
  if (type === 'image') return 'imagen';
  return null;
}

/**
 * Deja un item crudo del actor en la forma que espera el orquestador (ver
 * platforms/index.js): la misma que produce el proveedor oficial, más
 * `followers` (del autor, si vino). Devuelve null para lo que no es un
 * posteo: sin id, sin url (ni code para armarla) o con noResults/error.
 *
 * `id` y `url` tienen que coincidir con las del actor oficial para que el
 * dedupe (detected_posts.id / url) y el refresco de métricas sigan
 * matcheando: se usan tal cual vienen (id numérico, url /p/{code}/).
 */
function normalizePost(raw, { account = null, sourceType, sourceQuery = null } = {}) {
  if (isNoResults(raw)) return null;
  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');
  const code = pick(raw.code, raw.shortCode, raw.shortcode);
  const id = raw.id !== undefined && raw.id !== null && String(raw.id).trim() !== '' ? String(raw.id).trim() : null;
  const url = pick(raw.url, code ? `https://www.instagram.com/p/${code}/` : null);
  if (!id || !url) return null;

  const owner = raw.owner && typeof raw.owner === 'object' ? raw.owner : {};
  const caption = typeof raw.caption === 'string' ? raw.caption : '';
  // owner.followerCount es del perfil consultado (ver encabezado): solo vale
  // si el autor del item es esa misma cuenta.
  const ownerName = pick(owner.username, raw.ownerUsername);
  const followersAreOwners = !account || !ownerName || String(ownerName).toLowerCase() === String(account).toLowerCase();
  return {
    id,
    account: pick(ownerName, account, 'N/D'),
    url,
    caption,
    hashtagsText: Array.isArray(raw.hashtags) && raw.hashtags.length > 0 ? raw.hashtags.join(' ') : extractHashtags(caption),
    likes: countOrNull(raw.likeCount),
    comments: countOrNull(raw.commentCount),
    postedAt: toIso(pick(raw.createdAt, raw.timestamp)),
    postType: derivePostType(raw),
    followers: followersAreOwners ? countOrNull(owner.followerCount) : null,
    sourceType,
    sourceQuery,
  };
}

/** normalizePost sobre toda la respuesta, descartando lo que no es un posteo. */
function normalizeItems(items, context) {
  return (Array.isArray(items) ? items : []).map((raw) => normalizePost(raw, context)).filter(Boolean);
}

/**
 * Descarta lo anterior a la ventana real (ahora − lookback), fijados
 * incluidos: `until` solo filtra por día. Sin lookback devuelve todo. Un
 * posteo sin fecha no puede probar que está en la ventana: se descarta.
 */
function applyWindow(posts, lookback, now = Date.now()) {
  const ms = parseLookbackMs(lookback);
  if (ms == null) return posts;
  const cutoff = now - ms;
  return posts.filter((p) => p.postedAt && new Date(p.postedAt).getTime() >= cutoff);
}

function buildInput(source, { resultsLimit, lookback }) {
  const input = { ...source, maxItems: maxItemsFor(resultsLimit) };
  const until = untilDateFor(lookback);
  if (until) input.until = until;
  return input;
}

/**
 * Posteos de una cuenta. Con lookback (detección): `until` + ventana real.
 * Sin lookback (benchmark y refresco): los últimos resultsLimit, sin fecha.
 * Una consulta de perfil (0,005 usd) con resultsLimit posteos incluidos
 * hasta 10; los de más se cobran aparte.
 */
async function scrapeAccount(username, { resultsLimit, lookback } = {}) {
  const items = await runActor(buildInput({ startUrls: [buildProfileUrl(username)] }, { resultsLimit, lookback }));
  return applyWindow(normalizeItems(items, { account: username, sourceType: 'account' }), lookback);
}

/** Posteos de la página del hashtag (descubrimiento: el orquestador filtra relevancia). Una consulta de hashtag (0,015 usd, 30 incluidos). */
async function scrapeHashtag(tag, { resultsLimit, lookback } = {}) {
  const items = await runActor(buildInput({ startUrls: [buildHashtagUrl(tag)] }, { resultsLimit, lookback }));
  return applyWindow(normalizeItems(items, { account: null, sourceType: 'hashtag' }), lookback);
}

/**
 * Búsqueda por palabra clave nativa de Instagram (keywords: [término]).
 * Una consulta de búsqueda (0,015 usd, 20 incluidos). Los resultados salen
 * con sourceType 'search' y el término en sourceQuery; la relevancia la
 * decide el orquestador igual que para un hashtag.
 */
async function scrapeSearch(term, { resultsLimit, lookback } = {}) {
  const clean = String(term || '').trim();
  const items = await runActor(buildInput({ keywords: [clean] }, { resultsLimit, lookback }));
  return applyWindow(normalizeItems(items, { account: null, sourceType: 'search', sourceQuery: clean }), lookback);
}

/**
 * Valida que la cuenta exista y sea pública antes de guardarla: una
 * consulta de perfil con maxItems 1 (0,005 usd). Un perfil inexistente,
 * privado o sin posteos devuelve una respuesta vacía o un item con
 * noResults, nunca un error HTTP.
 */
async function validateAccount(account) {
  const items = await runActor({ startUrls: [buildProfileUrl(account)], maxItems: 1 });
  const first = Array.isArray(items) ? items[0] : null;
  if (!first || isNoResults(first)) {
    const e = new Error(`Cuenta no encontrada: ${account}`);
    e.userMessage = `No encontramos la cuenta @${account} en Instagram. Revisá que esté bien escrita.`;
    throw e;
  }
}

/** Ídem para un hashtag: una consulta de hashtag con maxItems 1 (0,015 usd). */
async function validateHashtag(tag) {
  const items = await runActor({ startUrls: [buildHashtagUrl(tag)], maxItems: 1 });
  const first = Array.isArray(items) ? items[0] : null;
  if (!first || isNoResults(first)) {
    const e = new Error(`Hashtag no encontrado: ${tag}`);
    e.userMessage = `No encontramos contenido para el hashtag #${tag}. Revisá que esté bien escrito.`;
    throw e;
  }
}

/**
 * Con este actor los seguidores vienen en cada posteo (owner.followerCount)
 * y la caché se actualiza desde ahí en cualquier fase. No hay consulta
 * aparte: esto devuelve null sin llamar a Apify, y la cuenta conserva el
 * último valor conocido hasta que vuelva a devolver posteos.
 * @returns {Promise<null>}
 */
async function fetchAccountFollowers() {
  return null;
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
  scrapeSearch,
  normalizePost,
  normalizeItems,
  derivePostType,
  fetchAccountFollowers,
  // Expuestas para tests.
  parseLookbackMs,
  untilDateFor,
  applyWindow,
  isNoResults,
};
