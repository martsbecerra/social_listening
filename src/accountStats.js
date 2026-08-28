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
const { getPlatform } = require('./platforms');

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
// Tope de cuentas vencidas que recalcula CADA ciclo automático (ver
// refreshStaleAccountStats). Con 100-150 cuentas en el universo ampliado,
// si todas se calculan el mismo día (ej. la carga inicial), un mes después
// vencerían todas juntas y ese ciclo saldría carísimo — esto lo escalona.
const MAX_ACCOUNTS_PER_CYCLE = Number(process.env.MAX_ACCOUNTS_PER_CYCLE) || 10;

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
 * Universo de cuentas para las que calcular benchmark: la unión de las
 * trackeadas (config/monitoring.json) con TODAS las que ya aparecen en
 * detected_posts (llegaron por hashtag, nunca se trackearon a propósito).
 * Antes solo se calculaba para las trackeadas — el resto quedaba
 * permanentemente "sin referencia" sin importar cuántos posteos tuviera
 * guardados esa cuenta.
 *
 * Dedupe case-insensitive: si la misma cuenta aparece con distinta
 * capitalización en config vs. en un post, se conserva la forma de config
 * (viene primero en el array de entrada).
 * @returns {string[]}
 */
function buildAccountUniverse() {
  const { accounts: tracked } = monitor.loadConfig();
  const fromPosts = db.listDistinctPostAccounts();
  const seen = new Map(); // lowercase -> forma "canónica" (la primera vista)
  for (const account of [...tracked, ...fromPosts]) {
    if (!account) continue;
    const key = account.toLowerCase();
    if (!seen.has(key)) seen.set(key, account);
  }
  return [...seen.values()];
}

/**
 * Trae hasta BENCHMARK_POST_LIMIT posteos recientes de la cuenta (mismo
 * adapter de plataforma que ya usa el monitoreo — src/platforms/),
 * descarta los de más de 3 meses, agrupa por tipo de posteo y guarda una
 * mediana por grupo con 5 posteos o más. Los grupos con menos posteos no
 * generan fila (esa cuenta/tipo queda "sin referencia" al clasificar).
 *
 * Una sola pasada de Apify hace tres cosas a la vez (no se paga tres veces
 * por la misma cuenta):
 *   1. Benchmark (medianas) — lo de siempre.
 *   2. Seguidores — se cachean en account_followers Y se propagan a TODOS
 *      los posteos ya guardados de esa cuenta en detected_posts (antes solo
 *      quedaban en la caché, sin llegar nunca a la columna de la tabla).
 *   3. Cruce por id contra detected_posts: los posteos que trae este mismo
 *      scraping son en gran parte los mismos que ya están guardados —
 *      si sus likes/comments cambiaron desde que se detectaron, se
 *      actualizan acá "gratis", sin una corrida aparte.
 *
 * @param {string} account
 * @param {string} [platform]
 * @returns {Promise<{ account: string, platform: string, fetched: number, recent: number, groupsSaved: number, followersChecked: number, followersFound: boolean, postsUpdated: number }>}
 */
