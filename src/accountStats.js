// ==========================================================================
// accountStats.js
// --------------------------------------------------------------------------
// Benchmark de likes/comentarios por cuenta: cada cuenta se compara contra
// SU PROPIA mediana histórica (nunca contra otras cuentas ni contra
// seguidores — el alcance en Instagram depende del algoritmo, no de cuántos
// seguidores tiene la cuenta). Separado por tipo de posteo porque
// reels/carruseles/imágenes tienen distribuciones muy distintas entre sí.
//
// Mediana, no promedio: un solo posteo viral rompe el promedio y da una
// referencia falsa.
// ==========================================================================

const db = require('./db');
const monitor = require('./monitor');

// Plan gratuito de Apify: ~15 resultados por corrida. Al pasar a plan pago,
// subir esto en el .env alcanza — no hace falta tocar código.
const BENCHMARK_POST_LIMIT = Number(process.env.BENCHMARK_POST_LIMIT) || 15;
// Una mediana sobre menos de esto no significa nada.
const BENCHMARK_MIN_POSTS = 5;
// "Los últimos 3 meses".
const BENCHMARK_MAX_AGE_DAYS = 90;
// Recálculo mensual: los hábitos de una cuenta no cambian de una semana a
// la otra, y cada recálculo cuesta Apify.
const BENCHMARK_RECALC_DAYS = 30;
// Umbrales de clasificación (ratio = valor del posteo / mediana de la cuenta).
const RATIO_LOW = 0.5;
const RATIO_HIGH = 1.5;

const PLATFORM = 'instagram'; // única plataforma con scraping implementado hoy.

function median(numbers) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function statsMapKey(account, platform, postType) {
  return `${account.toLowerCase()}|${platform}|${postType || ''}`;
}

/**
 * Trae hasta BENCHMARK_POST_LIMIT posteos recientes de la cuenta (mismo
 * adapter que ya usa el monitoreo por cuenta — monitor.scrapeAccount),
 * descarta los de más de 3 meses, agrupa por tipo de posteo y guarda una
 * mediana por grupo con 5 posteos o más. Los grupos con menos posteos no
 * generan fila (esa cuenta/tipo queda "sin referencia" al clasificar).
 *
 * @param {string} account
 * @param {string} [platform]
 * @returns {Promise<{ account: string, platform: string, fetched: number, recent: number, groupsSaved: number }>}
 */
async function computeAccountStats(account, platform = PLATFORM) {
  const posts = await monitor.scrapeAccount(account, {
    resultsLimit: BENCHMARK_POST_LIMIT,
    lookback: undefined, // sin onlyPostsNewerThan: el filtro de 3 meses se hace acá abajo, no en el actor.
  });

  // Seguidores: corrida aparte (resultsType "details"), no viene en los
  // items de "posts". fetchAccountFollowers ya nunca tira (devuelve null
  // sin token/cuenta privada/etc.), pero el try/catch queda igual acá: si
  // algo inesperado fallara guardando la caché, no tiene que tirar abajo el
  // cálculo del benchmark — la cuenta simplemente sigue sin seguidores
  // cacheados (columna en "-" hasta el próximo recálculo).
  let followersChecked = 0;
  try {
    const followers = await monitor.fetchAccountFollowers(account);
    if (followers != null) {
      db.upsertAccountFollowers({ account, platform, followers, updatedAt: new Date().toISOString() });
    }
    followersChecked = 1;
  } catch (err) {
    console.error(`[accountStats] No se pudo traer seguidores de @${account}:`, err.message);
  }

  const cutoffMs = Date.now() - BENCHMARK_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const recent = posts.filter((p) => p.postedAt && new Date(p.postedAt).getTime() >= cutoffMs);

  const groups = new Map();
  for (const post of recent) {
    const key = post.postType || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }

  const computedAt = new Date().toISOString();
  let groupsSaved = 0;
  for (const [postType, group] of groups) {
    if (group.length < BENCHMARK_MIN_POSTS) continue;
    db.upsertAccountStats({
      account,
      platform,
      postType,
      nPosts: group.length,
      medianLikes: median(group.map((p) => Number(p.likes))),
      medianComments: median(group.map((p) => Number(p.comments))),
      computedAt,
    });
    groupsSaved += 1;
  }

  return { account, platform, fetched: posts.length, recent: recent.length, groupsSaved, followersChecked };
}

