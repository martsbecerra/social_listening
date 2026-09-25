// ==========================================================================
// platforms/x.js — Adapter de X para el monitoreo (Grok X Search, no Apify).
// --------------------------------------------------------------------------
// Mismo contrato que instagram.js (ver platforms/index.js). Todo lo específico
// de X vive acá: cómo se buscan posteos (Grok con búsqueda en X, vía
// OpenRouter o xAI directo — ver src/x/grokFetch.js), cómo se normalizan,
// qué métricas expone y qué NO sabe hacer todavía (seguidores, benchmark,
// refresco de métricas — ver capabilities).
//
// La clasificación de relevancia / título / sentimiento NO es del adapter:
// la hace el orquestador con src/classifier.js, igual que para Instagram.
// Grok acá solo extrae posteos.
//
// Diferencia semántica con Instagram: en X TODO es una búsqueda por término.
// No hay "página del hashtag" que recorrer (como instagram.com/explore/tags),
// así que scrapeHashtag busca "#tag" exactamente igual que scrapeKeyword
// busca "Jorge Macri", y las dos devuelven posteos con sourceType 'keyword':
// para el orquestador eso significa "resultado de una búsqueda que ya lo
// validó" (relevante sin que el clasificador decida; solo título y
// sentimiento). Instagram no ofrece scrapeKeyword: ahí las keywords planas
// son solo un filtro de texto sobre lo que ya se scrapeó, y sus hashtags
// (sourceType 'hashtag') son descubrimiento que hay que filtrar.
//
// Errores: los que salen de Grok con `code` (AUTH_INVALID, RATE_LIMITED,
// QUOTA_EXCEEDED, NOT_CONFIGURED — ver src/x/grokFetch.js) suben tal cual;
// el orquestador los trata como error de plataforma (platforms/errors.js).
// ==========================================================================

// Objeto del módulo (no destructurado) para que los tests puedan stubear
// callGrokJson y ejercitar scrapeAccount/scrapeHashtag/scrapeKeyword reales.
const grokFetch = require('../x/grokFetch');
const { parseCount } = require('../x/parseCount');
const {
  parseXPostUrl,
  canonicalizeStatusUrl,
  statusUrl,
  cleanHandle,
  profileUrl,
  HANDLE_RE,
} = require('../x/url');

const PLATFORM_ID = 'x';

/**
 * Tope de posteos por fuente en cada búsqueda. Es propio de X
 * (X_MONITOR_RESULTS_LIMIT, default 30, máximo 50): el MONITOR_RESULTS_LIMIT
 * global del orquestador está pensado para Apify y acá se ignora.
 */
function resultsLimit() {
  const n = Number(process.env.X_MONITOR_RESULTS_LIMIT || 30);
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.round(n)) : 30;
}

function isConfigured() {
  return Boolean((process.env.OPENROUTER_API_KEY || '').trim() || (process.env.XAI_API_KEY || '').trim());
}

/**
 * Traduce el lookback del orquestador ("1 day", "12 hours"; undefined = sin
 * límite de fecha) al texto que entiende el prompt de búsqueda.
 */
function lookbackText(lookback) {
  if (!lookback) return 'sin restricción de fecha, los más recientes primero';
  const m = String(lookback).trim().match(/^(\d+)\s*(day|days|hour|hours|week|weeks)$/i);
  if (!m) return `de los últimos ${String(lookback).trim()}`;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('hour')) return n === 1 ? 'de la última hora' : `de las últimas ${n} horas`;
  if (unit.startsWith('week')) return n === 1 ? 'de la última semana' : `de las últimas ${n} semanas`;
  return n === 1 ? 'de las últimas 24 horas' : `de los últimos ${n} días`;
}

function buildSearchPrompt(query, limit, lookback) {
  return `Usá X Search para encontrar hasta ${limit} posteos recientes (${lookbackText(lookback)}) de X.

Búsqueda: ${query}

Devolvé ÚNICAMENTE un JSON válido (sin markdown) con esta forma:
{
  "posts": [
    {
      "id": "id numérico del tweet",
      "url": "https://x.com/handle/status/id",
      "authorHandle": "sin @",
      "text": "texto del posteo",
      "likes": 0,
      "retweets": 0,
      "replies": 0,
      "views": 0,
      "createdAt": "ISO-8601 o vacío"
    }
  ]
}

Reglas:
- Solo posteos originales, no replies.
- Números enteros, sin sufijos K/M.
- url canónica https://x.com/{handle}/status/{id} (no t.co ni i/web/status).
- Si no hay resultados, posts debe ser [].`;
}

/**
 * Solo validación de formato, sin red: un modelo no puede afirmar que una
 * cuenta NO existe, y una búsqueda de Grok para "verificar" cuesta lo mismo
 * que una corrida real. El orquestador ya sacó el "@" y los espacios.
 */
async function validateAccount(account) {
  const clean = cleanHandle(account);
  if (!clean || !HANDLE_RE.test(clean)) {
    const e = new Error('Handle de X inválido');
    e.userMessage = 'Escribí un usuario de X válido (hasta 15 caracteres, letras, números o _).';
    throw e;
  }
}

/** En X un hashtag es solo un término de búsqueda: no hay página que validar. */
async function validateHashtag(tag) {
  if (!String(tag || '').trim()) {
    const e = new Error('Hashtag vacío');
    e.userMessage = 'Escribí un hashtag.';
    throw e;
  }
}