async function computeAccountStats(account, platform = PLATFORM) {
  const adapter = getPlatform(platform);
  const posts = await adapter.scrapeAccount(account, {
    resultsLimit: BENCHMARK_POST_LIMIT,
    lookback: undefined, // sin onlyPostsNewerThan: el filtro de 3 meses se hace acá abajo, no en el actor.
  });

  // Cruce por id: actualiza likes/comments/post_type de los posteos que YA
  // estaban guardados (post_type solo si les faltaba) desde el mismo
  // scraping — sin corrida aparte de Apify. No inserta nada nuevo (eso lo
  // hace runMonitoringCycle) y no toca los posteos guardados que no
  // vinieron en esta respuesta (quedan con su último valor conocido —
  // nunca se ponen en 0/NULL ni se borran).
  let postsUpdated = 0;
  for (const post of posts) {
    if (db.updatePostMetricsIfChanged(post.id, { likes: post.likes, comments: post.comments, postType: post.postType })) {
      postsUpdated += 1;
    }
  }

  // Seguidores: corrida aparte (resultsType "details"), no viene en los
  // items de "posts". fetchAccountFollowers ya nunca tira (devuelve null
  // sin token/cuenta privada/etc.), pero el try/catch queda igual acá: si
  // algo inesperado fallara guardando la caché, no tiene que tirar abajo el
  // cálculo del benchmark — la cuenta simplemente sigue sin seguidores
  // cacheados (columna en "-" hasta el próximo recálculo).
  let followersChecked = 0;
  let followersFound = false;
  try {
    const followers = await adapter.fetchAccountFollowers(account);
    if (followers != null) {
      db.upsertAccountFollowers({ account, platform, followers, updatedAt: new Date().toISOString() });
      db.updateFollowersForAccount(account, followers);
      followersFound = true;
    }
    followersChecked = 1;
  } catch (err) {
    console.error(`[accountStats] No se pudo traer seguidores de @${account}:`, err.message);
  }

  const cutoffMs = Date.now() - BENCHMARK_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const recent = posts.filter((p) => p.postedAt && new Date(p.postedAt).getTime() >= cutoffMs);

  // Solo tipos reales acá — un posteo sin post_type detectado NO forma su
  // propio grupo "sin tipo": contribuye únicamente a la fila global de abajo.
  // Esto deja post_type=NULL con un único significado en account_stats ("la
  // mediana de fallback, todos los tipos juntos"), sin ambigüedad con "tipo
  // desconocido".
  const groupsByType = new Map();
  for (const post of recent) {
    if (!post.postType) continue;
    if (!groupsByType.has(post.postType)) groupsByType.set(post.postType, []);
    groupsByType.get(post.postType).push(post);
  }

  const computedAt = new Date().toISOString();
  let groupsSaved = 0;

  const saveGroup = (postType, group) => {
    if (group.length < BENCHMARK_MIN_POSTS) return;
    db.upsertAccountStats({
      account,
      platform,
      postType,
      nPosts: group.length,
      // Sin Number(...) acá a propósito: p.likes/p.comments pueden ser null
      // (dato faltante, ej. el centinela -1 de Apify ya convertido a null en
      // normalizeMonitorPost). Number(null) da 0, un "cero" inventado que
      // Number.isFinite deja pasar y contaminaría la mediana; pasando el
      // valor crudo, median() lo descarta con su propio filter(Number.isFinite).
      medianLikes: median(group.map((p) => p.likes)),
      medianComments: median(group.map((p) => p.comments)),
      computedAt,
    });
    groupsSaved += 1;
  };

  for (const [postType, group] of groupsByType) saveGroup(postType, group);
  // Fila global de fallback (post_type NULL): la mediana de TODOS los
  // posteos recientes juntos, sin separar por tipo. Una referencia peor que
  // una por tipo, pero muchísimo mejor que "sin referencia" — cubre tanto
  // los posteos sin post_type propio como las cuentas/tipo sin 5 posteos
  // en ese tipo puntual. Mismo umbral BENCHMARK_MIN_POSTS.
  saveGroup(null, recent);

  return {
    account,
    platform,
    fetched: posts.length,
    recent: recent.length,
    groupsSaved,
    followersChecked,
    followersFound,
    postsUpdated,
  };
}

/**
 * Función pura (sin DB ni Apify) que decide qué cuentas tocan este ciclo:
 * filtra las vencidas (30+ días, o nunca calculada) y devuelve como mucho
 * `maxPerCycle`, empezando por la de computed_at más viejo (nunca calculada
 * cuenta como "la más vieja" posible). Separada de refreshStaleAccountStats
 * para poder probar el orden/tope con datos sintéticos, sin que las cuentas
 * reales que ya haya en la base compitan por los mismos lugares.
 *
 * @param {string[]} universe
 * @param {Map<string, string|null>} freshnessByAccount cuenta en minúscula -> lastComputedAt ISO o null
 * @param {number} staleThresholdMs
 * @param {number} maxPerCycle
 * @param {number} [now]
 * @returns {{ toProcess: {account:string, lastComputedAt:string|null}[], staleButCapped: number, freshCount: number }}
 */
function selectStaleAccountsForCycle(universe, freshnessByAccount, staleThresholdMs, maxPerCycle, now = Date.now()) {
  const withFreshness = universe.map((account) => ({
    account,
    lastComputedAt: freshnessByAccount.get(account.toLowerCase()) || null,
  }));
  const staleAccounts = withFreshness.filter(
    ({ lastComputedAt }) => !lastComputedAt || now - new Date(lastComputedAt).getTime() >= staleThresholdMs
  );
  // Nunca calculada (null) primero -> es la más "vieja" posible; el resto,
  // de más vieja a más nueva.
  staleAccounts.sort((a, b) => {
    if (!a.lastComputedAt && !b.lastComputedAt) return 0;
    if (!a.lastComputedAt) return -1;
    if (!b.lastComputedAt) return 1;
    return new Date(a.lastComputedAt) - new Date(b.lastComputedAt);
  });

  const toProcess = staleAccounts.slice(0, maxPerCycle);
  return {
    toProcess,
    staleButCapped: staleAccounts.length - toProcess.length,
    freshCount: withFreshness.length - staleAccounts.length,
  };
}

/**
 * Recorre el universo ampliado de cuentas (trackeadas + las que aparecen en
 * detected_posts) y recalcula las vencidas (30+ días, o ninguna fila
 * todavía), como mucho MAX_ACCOUNTS_PER_CYCLE por corrida — empezando por
 * las de computed_at más viejo (nunca calculada cuenta como "la más
 * vieja" posible). Pensada para llamarse en cada ciclo de monitoreo
 * (scheduler.js).
 *
 * El tope existe porque, si en algún momento se calculan muchas cuentas de
 * una (la carga inicial vía scripts/recalc-account-stats.js --todas), todas
 * vencerían juntas un mes después y ese ciclo automático saldría carísimo.
 * Las que quedan vencidas pero afuera del tope no se pierden: siguen siendo
 * las "más viejas" y quedan primeras en la cola del próximo ciclo.
 */
