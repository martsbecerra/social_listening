// ==========================================================================
// metricsRefresh.js
// --------------------------------------------------------------------------
// Refresca las métricas de posteos YA detectados — nunca re-detecta, nunca
// re-clasifica sentimiento/relevancia (misma fila, mismo id, mismo título).
//
// Agrupado por cuenta, no por posteo: la fuente cobra por resultado
// devuelto, y pedir "los últimos N posteos" de una cuenta trae la misma
// cantidad de resultados sin importar a cuántos de esos posteos les tocaba
// refrescar. Una sola llamada por cuenta cubre todos sus posteos
// pendientes, de cualquier tramo, aunque solo uno haya disparado la
// inclusión de la cuenta.
//
// Tres tramos por antigüedad (ver posted_at):
//   - Caliente (< REFRESH_HOT_HOURS): sin cadencia propia, el cron de 4hs
//     que llama a refreshPostMetrics ya es la cadencia.
//   - Tibio (REFRESH_HOT_HOURS a REFRESH_WARM_DAYS): gateado dos veces —
//     a nivel de tramo (no se evalúa nada si no pasó REFRESH_WARM_EVERY_HOURS
//     desde el último pase, marca persistida en refresh_state) y a nivel de
//     posteo (metrics_updated_at contra esa misma cadencia).
//   - Frío (REFRESH_WARM_DAYS a REFRESH_COLD_MAX_DAYS): barrido semanal,
//     gateado solo a nivel de tramo (refresh_state, REFRESH_COLD_EVERY_DAYS).
//     Más viejo que REFRESH_COLD_MAX_DAYS: congelado, ninguna consulta lo toca.
//
// Multiplataforma: corre por cada plataforma cuyo adapter declara
// capabilities.metricsRefresh (hoy Instagram), con sus propias marcas de
// tramo y su propia cola. Las métricas que se escriben son las que declara
// el adapter (pickMetrics del orquestador).
//
// runMonitoringCycle (monitor.js) ya refresca gratis los posteos conocidos
// que aparecen en su propio scraping — las cuentas trackeadas que acaba de
// consultar se excluyen acá vía skipAccounts, para no pagarlas dos veces.
// ==========================================================================

const db = require('./db');
const progress = require('./monitoringProgress');
const { getPlatform, listPlatformIds } = require('./platforms');
const { isQuotaExceeded } = require('./platforms/errors');
const { createLimiter } = require('./concurrencyLimiter');
const { BENCHMARK_POST_LIMIT } = require('./accountStats');
const { pickMetrics, rememberFollowers } = require('./monitor');
const { checkAndLogJump } = require('./viralJumpDetector');

const REFRESH_HOT_HOURS = Number(process.env.REFRESH_HOT_HOURS) || 48;
const REFRESH_WARM_DAYS = Number(process.env.REFRESH_WARM_DAYS) || 7;
const REFRESH_WARM_EVERY_HOURS = Number(process.env.REFRESH_WARM_EVERY_HOURS) || 24;
const REFRESH_COLD_EVERY_DAYS = Number(process.env.REFRESH_COLD_EVERY_DAYS) || 7;
const REFRESH_COLD_MAX_DAYS = Number(process.env.REFRESH_COLD_MAX_DAYS) || 60;
const MAX_ACCOUNTS_PER_REFRESH = Number(process.env.MAX_ACCOUNTS_PER_REFRESH) || 30;

// Limitador PROPIO del nivel "cuenta" del refresco — nunca el apifyLimiter
// de src/apify.js (mismo motivo que benchmarkLimiter en accountStats.js: un
// deadlock real si compartiera instancia con runActorSync, ver Cambio G).
const refreshLimiter = createLimiter(Number(process.env.APIFY_MAX_CONCURRENT) || 3, 'refresco');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hoursAgoIso(hours, now) {
  return new Date(now - hours * HOUR_MS).toISOString();
}
function daysAgoIso(days, now) {
  return new Date(now - days * DAY_MS).toISOString();
}

function sumPostCount(rows) {
  return rows.reduce((sum, r) => sum + r.postCount, 0);
}

/**
 * Clave de refresh_state por tramo y plataforma. Instagram conserva las
 * claves históricas (sin sufijo) para no perder las marcas ya guardadas.
 */
function stateKey(base, plataforma) {
  return plataforma === 'instagram' ? base : `${base}:${plataforma}`;
}

/** Plataformas del registro con refresco de métricas, opcionalmente acotadas. */
function refreshPlatformIds(plataformas) {
  return listPlatformIds().filter((id) => {
    if (plataformas && !plataformas.includes(id)) return false;
    const { capabilities } = getPlatform(id);
    return Boolean(capabilities && capabilities.metricsRefresh);
  });
}

/**
 * Refresco de UNA plataforma. Nunca tira — si la fuente devuelve cuota
 * agotada, corta esa plataforma y vuelve normalmente.
 */