/**
 * Deja un item crudo de la búsqueda de Grok en el formato que espera el
 * orquestador (mismos campos que instagram.normalizePost, más retweets y
 * views). Mantiene EXACTAMENTE el id `x:{tweetId}` y la URL canónica que
 * venían guardándose: findExistingPostId dedupea por id o url, y cambiarlos
 * haría re-detectar (y re-clasificar) todo lo ya conocido.
 *
 * sourceQuery es el término que originó la búsqueda ("Jorge Macri", "#CABA";
 * null para cuentas), para que el motivo de detección sea legible.
 */
function normalizePost(raw, { account, sourceType, sourceQuery = null }) {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = parseXPostUrl(String(raw.url || ''));
  const tweetId = String(parsed?.id || raw.id || '').replace(/\D/g, '');
  if (!tweetId) return null;
  const handle = cleanHandle(raw.authorHandle || parsed?.handle || account) || account || 'N/D';
  const url = canonicalizeStatusUrl(raw.url, handle, tweetId) || statusUrl(handle, tweetId);
  if (!url) return null;
  return {
    id: `x:${tweetId}`,
    account: handle,
    url,
    caption: typeof raw.text === 'string' ? raw.text : '',
    // X no separa hashtags del texto: van adentro del caption.
    hashtagsText: '',
    likes: parseCount(raw.likes),
    // Las respuestas de X ocupan el lugar de los comentarios de Instagram.
    comments: parseCount(raw.replies),
    retweets: parseCount(raw.retweets),
    views: parseCount(raw.views),
    postedAt: raw.createdAt || null,
    // Sin tipos de posteo en X: el benchmark (cuando exista) usa la fila global.
    postType: null,
    sourceType,
    sourceQuery,
  };
}

async function searchPosts(query, { account, sourceType, sourceQuery, lookback }) {
  const { parsed } = await grokFetch.callGrokJson(buildSearchPrompt(query, resultsLimit(), lookback), { maxTokens: 8000 });
  const rows = Array.isArray(parsed?.posts) ? parsed.posts : [];
  return rows.map((raw) => normalizePost(raw, { account, sourceType, sourceQuery })).filter(Boolean);
}

/**
 * Últimos posteos de una cuenta (búsqueda from:handle). El resultsLimit del
 * orquestador se ignora a propósito (ver resultsLimit()); el lookback sí se
 * respeta, traducido al prompt.
 */
async function scrapeAccount(handle, { lookback } = {}) {
  const clean = cleanHandle(handle);
  return searchPosts(`from:${clean}`, { account: clean, sourceType: 'account', sourceQuery: null, lookback });
}

/**
 * Búsqueda del término "#tag". En X no es una página de descubrimiento sino
 * una búsqueda más, así que el resultado sale como sourceType 'keyword'
 * (relevante sin que el clasificador decida, igual que scrapeKeyword) con el "#" en
 * sourceQuery para que el motivo diga "Búsqueda por hashtag".
 */
async function scrapeHashtag(tag, { lookback } = {}) {
  const clean = String(tag || '').trim().replace(/^#/, '');
  return searchPosts(`#${clean}`, { account: null, sourceType: 'keyword', sourceQuery: `#${clean}`, lookback });
}

/**
 * Búsqueda literal de una keyword sin "#" (por ejemplo "Jorge Macri").
 * Opcional en el contrato: el orquestador la usa solo si el adapter la
 * ofrece. Un posteo que llega por acá ya fue "validado" por la búsqueda:
 * el orquestador no le pide al clasificador que decida relevancia, solo
 * título y sentimiento.
 */
async function scrapeKeyword(keyword, { lookback } = {}) {
  const clean = String(keyword || '').trim();
  return searchPosts(clean, { account: null, sourceType: 'keyword', sourceQuery: clean, lookback });
}

/**
 * X no expone seguidores por esta vía (la búsqueda de Grok no los trae y
 * pedirlos aparte costaría una llamada por cuenta). capabilities.followers
 * está en false para que nadie lo intente; esto queda por contrato.
 * @returns {Promise<null>}
 */
async function fetchAccountFollowers() {
  return null;
}

module.exports = {
  id: PLATFORM_ID,
  label: 'X',
  /**
   * benchmark: false — pendiente. Hay datos para calcularlo (likes, respuestas,
   * RTs y vistas por posteo, y account_stats acepta filas de X sin post_type),
   * pero calcular la mediana por cuenta implicaría una búsqueda de Grok por
   * cuenta y sumar medianas de RTs/vistas. Queda como follow-up (ver README).
   * followers: false — ver fetchAccountFollowers.
   * metricsRefresh: false — el único refresco que tiene X es el gratuito del
   * propio ciclo (posteos conocidos que vuelven a aparecer en la búsqueda).
   */
  // En X la detección sí consulta cuentas (from:handle) y hashtags (una
  // búsqueda más), además de las keywords: X quedó fuera del cambio de
  // septiembre 2026 que dejó a Instagram solo con las búsquedas.
  capabilities: { benchmark: false, followers: false, metricsRefresh: false, detectAccounts: true, detectHashtags: true },
  isConfigured,
  validateAccount,
  validateHashtag,
  scrapeAccount,
  scrapeHashtag,
  scrapeKeyword,
  normalizePost,
  buildProfileUrl: profileUrl,
  fetchAccountFollowers,
  // Expuestos para tests.
  resultsLimit,
  buildSearchPrompt,
  /**
   * Métricas de un posteo de X. Los labels son los que el frontend muestra
   * hoy para X; `comments` son las respuestas. `primary` en likes conserva el
   * orden por defecto de la tabla.
   */
  metrics: [
    { key: 'likes', label: 'Likes', primary: true },
    { key: 'comments', label: 'Resp.', primary: false },
    { key: 'retweets', label: 'RTs', primary: false },
    { key: 'views', label: 'Vistas', primary: false },
  ],
};
