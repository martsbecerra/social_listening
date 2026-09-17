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
//
// Multiplataforma: corre solo para las plataformas cuyo adapter declara
// capabilities.benchmark (hoy Instagram). Las demás no entran a la cola de
// recálculo — no se gasta una consulta para nada.
//
// Cuándo se (re)calcula una cuenta — SOLO cuando aparece en el monitoreo:
// hace falta que se haya guardado un posteo suyo en detected_posts y que,
// además, la cuenta nunca se haya calculado o ese posteo se haya detectado
// BENCHMARK_RECALC_DAYS o más días después del último cálculo. Da igual si
// la cuenta es trackeada o llegó por hashtag: scrapear una trackeada sin
// guardar ningún posteo relevante no dispara nada, y una cuenta que no
// vuelve a aparecer conserva su mediana tal cual, sin volver a pagarla.
// La condición sale de la base (detected_at vs. computed_at, ver
// db.listAccountBenchmarkActivity), no de estado en memoria.
// ==========================================================================

const db = require('./db');
const monitor = require('./monitor');
const { getPlatform, listPlatformIds } = require('./platforms');

// Plan gratuito de Apify: ~15 resultados por corrida. Al pasar a plan pago,
// subir esto en Infisical alcanza — no hace falta tocar código.
const BENCHMARK_POST_LIMIT = Number(process.env.BENCHMARK_POST_LIMIT) || 15;
// Una mediana sobre menos de esto no significa nada.
const BENCHMARK_MIN_POSTS = 5;
// "Los últimos 3 meses".
const BENCHMARK_MAX_AGE_DAYS = 90;
// Cuántos días tienen que pasar desde el último cálculo para que un posteo
// nuevo de la cuenta dispare un recálculo. Los hábitos de una cuenta no
// cambian de una semana a la otra y cada recálculo cuesta una consulta a
// la fuente. Es también la cadencia máxima con la que se refrescan los
// seguidores (van en la misma pasada).
const BENCHMARK_RECALC_DAYS = Number(process.env.BENCHMARK_RECALC_DAYS) || 90;
// Umbrales de clasificación (ratio = valor del posteo / mediana de la cuenta).
const RATIO_LOW = 0.5;
const RATIO_HIGH = 1.5;
// Tope de cuentas que recalcula CADA ciclo automático (ver
// refreshStaleAccountStats). Si en un ciclo aparecen muchas cuentas con
// recálculo pendiente (ej. un hashtag nuevo trae 30 cuentas desconocidas),
// esto lo escalona; las que quedan afuera siguen elegibles y salen en los
// ciclos siguientes, en orden de llegada.
const MAX_ACCOUNTS_PER_CYCLE = Number(process.env.MAX_ACCOUNTS_PER_CYCLE) || 10;

// Plataforma por defecto de las funciones de una sola cuenta (script de
// recálculo, llamadas sin plataforma explícita).
const PLATAFORMA = 'instagram';

function median(numbers) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function statsMapKey(account, plataforma, postType) {
  return `${account.toLowerCase()}|${plataforma}|${postType || ''}`;
}

/** Plataformas del registro que tienen benchmark, opcionalmente acotadas a un subconjunto. */
function benchmarkPlatformIds(plataformas) {
  return listPlatformIds().filter((id) => {
    if (plataformas && !plataformas.includes(id)) return false;
    const { capabilities } = getPlatform(id);
    return Boolean(capabilities && capabilities.benchmark);
  });
}

/**
 * Universo de cuentas de UNA plataforma para la carga manual
 * (scripts/recalc-account-stats.js --todas): la unión de las trackeadas
 * (config/monitoring.json) con TODAS las que ya aparecen en detected_posts
 * de esa plataforma (llegaron por hashtag, nunca se trackearon a propósito).
 * El ciclo automático NO recorre este universo: solo recalcula las cuentas
 * que aparecen con posteos nuevos (ver refreshStaleAccountStats).
 *
 * Dedupe case-insensitive: si la misma cuenta aparece con distinta
 * capitalización en config vs. en un post, se conserva la forma de config
 * (viene primero en el array de entrada).
 * @param {string} [plataforma]
 * @returns {string[]}
 */