async function refreshPostMetricsFor(plataforma, skipSet) {
  const platform = getPlatform(plataforma);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const hotSinceIso = hoursAgoIso(REFRESH_HOT_HOURS, now);
  const warmMaxAgeIso = daysAgoIso(REFRESH_WARM_DAYS, now);
  const coldMaxAgeIso = daysAgoIso(REFRESH_COLD_MAX_DAYS, now);

  // Caliente: siempre, sin gate propio.
  const hotAccounts = db.listAccountsDueForRefresh({ sinceIso: hotSinceIso, untilIso: nowIso, cadenceIso: null, plataforma });

  // Tibio: gate de tramo (marca persistida) antes de siquiera consultar.
  const warmKey = stateKey('warm_last_pass_at', plataforma);
  const warmLastPassAt = db.getRefreshState(warmKey);
  const warmDue = !warmLastPassAt || now - new Date(warmLastPassAt).getTime() >= REFRESH_WARM_EVERY_HOURS * HOUR_MS;
  const warmAccounts = warmDue
    ? db.listAccountsDueForRefresh({
        sinceIso: warmMaxAgeIso,
        untilIso: hotSinceIso,
        cadenceIso: hoursAgoIso(REFRESH_WARM_EVERY_HOURS, now),
        plataforma,
      })
    : [];

  // Frío: mismo mecanismo, cadencia semanal, sin gate por posteo (todo el
  // tramo ya está gateado a nivel semana).
  const coldKey = stateKey('cold_last_pass_at', plataforma);
  const coldLastPassAt = db.getRefreshState(coldKey);
  const coldDue = !coldLastPassAt || now - new Date(coldLastPassAt).getTime() >= REFRESH_COLD_EVERY_DAYS * DAY_MS;
  const coldAccounts = coldDue
    ? db.listAccountsDueForRefresh({ sinceIso: coldMaxAgeIso, untilIso: warmMaxAgeIso, cadenceIso: null, plataforma })
    : [];

  const hotCount = sumPostCount(hotAccounts);
  const warmCount = sumPostCount(warmAccounts);
  const coldCount = sumPostCount(coldAccounts);

  // Unión por cuenta (puede tener posteos en más de un tramo a la vez —
  // se scrapea una sola vez igual, cubre todos). Se excluyen acá las que
  // el ciclo de monitoreo ya consultó en esta misma corrida.
  const byAccount = new Map();
  for (const row of [...hotAccounts, ...warmAccounts, ...coldAccounts]) {
    if (skipSet.has(row.account.toLowerCase())) continue;
    const prev = byAccount.get(row.account);
    if (!prev || row.mostRecentPostedAt > prev) byAccount.set(row.account, row.mostRecentPostedAt);
  }
  const prioritized = [...byAccount.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, MAX_ACCOUNTS_PER_REFRESH)
    .map(([account]) => account);
  progress.startPhase('Refrescando métricas', prioritized.length);

  let accountsChecked = 0;
  let resultsConsumed = 0;
  let rowsUpdated = 0;
  let postsMatched = 0;
  let jumpsDetected = 0;
  let quotaExceeded = false;
  let skippedByQuota = 0;
  let quotaLoggedOnce = false;

  // Las cuentas se lanzan TODAS juntas (Promise.allSettled) — la prioridad
  // por recencia decide el orden de `prioritized`, no el de ejecución — y
  // refreshLimiter (propio de este módulo, NUNCA el apifyLimiter de
  // src/apify.js: ver el comentario junto a su declaración) regula cuántas
  // corren a la vez. Un flag compartido corta los LANZAMIENTOS pendientes
  // apenas una llamada devuelve cuota agotada; las que ya estaban en vuelo
  // terminan y sus resultados se guardan igual.
  await Promise.allSettled(
    prioritized.map((account) =>
      refreshLimiter.run(async () => {
        if (quotaExceeded) {
          skippedByQuota += 1;
          return;
        }
        let posts;
        try {
          posts = await platform.scrapeAccount(account, { resultsLimit: BENCHMARK_POST_LIMIT, lookback: undefined });
        } catch (err) {
          if (isQuotaExceeded(err)) {
            quotaExceeded = true;
            if (!quotaLoggedOnce) {
              quotaLoggedOnce = true;
              console.log(`[metricsRefresh] (${plataforma}) cuota de la fuente agotada, cortando la corrida en @${account}.`);
            }
          } else {
            console.error(`[metricsRefresh] (${plataforma}) No se pudo refrescar @${account}:`, err.message);
          }
          progress.tick(1, { ok: false });
          return;
        }
        progress.tick(1, { ok: true });
        accountsChecked += 1;
        resultsConsumed += posts.length;
        // Seguidores que vinieron con los posteos (apidojo): solo la caché;
        // propagarlos a las filas guardadas sigue siendo cosa del benchmark.
        rememberFollowers(posts, plataforma);

        for (const post of posts) {
          const result = db.applyMetricsRefresh(post.id, pickMetrics(platform, post));
          if (!result) continue; // no estaba guardado -> no corresponde tocarlo (eso es cosa de runMonitoringCycle)
          postsMatched += 1;
          if (result.changed) rowsUpdated += 1;

          if (
            checkAndLogJump({ account: result.account, id: post.id, postedAt: result.postedAt, metric: 'comentarios', previous: result.previousComments, current: result.comments })
          ) jumpsDetected += 1;
          if (
            checkAndLogJump({ account: result.account, id: post.id, postedAt: result.postedAt, metric: 'likes', previous: result.previousLikes, current: result.likes })
          ) jumpsDetected += 1;
        }
      }, `@${account}`)
    )
  );

  // Las marcas de pase NO se avanzan si se cortó por cuota — mejor
  // reintentar antes en el próximo ciclo que esperar el intervalo completo
  // de nuevo. Si terminó normal (con o sin cuentas que quedaron afuera por
  // el tope), sí se avanzan: esas cuentas vuelven a competir por prioridad
  // en el próximo pase, ya no dentro de este.
  if (!quotaExceeded) {
    if (warmDue) db.setRefreshState(warmKey, nowIso);
    if (coldDue) db.setRefreshState(coldKey, nowIso);
  }

  console.log(
    `[metricsRefresh] (${plataforma}) ${hotCount} posteos en tramo caliente, ${warmCount} en tibio, ${coldCount} en frío, ` +
      `${accountsChecked} cuentas consultadas, ${resultsConsumed} resultados consumidos, ` +
      `${rowsUpdated} filas actualizadas, ${jumpsDetected} saltos detectados` +
      (skippedByQuota > 0 ? `; ${skippedByQuota} cuenta(s) no se intentaron por corte de cuota` : '')
  );

  // Falla silenciosa: si se consultaron cuentas de verdad pero ni un solo
  // posteo de la respuesta matcheó contra detected_posts, lo más probable
  // es que los ids no coincidan (ver README) — no un problema de que
  // "nada cambió" (eso es normal y no ameritaría este aviso).
  if (accountsChecked > 0 && postsMatched === 0 && !quotaExceeded) {
    console.log(
      `[metricsRefresh] (${plataforma}) ATENCIÓN: ${accountsChecked} cuentas consultadas, 0 filas actualizadas. ` +
        `Revisar que los ids del scraping coincidan con los guardados.`
    );
  }

  return {
    hotCount,
    warmCount,
    coldCount,
    accountsChecked,
    resultsConsumed,
    rowsUpdated,
    jumpsDetected,
    quotaExceeded,
  };
}