/**
 * Recorre las cuentas trackeadas y recalcula las que tienen 30+ días (o
 * ninguna fila todavía). Pensada para llamarse en cada ciclo de monitoreo
 * (scheduler.js) — la mayoría de las corridas no recalculan nada, es solo
 * una lectura de SQLite por cuenta.
 */
async function refreshStaleAccountStats() {
  const { accounts } = monitor.loadConfig();
  const staleThresholdMs = BENCHMARK_RECALC_DAYS * 24 * 60 * 60 * 1000;

  let recalculated = 0;
  let apifyResultsConsumed = 0;
  let followersChecked = 0;
  let skippedFresh = 0;

  for (const account of accounts) {
    const lastComputedAt = db.getAccountStatsFreshness(account, PLATFORM);
    if (lastComputedAt && Date.now() - new Date(lastComputedAt).getTime() < staleThresholdMs) {
      skippedFresh += 1;
      continue;
    }
    try {
      const result = await computeAccountStats(account, PLATFORM);
      recalculated += 1;
      apifyResultsConsumed += result.fetched;
      followersChecked += result.followersChecked;
    } catch (err) {
      console.error(`[accountStats] No se pudo recalcular @${account}:`, err.message);
    }
  }

  console.log(
    `[accountStats] ${recalculated} cuentas recalculadas, ${apifyResultsConsumed} resultados de Apify consumidos, ` +
      `${followersChecked} consultas de seguidores` +
      (skippedFresh > 0 ? ` (${skippedFresh} ya estaban al día)` : '')
  );

  return { recalculated, apifyResultsConsumed, followersChecked, skippedFresh };
}

/** Todas las filas de account_stats en un Map, para clasificar N posteos sin hacer N queries. */
function buildAccountStatsMap() {
  const map = new Map();
  for (const row of db.listAllAccountStats()) {
    map.set(statsMapKey(row.account, row.platform, row.postType), row);
  }
  return map;
}

function classifyValue(value, medianValue, nPosts) {
  if (value == null || !Number.isFinite(medianValue) || medianValue <= 0 || nPosts < BENCHMARK_MIN_POSTS) {
    return { level: 'sin-referencia', nPosts: nPosts || 0 };
  }
  const ratio = value / medianValue;
  const level = ratio < RATIO_LOW ? 'bajo' : ratio >= RATIO_HIGH ? 'alto' : 'normal';
  return { level, value, median: medianValue, ratio, nPosts };
}

/**
 * Clasifica los likes/comentarios de un posteo contra la mediana de su
 * cuenta (y su post_type, si lo tiene). "sin-referencia" si la cuenta no
 * tiene stats para ese post_type o tiene menos de 5 posteos de base — nunca
 * se inventa una clasificación sin datos.
 *
 * @param {{ account: string, platform?: string, postType?: string|null,
 *   likes: number|null, comments: number|null, statsMap?: Map }} params
 *   statsMap opcional (ver buildAccountStatsMap): evita una query por post
 *   cuando se clasifican muchos posteos seguidos (server.js).
 */
function classifyPostAgainstBenchmark({ account, platform = PLATFORM, postType = null, likes, comments, statsMap }) {
  const stats = statsMap
    ? statsMap.get(statsMapKey(account || '', platform, postType))
    : account
      ? db.getAccountStats(account, platform, postType)
      : null;
  const nPosts = stats ? stats.nPosts : 0;

  return {
    likes: classifyValue(likes, stats ? stats.medianLikes : null, nPosts),
    comments: classifyValue(comments, stats ? stats.medianComments : null, nPosts),
  };
}

module.exports = {
  BENCHMARK_POST_LIMIT,
  BENCHMARK_MIN_POSTS,
  BENCHMARK_MAX_AGE_DAYS,
  BENCHMARK_RECALC_DAYS,
  RATIO_LOW,
  RATIO_HIGH,
  median,
  computeAccountStats,
  refreshStaleAccountStats,
  buildAccountStatsMap,
  classifyPostAgainstBenchmark,
};