function buildAccountUniverse(plataforma = PLATAFORMA) {
  const { accounts: tracked } = monitor.loadConfig(plataforma);
  const fromPosts = db.listDistinctPostAccounts(plataforma);
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
 * Una sola pasada de la fuente hace tres cosas a la vez (no se paga tres
 * veces por la misma cuenta):
 *   1. Benchmark (medianas) — lo de siempre.
 *   2. Seguidores (si la plataforma los expone) — se cachean en
 *      account_followers Y se propagan a TODOS los posteos ya guardados de
 *      esa cuenta en detected_posts.
 *   3. Cruce por id contra detected_posts: los posteos que trae este mismo
 *      scraping son en gran parte los mismos que ya están guardados —
 *      si sus likes/comments cambiaron desde que se detectaron, se
 *      actualizan acá "gratis", sin una corrida aparte.
 *
 * En una plataforma sin benchmark no hace nada (devuelve skipped: true):
 * no se gasta una consulta que después no se puede usar.
 *
 * Si la pasada no trae 5 posteos recientes (la cuenta publica poco, está
 * privada, o la fuente devolvió vacío), el intento igual deja marca: se
 * escribe la fila global con el n_posts real (< 5, incluso 0: clasifica
 * "sin referencia" igual que antes) solo si la cuenta no tenía fila global;
 * si ya tenía una referencia, se conserva tal cual y solo avanza su
 * computed_at (attemptOnly: true). Sin la marca, la cuenta volvería a la
 * cola de recálculo en cada ciclo en que tenga un posteo.
 *
 * @param {string} account
 * @param {string} [plataforma]
 * @returns {Promise<{ account: string, plataforma: string, fetched: number, recent: number, groupsSaved: number, attemptOnly: boolean, referenceKept: boolean, followersChecked: number, followersFound: boolean, postsUpdated: number, skipped?: boolean }>}
 */
async function computeAccountStats(account, plataforma = PLATAFORMA) {
  const adapter = getPlatform(plataforma);
  const capabilities = adapter.capabilities || {};
  if (!capabilities.benchmark) {
    console.log(`[accountStats] ${plataforma} no tiene benchmark: no se calcula nada para @${account}.`);
    return { account, plataforma, fetched: 0, recent: 0, groupsSaved: 0, attemptOnly: false, referenceKept: false, followersChecked: 0, followersFound: false, postsUpdated: 0, skipped: true };
  }

  const posts = await adapter.scrapeAccount(account, {
    resultsLimit: BENCHMARK_POST_LIMIT,
    lookback: undefined, // sin filtro de fecha en la fuente: el filtro de 3 meses se hace acá abajo.
  });

  // Cruce por id: actualiza likes/comments/post_type de los posteos que YA
  // estaban guardados (post_type solo si les faltaba) desde el mismo
  // scraping — sin corrida aparte. No inserta nada nuevo (eso lo hace
  // runMonitoringCycle) y no toca los posteos guardados que no vinieron en
  // esta respuesta (quedan con su último valor conocido — nunca se ponen en
  // 0/NULL ni se borran).
  let postsUpdated = 0;
  for (const post of posts) {
    if (db.updatePostMetricsIfChanged(post.id, { likes: post.likes, comments: post.comments, postType: post.postType })) {
      postsUpdated += 1;
    }
  }

  // Seguidores: solo si la plataforma los expone. fetchAccountFollowers ya
  // nunca tira (devuelve null sin token/cuenta privada/etc.), pero el
  // try/catch queda igual acá: si algo inesperado fallara guardando la
  // caché, no tiene que tirar abajo el cálculo del benchmark — la cuenta
  // simplemente sigue sin seguidores cacheados (columna en "-" hasta el
  // próximo recálculo).
  let followersChecked = 0;
  let followersFound = false;
  if (capabilities.followers) {
    try {
      const followers = await adapter.fetchAccountFollowers(account);
      if (followers != null) {
        db.upsertAccountFollowers({ account, plataforma, followers, updatedAt: new Date().toISOString() });
        db.updateFollowersForAccount(account, followers, plataforma);
        followersFound = true;
      }
      followersChecked = 1;
    } catch (err) {
      console.error(`[accountStats] No se pudo traer seguidores de @${account}:`, err.message);
    }
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
  let attemptOnly = false; // no hubo 5 posteos recientes: solo quedó la marca del intento
  let referenceKept = false; // ...y había una referencia previa que se conservó

  const statsRow = (postType, group) => ({
    account,
    plataforma,
    postType,
    nPosts: group.length,
    // Sin Number(...) acá a propósito: p.likes/p.comments pueden ser null
    // (dato faltante, ej. el centinela -1 de Apify ya convertido a null en
    // normalizePost). Number(null) da 0, un "cero" inventado que
    // Number.isFinite deja pasar y contaminaría la mediana; pasando el
    // valor crudo, median() lo descarta con su propio filter(Number.isFinite).
    medianLikes: median(group.map((p) => p.likes)),
    medianComments: median(group.map((p) => p.comments)),
    computedAt,
  });

  for (const [postType, group] of groupsByType) {
    if (group.length < BENCHMARK_MIN_POSTS) continue;
    db.upsertAccountStats(statsRow(postType, group));
    groupsSaved += 1;
  }

  // Fila global de fallback (post_type NULL): la mediana de TODOS los
  // posteos recientes juntos, sin separar por tipo. Una referencia peor que
  // una por tipo, pero muchísimo mejor que "sin referencia" — cubre tanto
  // los posteos sin post_type propio como las cuentas/tipo sin 5 posteos
  // en ese tipo puntual. Mismo umbral BENCHMARK_MIN_POSTS para que valga
  // como referencia. Es además la marca de "último cálculo" de la cuenta
  // (db.listAccountBenchmarkActivity la lee), así que se escribe o se toca
  // en TODOS los intentos, con datos suficientes o sin ellos.
  if (recent.length >= BENCHMARK_MIN_POSTS) {
    db.upsertAccountStats(statsRow(null, recent));
    groupsSaved += 1;
  } else if (!db.getAccountStats(account, plataforma, null)) {
    // Sin datos suficientes y sin referencia previa: fila global con el
    // n_posts real (< 5). classifyValue la trata como "sin referencia".
    db.upsertAccountStats(statsRow(null, recent));
    attemptOnly = true;
  } else {
    // Sin datos suficientes pero con una referencia previa: no se pisa una
    // mediana válida con una muestra vacía o chica (una cuenta privada de
    // paso o un hipo de la fuente dejaría 90 días de "sin referencia" en
    // toda la tabla). Solo avanza la fecha para que el intento cuente.
    db.touchAccountStatsComputedAt(account, plataforma, computedAt);
    attemptOnly = true;
    referenceKept = true;
  }

  return {
    account,
    plataforma,
    fetched: posts.length,
    recent: recent.length,
    groupsSaved,
    attemptOnly,
    referenceKept,
    followersChecked,
    followersFound,
    postsUpdated,
  };
}

/**
 * Función pura (sin DB, sin fuente, sin reloj) que decide qué cuentas se
 * recalculan este ciclo a partir de lo que devuelve
 * db.listAccountBenchmarkActivity: las que tienen `eligibleSince`, en
 * orden de llegada (la que se volvió elegible primero sale primero) y como
 * mucho `maxPerCycle`. Por eso una cuenta que quedó afuera por el tope sale
 * en el ciclo siguiente antes que cualquiera que se volvió elegible
 * después, aunque en el medio aparezcan muchas cuentas nuevas. Separada de
 * refreshStaleAccountStatsFor para poder probar orden y tope con datos
 * sintéticos.
 *
 * @param {{account:string, lastDetectedAt:string, lastComputedAt:string|null, eligibleSince:string|null}[]} activityRows
 * @param {number} maxPerCycle
 * @returns {{ toProcess: object[], deferred: number, upToDate: number }}
 */
function selectAccountsForRecalc(activityRows, maxPerCycle) {
  const eligible = activityRows
    .filter((row) => Boolean(row.eligibleSince))
    .sort((a, b) => (a.eligibleSince < b.eligibleSince ? -1 : a.eligibleSince > b.eligibleSince ? 1 : a.account.localeCompare(b.account)));
  const toProcess = eligible.slice(0, Math.max(0, maxPerCycle));
  return {
    toProcess,
    deferred: eligible.length - toProcess.length,
    upToDate: activityRows.length - eligible.length,
  };
}

/**
 * Recalcula, para UNA plataforma, las cuentas que aparecieron con un posteo
 * nuevo en detected_posts y nunca se calcularon o cuyo último cálculo tiene
 * BENCHMARK_RECALC_DAYS o más días al momento de detectar ese posteo. Como
 * mucho `maxPerCycle` por corrida, en orden de llegada. Ver
 * refreshStaleAccountStats.
 */
async function refreshStaleAccountStatsFor(plataforma, { maxPerCycle = MAX_ACCOUNTS_PER_CYCLE } = {}) {
  const activity = db.listAccountBenchmarkActivity(plataforma, BENCHMARK_RECALC_DAYS);
  const { toProcess, deferred, upToDate } = selectAccountsForRecalc(activity, maxPerCycle);

  let recalculated = 0;
  let attemptsOnly = 0;
  let resultsConsumed = 0;
  let followersChecked = 0;
  let postsUpdated = 0;
  const recalculatedAccounts = [];

  for (const { account } of toProcess) {
    try {
      const result = await computeAccountStats(account, plataforma);
      recalculated += 1;
      if (result.attemptOnly) attemptsOnly += 1;
      resultsConsumed += result.fetched;
      followersChecked += result.followersChecked;
      postsUpdated += result.postsUpdated;
      recalculatedAccounts.push(account);
    } catch (err) {
      console.error(`[accountStats] (${plataforma}) No se pudo recalcular @${account}:`, err.message);
    }
  }

  console.log(
    `[accountStats] (${plataforma}) ${activity.length} cuentas con posteos: ${recalculated}/${toProcess.length} recalculadas` +
      (attemptsOnly > 0 ? ` (${attemptsOnly} sin datos suficientes: solo quedó la marca del intento)` : '') +
      `, ${upToDate} al día` +
      (deferred > 0 ? `, ${deferred} quedan para el próximo ciclo (tope ${maxPerCycle})` : '') +
      `; ${resultsConsumed} resultados consumidos, ${followersChecked} consultas de seguidores, ` +
      `${postsUpdated} posteos actualizados`
  );

  return {
    recalculated,
    attemptsOnly,
    resultsConsumed,
    followersChecked,
    postsUpdated,
    upToDate,
    deferred,
    withPosts: activity.length,
    recalculatedAccounts,
  };
}

/**
 * Recalcula el benchmark de las cuentas que lo necesitan en cada plataforma
 * con esa capability (opcionalmente solo las de `plataformas`). Pensada
 * para llamarse en cada ciclo de monitoreo (scheduler.js), DESPUÉS de
 * guardar los posteos nuevos: así el posteo de una cuenta nueva sale con
 * benchmark en ese mismo ciclo. "Actualizar ahora" en una solapa sin
 * benchmark no dispara ninguna consulta.
 *
 * Solo entran las cuentas que aparecieron con un posteo nuevo (ver el
 * encabezado del archivo). El tope por ciclo escalona el gasto cuando
 * aparecen muchas de golpe; las que quedan afuera siguen elegibles (la
 * condición vive en la base) y salen en los ciclos siguientes, en orden
 * de llegada.
 *
 * Devuelve `recalculatedAccounts` por plataforma para que el scheduler las
 * excluya del refresco de métricas de ese mismo ciclo: computeAccountStats
 * ya actualizó sus posteos con la misma pasada, no hay que pagarla dos
 * veces.
 *
 * @param {{ plataformas?: string[], maxPerCycle?: number }} [options]
 *   maxPerCycle: tope por plataforma (default MAX_ACCOUNTS_PER_CYCLE).
 */
async function refreshStaleAccountStats({ plataformas, maxPerCycle = MAX_ACCOUNTS_PER_CYCLE } = {}) {
  const totals = {
    recalculated: 0,
    attemptsOnly: 0,
    resultsConsumed: 0,
    followersChecked: 0,
    postsUpdated: 0,
    upToDate: 0,
    deferred: 0,
    withPosts: 0,
    recalculatedAccounts: {},
    porPlataforma: {},
  };
  for (const plataforma of benchmarkPlatformIds(plataformas)) {
    const result = await refreshStaleAccountStatsFor(plataforma, { maxPerCycle });
    totals.porPlataforma[plataforma] = result;
    totals.recalculatedAccounts[plataforma] = result.recalculatedAccounts;
    for (const key of ['recalculated', 'attemptsOnly', 'resultsConsumed', 'followersChecked', 'postsUpdated', 'upToDate', 'deferred', 'withPosts']) {
      totals[key] += result[key];
    }
  }
  return totals;
}

/** Todas las filas de account_stats en un Map, para clasificar N posteos sin hacer N queries. */
function buildAccountStatsMap() {
  const map = new Map();
  for (const row of db.listAllAccountStats()) {
    map.set(statsMapKey(row.account, row.plataforma, row.postType), row);
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
 * @param {{ account: string, plataforma?: string, postType?: string|null,
 *   likes: number|null, comments: number|null, statsMap?: Map }} params
 *   statsMap opcional (ver buildAccountStatsMap): evita una query por post
 *   cuando se clasifican muchos posteos seguidos (server.js).
 */
function classifyPostAgainstBenchmark({ account, plataforma = PLATAFORMA, postType = null, likes, comments, statsMap }) {
  const lookup = (pt) =>
    statsMap ? statsMap.get(statsMapKey(account || '', plataforma, pt)) : account ? db.getAccountStats(account, plataforma, pt) : null;

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
  benchmarkPlatformIds,
  buildAccountUniverse,
  selectAccountsForRecalc,
  computeAccountStats,
  refreshStaleAccountStats,
  buildAccountStatsMap,
  classifyPostAgainstBenchmark,
};