/**
 * Refresca las métricas de los posteos guardados que les toca según su
 * antigüedad, plataforma por plataforma (solo las que tienen esa
 * capability), sin volver a consultar las cuentas que el propio ciclo de
 * monitoreo ya scrapeó en esta misma corrida.
 *
 * @param {{ plataformas?: string[], skipAccounts?: Object<string, string[]> | string[] }} [options]
 *   skipAccounts: por plataforma ({ instagram: [...] }, lo que devuelve
 *   runMonitoringCycle); un array plano se aplica a todas.
 */
async function refreshPostMetrics({ plataformas, skipAccounts = {} } = {}) {
  const totals = {
    hotCount: 0,
    warmCount: 0,
    coldCount: 0,
    accountsChecked: 0,
    resultsConsumed: 0,
    rowsUpdated: 0,
    jumpsDetected: 0,
    quotaExceeded: false,
    porPlataforma: {},
  };
  for (const plataforma of refreshPlatformIds(plataformas)) {
    const skipList = Array.isArray(skipAccounts) ? skipAccounts : skipAccounts[plataforma] || [];
    const skipSet = new Set(skipList.map((a) => String(a).toLowerCase()));
    const result = await refreshPostMetricsFor(plataforma, skipSet);
    totals.porPlataforma[plataforma] = result;
    for (const key of ['hotCount', 'warmCount', 'coldCount', 'accountsChecked', 'resultsConsumed', 'rowsUpdated', 'jumpsDetected']) {
      totals[key] += result[key];
    }
    totals.quotaExceeded = totals.quotaExceeded || result.quotaExceeded;
  }
  return totals;
}

module.exports = {
  refreshPostMetrics,
  refreshPlatformIds,
  REFRESH_HOT_HOURS,
  REFRESH_WARM_DAYS,
  REFRESH_WARM_EVERY_HOURS,
  REFRESH_COLD_EVERY_DAYS,
  REFRESH_COLD_MAX_DAYS,
  MAX_ACCOUNTS_PER_REFRESH,
  // Para el heartbeat del ciclo (Cambio G, ver src/scheduler.js).
  refreshLimiter,
};