async function refreshStaleAccountStats() {
  const universe = buildAccountUniverse();
  const staleThresholdMs = BENCHMARK_RECALC_DAYS * 24 * 60 * 60 * 1000;

  const freshnessByAccount = new Map(
    db.getAllAccountStatsFreshness(PLATFORM).map((row) => [row.account.toLowerCase(), row.lastComputedAt])
  );

  const { toProcess, staleButCapped, freshCount } = selectStaleAccountsForCycle(
    universe,
    freshnessByAccount,
    staleThresholdMs,
    MAX_ACCOUNTS_PER_CYCLE
  );

  let recalculated = 0;
  let apifyResultsConsumed = 0;
  let followersChecked = 0;
  let postsUpdated = 0;

  for (const { account } of toProcess) {
    try {
      const result = await computeAccountStats(account, PLATFORM);
      recalculated += 1;
      apifyResultsConsumed += result.fetched;
      followersChecked += result.followersChecked;
      postsUpdated += result.postsUpdated;
    } catch (err) {
      console.error(`[accountStats] No se pudo recalcular @${account}:`, err.message);
    }
  }

  console.log(
    `[accountStats] ${recalculated}/${toProcess.length} cuentas recalculadas de un universo de ${universe.length} ` +
      `(${freshCount} al día` +
      (staleButCapped > 0 ? `, ${staleButCapped} vencidas pendientes para el próximo ciclo (tope ${MAX_ACCOUNTS_PER_CYCLE})` : '') +
      `), ${apifyResultsConsumed} resultados de Apify consumidos, ${followersChecked} consultas de seguidores, ` +
      `${postsUpdated} posteos actualizados`
  );

  return {
    recalculated,
    apifyResultsConsumed,
    followersChecked,
    postsUpdated,
    freshCount,
    staleButCapped,
    universeSize: universe.length,
  };
}

/** Todas las filas de account_stats en un Map, para clasificar N posteos sin hacer N queries. */
function buildAccountStatsMap() {
  const map = new Map();
  for (const row of db.listAllAccountStats()) {
    map.set(statsMapKey(row.account, row.platform, row.postType), row);
  }
  return map;
}

function classifyValue(value, medianValue, nPosts, basis) {
  if (value == null || !Number.isFinite(medianValue) || medianValue <= 0 || nPosts < BENCHMARK_MIN_POSTS) {
    return { level: 'sin-referencia', nPosts: nPosts || 0 };
  }
  const ratio = value / medianValue;
  const level = ratio < RATIO_LOW ? 'bajo' : ratio >= RATIO_HIGH ? 'alto' : 'normal';
  return { level, value, median: medianValue, ratio, nPosts, basis };
}

/**
 * Clasifica los likes/comentarios de un posteo contra la mediana de su
 * cuenta, en dos pasos:
 *   1. (cuenta, post_type exacto) — la referencia más precisa, si existe.
 *   2. Si no hay (el posteo no tiene tipo detectado, o esa cuenta no tiene
 *      5+ posteos recientes de ese tipo puntual): cae a (cuenta, NULL), la
 *      fila "global" que promedia todos los posteos recientes de la cuenta
 *      sin separar por tipo — peor referencia que por tipo, pero mucho
 *      mejor que nada.
 * "sin-referencia" solo si ni siquiera existe la fila global (cuenta nunca
 * calculada, o con menos de 5 posteos recientes en total).
 *
 * Cada métrica devuelve basis: 'tipo' | 'global' (ausente si sin-referencia),
 * para poder mostrar cuál referencia se usó.
 *
 * @param {{ account: string, platform?: string, postType?: string|null,
 *   likes: number|null, comments: number|null, statsMap?: Map }} params
 *   statsMap opcional (ver buildAccountStatsMap): evita una query por post
 *   cuando se clasifican muchos posteos seguidos (server.js).
 */
function classifyPostAgainstBenchmark({ account, platform = PLATFORM, postType = null, likes, comments, statsMap }) {
  const lookup = (pt) =>
    statsMap ? statsMap.get(statsMapKey(account || '', platform, pt)) : account ? db.getAccountStats(account, platform, pt) : null;

  let stats = null;
  let basis = null;
  if (postType) {
    stats = lookup(postType);
    if (stats) basis = 'tipo';
  }
  if (!stats) {
    stats = lookup(null);
    if (stats) basis = 'global';
  }
  const nPosts = stats ? stats.nPosts : 0;

  return {
    likes: classifyValue(likes, stats ? stats.medianLikes : null, nPosts, basis),
    comments: classifyValue(comments, stats ? stats.medianComments : null, nPosts, basis),
  };
}

module.exports = {
  BENCHMARK_POST_LIMIT,
  BENCHMARK_MIN_POSTS,
  BENCHMARK_MAX_AGE_DAYS,
  BENCHMARK_RECALC_DAYS,
  MAX_ACCOUNTS_PER_CYCLE,
  RATIO_LOW,
  RATIO_HIGH,
  median,
  buildAccountUniverse,
  selectStaleAccountsForCycle,
  computeAccountStats,
  refreshStaleAccountStats,
  buildAccountStatsMap,
  classifyPostAgainstBenchmark,
};
