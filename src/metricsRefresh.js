// ==========================================================================
// metricsRefresh.js
// --------------------------------------------------------------------------
// Refresca las métricas de posteos YA detectados — nunca re-detecta, nunca
// re-clasifica sentimiento/relevancia (misma fila, mismo id, mismo título).
//
// Dos modos, elegidos por REFRESH_MODE (src/refreshMode.js, ver
// openspec/changes/refresco-url):
//
//   - "url" (default): POR PUBLICACIÓN. Cada posteo vencido se pide por su
//     URL (/p/{code}/) al actor oficial apify/instagram-scraper vía
//     platform.fetchPostDetails, el mismo camino del detalle de búsqueda:
//     un run por ciclo con todas las URLs, en lotes de hasta
//     REFRESH_URLS_PER_RUN (100: el endpoint sincrónico de Apify corta a los
//     300 s), 0,0023 usd por posteo, y se actualiza exactamente lo pedido.
//     Antes, por perfil, tres de cada cuatro posteos se pagaban sin
//     actualizarse (un posteo de 2 a 7 días de un medio que publica mucho ya
//     no está entre los últimos 15 del perfil).
//   - "perfil": lo anterior al cambio, sin modificaciones. Agrupado por
//     cuenta: una consulta de perfil (platform.scrapeAccount, últimos
//     BENCHMARK_POST_LIMIT posteos) cubre todos los posteos pendientes de
//     esa cuenta, tope MAX_ACCOUNTS_PER_REFRESH por corrida.
//
// Tres tramos por antigüedad (posted_at), iguales en los dos modos:
//   - Caliente (< REFRESH_HOT_HOURS): cadencia por posteo (última escritura
//     de métricas contra REFRESH_HOT_EVERY_HOURS, 12 h), sin marca de tramo.
//     Por URL, un posteo recién detectado cuenta desde detected_at (ya trae
//     las métricas del detalle): entra cuando pasan 12 h desde que se
//     detectó, no en el mismo ciclo. Por perfil, metrics_updated_at null
//     cuenta como vencido (como siempre).
//   - Tibio (REFRESH_HOT_HOURS a REFRESH_WARM_DAYS): gateado dos veces — a
//     nivel de tramo (no se evalúa nada si no pasó REFRESH_WARM_EVERY_HOURS
//     desde el último pase, marca persistida en refresh_state) y a nivel de
//     posteo (misma cadencia).
//   - Frío (REFRESH_WARM_DAYS a REFRESH_COLD_MAX_DAYS): barrido semanal,
//     gateado igual (refresh_state, REFRESH_COLD_EVERY_DAYS) y por posteo.
//     Más viejo que REFRESH_COLD_MAX_DAYS: congelado, nada lo toca.
//
// Por URL, la cola va por tramo (caliente, tibio, frío: lo caliente es lo
// que detecta saltos) y dentro de cada tramo por atraso (última escritura
// más vieja primero). Tope REFRESH_MAX_POSTS (150) por ciclo: lo que no
// entra queda para el ciclo siguiente. En los dos modos, si el tope dejó
// algo afuera (o un run falló, o se cortó por cuota), las marcas de pase de
// tibio y frío NO avanzan: el tramo se vuelve a evaluar en el próximo ciclo
// y la cadencia por posteo retoma solo lo que faltaba, sin pagar dos veces.
//
// Publicaciones borradas o privadas (solo por URL): si el run terminó bien
// y un posteo pedido no volvió, db.registerRefreshMiss suma un intento; al
// REFRESH_MISSES_TO_STOP (2) seguido se frena (refresh_stopped_at) y deja de
// pedirse, con línea de log. Una respuesta válida reanuda. Sus métricas
// quedan en el último valor conocido (regla única de métricas de db.js: un
// valor ausente, null o negativo nunca pisa lo guardado).
//
// Seguidores: por URL no llegan (el actor oficial no los trae por posteo);
// los sigue trayendo el benchmark (src/accountStats.js). Por perfil, igual
// que antes (rememberFollowers con los posteos de apidojo).
//
// Multiplataforma: corre por cada plataforma cuyo adapter declara
// capabilities.metricsRefresh (hoy Instagram); el camino URL solo si además
// tiene fetchPostDetails (X no tiene ninguno de los dos: no se toca). Las
// métricas que se escriben son las que declara el adapter (pickMetrics).
//
// runMonitoringCycle (monitor.js) ya refresca gratis los posteos conocidos
// que aparecen en su propio scraping, y el benchmark actualiza los de las
// cuentas que acaba de pasar: esas cuentas se excluyen acá vía skipAccounts
// para no pagarlas dos veces en el mismo ciclo.
// ==========================================================================

const db = require('./db');
const progress = require('./monitoringProgress');
const { getPlatform, listPlatformIds } = require('./platforms');
const { isQuotaExceeded } = require('./platforms/errors');
const { createLimiter } = require('./concurrencyLimiter');
const { BENCHMARK_POST_LIMIT } = require('./accountStats');
const { pickMetrics, rememberFollowers, postCodeOf } = require('./monitor');
const { checkAndLogJump } = require('./viralJumpDetector');
const { resolveRefreshMode } = require('./refreshMode');

// Se resuelve al cargar (como IG_ACTOR); server.js lo valida antes con un
// mensaje claro.
const REFRESH_MODE = resolveRefreshMode();

const REFRESH_HOT_HOURS = Number(process.env.REFRESH_HOT_HOURS) || 48;
const REFRESH_HOT_EVERY_HOURS = Number(process.env.REFRESH_HOT_EVERY_HOURS) || 12;
const REFRESH_WARM_DAYS = Number(process.env.REFRESH_WARM_DAYS) || 7;
const REFRESH_WARM_EVERY_HOURS = Number(process.env.REFRESH_WARM_EVERY_HOURS) || 24;
const REFRESH_COLD_EVERY_DAYS = Number(process.env.REFRESH_COLD_EVERY_DAYS) || 7;
const REFRESH_COLD_MAX_DAYS = Number(process.env.REFRESH_COLD_MAX_DAYS) || 60;
// Modo perfil. 100 (era 30): con la detección por búsquedas el tramo
// caliente solo ya llenaba el tope y el tibio y el frío casi nunca entraban.
// Cada cuenta es una consulta de perfil (0,0065 usd).
const MAX_ACCOUNTS_PER_REFRESH = Number(process.env.MAX_ACCOUNTS_PER_REFRESH) || 100;

/** Entero >= 1 o el default (un 0, un negativo o basura no apagan el refresco por accidente). */
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
// Modo URL. 150: el pase tibio más grande visto fue 125 posteos en un ciclo
// (#19, 2026-09-28), entra entero; el pase frío (278 vencidos el 6/10/2026,
// 339 en tramo) se reparte en 2 o 3 ciclos seguidos. Techo por ciclo: 150 ×
// 0,0023 = 0,345 usd.
const REFRESH_MAX_POSTS = positiveInt(process.env.REFRESH_MAX_POSTS, 150);
// Intentos SEGUIDOS sin respuesta antes de dejar de pedir un posteo.
const REFRESH_MISSES_TO_STOP = positiveInt(process.env.REFRESH_MISSES_TO_STOP, 2);
// URLs por run: el detalle de 17 URLs tardó 19 s y el endpoint sincrónico
// corta a los 300 s. Mismo tope que el detalle de búsqueda. Constante, no
// variable de entorno: con REFRESH_MAX_POSTS=150 son a lo sumo 2 runs.
const REFRESH_URLS_PER_RUN = 100;

// Limitador PROPIO del refresco — nunca el apifyLimiter de src/apify.js
// (mismo motivo que benchmarkLimiter en accountStats.js: un deadlock real si
// compartiera instancia con runActorSync, ver Cambio G). Por perfil regula
// cuentas en vuelo; por URL, lotes en vuelo.
const refreshLimiter = createLimiter(Number(process.env.APIFY_MAX_CONCURRENT) || 10, 'refresco');

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

/** Modo efectivo para una plataforma: URL solo si lo pide REFRESH_MODE y el adapter sabe pedir posteos por URL. */
function refreshModeFor(platform) {
  return REFRESH_MODE === 'url' && typeof platform.fetchPostDetails === 'function' ? 'url' : 'perfil';
}

/** Límites de edad y cadencias de los tres tramos, en ISO, para un instante dado. Compartido por los dos modos. */
function tramoWindows(now) {
  return {
    nowIso: new Date(now).toISOString(),
    hotSinceIso: hoursAgoIso(REFRESH_HOT_HOURS, now),
    warmMaxAgeIso: daysAgoIso(REFRESH_WARM_DAYS, now),
    coldMaxAgeIso: daysAgoIso(REFRESH_COLD_MAX_DAYS, now),
    hotCadenceIso: hoursAgoIso(REFRESH_HOT_EVERY_HOURS, now),
    warmCadenceIso: hoursAgoIso(REFRESH_WARM_EVERY_HOURS, now),
    coldCadenceIso: daysAgoIso(REFRESH_COLD_EVERY_DAYS, now),
  };
}

/** Gates de tramo (marcas persistidas) de tibio y frío. Compartido por los dos modos. */
function tramoGates(plataforma, now) {
  const warmKey = stateKey('warm_last_pass_at', plataforma);
  const warmLastPassAt = db.getRefreshState(warmKey);
  const warmDue = !warmLastPassAt || now - new Date(warmLastPassAt).getTime() >= REFRESH_WARM_EVERY_HOURS * HOUR_MS;
  const coldKey = stateKey('cold_last_pass_at', plataforma);
  const coldLastPassAt = db.getRefreshState(coldKey);
  const coldDue = !coldLastPassAt || now - new Date(coldLastPassAt).getTime() >= REFRESH_COLD_EVERY_DAYS * DAY_MS;
  return { warmKey, warmDue, coldKey, coldDue };
}

// --------------------------------------------------------------------------
// Modo perfil (REFRESH_MODE=perfil): el comportamiento anterior al cambio.
// --------------------------------------------------------------------------

/**
 * Refresco por PERFIL de UNA plataforma. Nunca tira — si la fuente devuelve
 * cuota agotada, corta esa plataforma y vuelve normalmente.
 */
async function refreshPostMetricsFor(plataforma, skipSet) {
  const platform = getPlatform(plataforma);
  const now = Date.now();
  const { nowIso, hotSinceIso, warmMaxAgeIso, coldMaxAgeIso, hotCadenceIso, warmCadenceIso, coldCadenceIso } = tramoWindows(now);
  const { warmKey, warmDue, coldKey, coldDue } = tramoGates(plataforma, now);

  // Caliente: sin marca de tramo, con cadencia por posteo (ver encabezado).
  const hotAccounts = db.listAccountsDueForRefresh({ sinceIso: hotSinceIso, untilIso: nowIso, cadenceIso: hotCadenceIso, plataforma });

  // Tibio: gate de tramo (marca persistida) antes de siquiera consultar.
  const warmAccounts = warmDue
    ? db.listAccountsDueForRefresh({ sinceIso: warmMaxAgeIso, untilIso: hotSinceIso, cadenceIso: warmCadenceIso, plataforma })
    : [];

  // Frío: mismo mecanismo, cadencia semanal. El gate por posteo hace que,
  // si el tope dejó cuentas afuera y el tramo se vuelve a evaluar en el
  // próximo ciclo, no se vuelva a pagar lo ya refrescado.
  const coldAccounts = coldDue
    ? db.listAccountsDueForRefresh({ sinceIso: coldMaxAgeIso, untilIso: warmMaxAgeIso, cadenceIso: coldCadenceIso, plataforma })
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
  // Cuentas que el tope dejó afuera en esta corrida (ver el encabezado).
  const leftOut = byAccount.size - prioritized.length;
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
  // refreshLimiter regula cuántas corren a la vez. Un flag compartido corta
  // los LANZAMIENTOS pendientes apenas una llamada devuelve cuota agotada;
  // las que ya estaban en vuelo terminan y sus resultados se guardan igual.
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

  // Las marcas de pase NO se avanzan si se cortó por cuota (mejor
  // reintentar antes en el próximo ciclo que esperar el intervalo completo
  // de nuevo) ni si el tope dejó cuentas afuera: el tramo se vuelve a
  // evaluar en el próximo ciclo y la cadencia por posteo retoma solo lo que
  // faltaba. Recién cuando un pase cubrió todo, avanzan.
  if (!quotaExceeded && leftOut === 0) {
    if (warmDue) db.setRefreshState(warmKey, nowIso);
    if (coldDue) db.setRefreshState(coldKey, nowIso);
  }

  console.log(
    `[metricsRefresh] (${plataforma}) ${hotCount} posteos en tramo caliente, ${warmCount} en tibio, ${coldCount} en frío, ` +
      `${accountsChecked} cuentas consultadas, ${resultsConsumed} resultados consumidos, ` +
      `${rowsUpdated} filas actualizadas, ${jumpsDetected} saltos detectados` +
      (skippedByQuota > 0 ? `; ${skippedByQuota} cuenta(s) no se intentaron por corte de cuota` : '') +
      (leftOut > 0
        ? `; ${leftOut} cuenta(s) quedaron afuera por el tope (MAX_ACCOUNTS_PER_REFRESH=${MAX_ACCOUNTS_PER_REFRESH}) y se retoman en el próximo ciclo`
        : '')
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
    mode: 'perfil',
    hotCount,
    warmCount,
    coldCount,
    accountsChecked,
    resultsConsumed,
    rowsUpdated,
    jumpsDetected,
    leftOut,
    quotaExceeded,
  };
}

// --------------------------------------------------------------------------
// Modo URL (REFRESH_MODE=url, default): por publicación, con el actor oficial.
// --------------------------------------------------------------------------

/**
 * Refresco por URL de UNA plataforma. Nunca tira — un run caído se loguea y
 * sus posteos se reintentan por cadencia; cuota agotada corta los lotes
 * pendientes y vuelve normalmente.
 */
async function refreshByUrlFor(plataforma, skipSet) {
  const platform = getPlatform(plataforma);
  const now = Date.now();
  const { nowIso, hotSinceIso, warmMaxAgeIso, coldMaxAgeIso, hotCadenceIso, warmCadenceIso, coldCadenceIso } = tramoWindows(now);
  const { warmKey, warmDue, coldKey, coldDue } = tramoGates(plataforma, now);

  // Cada lista viene de lo más atrasado a lo más reciente (ORDER BY de
  // listPostsDueForRefresh): el orden dentro del tramo ya está resuelto.
  const hot = db.listPostsDueForRefresh({ sinceIso: hotSinceIso, untilIso: nowIso, cadenceIso: hotCadenceIso, plataforma });
  const warm = warmDue ? db.listPostsDueForRefresh({ sinceIso: warmMaxAgeIso, untilIso: hotSinceIso, cadenceIso: warmCadenceIso, plataforma }) : [];
  const cold = coldDue ? db.listPostsDueForRefresh({ sinceIso: coldMaxAgeIso, untilIso: warmMaxAgeIso, cadenceIso: coldCadenceIso, plataforma }) : [];
  const hotCount = hot.length;
  const warmCount = warm.length;
  const coldCount = cold.length;

  // Cola: tramo primero (caliente, tibio, frío), sin los posteos de las
  // cuentas que este ciclo ya consultó (benchmark) y sin URLs sin código
  // (el actor no acepta el id numérico: nunca se arma una URL con él).
  const queue = [];
  const seen = new Set();
  let skippedByAccount = 0;
  let withoutCode = 0;
  for (const [tramo, rows] of [['caliente', hot], ['tibio', warm], ['frío', cold]]) {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.account && skipSet.has(String(row.account).toLowerCase())) {
        skippedByAccount += 1;
        continue;
      }
      if (!postCodeOf(row.url)) {
        withoutCode += 1;
        continue;
      }
      queue.push({ id: row.id, url: row.url, account: row.account, tramo });
    }
  }
  const requested = queue.slice(0, REFRESH_MAX_POSTS);
  // Lo que el tope dejó afuera en este ciclo (ver el encabezado).
  const deferred = queue.length - requested.length;
  progress.startPhase('Refrescando métricas', requested.length);

  const batches = [];
  for (let i = 0; i < requested.length; i += REFRESH_URLS_PER_RUN) {
    batches.push(requested.slice(i, i + REFRESH_URLS_PER_RUN));
  }

  let runs = 0;
  let runsFailed = 0;
  let batchesSkippedByQuota = 0;
  let resultsConsumed = 0;
  let postsAnswered = 0;
  let rowsUpdated = 0;
  let jumpsDetected = 0;
  let postsMissing = 0;
  let postsStopped = 0;
  let quotaExceeded = false;
  let quotaLoggedOnce = false;

  // Los lotes se lanzan juntos (Promise.allSettled) a través de
  // refreshLimiter; un flag compartido corta los lotes todavía no lanzados
  // apenas uno devuelve cuota agotada. Un lote caído no cuenta ni como
  // respuesta ni como falta para sus posteos: se reintentan por cadencia.
  await Promise.allSettled(
    batches.map((batch, index) =>
      refreshLimiter.run(async () => {
        if (quotaExceeded) {
          batchesSkippedByQuota += 1;
          progress.tick(batch.length, { ok: false });
          return;
        }
        let details;
        try {
          details = await platform.fetchPostDetails(batch.map((post) => post.url));
        } catch (err) {
          runsFailed += 1;
          if (isQuotaExceeded(err)) {
            quotaExceeded = true;
            if (!quotaLoggedOnce) {
              quotaLoggedOnce = true;
              console.log(`[metricsRefresh] (${plataforma}) cuota de la fuente agotada, cortando la corrida en el lote ${index + 1}/${batches.length}.`);
            }
          } else {
            console.error(
              `[metricsRefresh] (${plataforma}) falló el run de refresco por URL (lote ${index + 1}/${batches.length}, ${batch.length} posteos; se reintentan por cadencia):`,
              err.message
            );
          }
          progress.tick(batch.length, { ok: false });
          return;
        }
        runs += 1;
        const items = Array.isArray(details) ? details : [];
        resultsConsumed += items.length;

        // Cruce por id y, de respaldo, por el código de la URL (los items
        // vuelven en cualquier orden).
        const byId = new Map();
        const byCode = new Map();
        for (const detail of items) {
          if (!detail) continue;
          if (detail.id) byId.set(String(detail.id), detail);
          const code = postCodeOf(detail.url);
          if (code) byCode.set(code, detail);
        }

        for (const post of batch) {
          const detail = byId.get(String(post.id)) || byCode.get(postCodeOf(post.url));
          if (!detail) {
            // El run terminó bien y este posteo no volvió: borrado, privado
            // o un item de error del actor (fetchPostDetails los descarta).
            progress.tick(1, { ok: false });
            const miss = db.registerRefreshMiss(post.id, { stopAfter: REFRESH_MISSES_TO_STOP });
            if (!miss) continue; // ignorado entre medio
            postsMissing += 1;
            if (miss.stopped) {
              postsStopped += 1;
              console.log(
                `[metricsRefresh] (${plataforma}) @${miss.account || 'N/D'} ${miss.url}: sin respuesta en ${miss.misses} intentos seguidos ` +
                  `(borrada o privada), deja de refrescarse (REFRESH_MISSES_TO_STOP=${REFRESH_MISSES_TO_STOP}).`
              );
            }
            continue;
          }
          progress.tick(1, { ok: true });
          const result = db.applyMetricsRefresh(post.id, pickMetrics(platform, detail));
          if (!result) continue; // ignorado entre medio
          postsAnswered += 1;
          if (result.changed) rowsUpdated += 1;

          if (
            checkAndLogJump({ account: result.account, id: post.id, postedAt: result.postedAt, metric: 'comentarios', previous: result.previousComments, current: result.comments })
          ) jumpsDetected += 1;
          if (
            checkAndLogJump({ account: result.account, id: post.id, postedAt: result.postedAt, metric: 'likes', previous: result.previousLikes, current: result.likes })
          ) jumpsDetected += 1;
        }
      }, `lote ${index + 1}/${batches.length} (${batch.length} URLs)`)
    )
  );

  // Marcas de pase: solo con pase completo (ver encabezado).
  if (!quotaExceeded && runsFailed === 0 && deferred === 0) {
    if (warmDue) db.setRefreshState(warmKey, nowIso);
    if (coldDue) db.setRefreshState(coldKey, nowIso);
  }

  console.log(
    `[metricsRefresh] (${plataforma}) ${hotCount} posteos en tramo caliente, ${warmCount} en tibio, ${coldCount} en frío → ` +
      `${requested.length} pedidos por URL en ${runs} run(s): ${postsAnswered} respondieron, ${rowsUpdated} con cambios, ` +
      `${postsMissing} sin respuesta (${postsStopped} dejan de refrescarse), ${jumpsDetected} saltos detectados` +
      (deferred > 0 ? `; ${deferred} quedan para el próximo ciclo (REFRESH_MAX_POSTS=${REFRESH_MAX_POSTS})` : '') +
      (withoutCode > 0 ? `; ${withoutCode} sin código en la URL, no se pueden refrescar por URL` : '') +
      (skippedByAccount > 0 ? `; ${skippedByAccount} de cuentas ya consultadas en este ciclo` : '') +
      (runsFailed > 0 ? `; ${runsFailed} run(s) fallaron, sus posteos se reintentan por cadencia` : '') +
      (batchesSkippedByQuota > 0 ? `; ${batchesSkippedByQuota} lote(s) no se lanzaron por corte de cuota` : '')
  );

  // Falla silenciosa: hubo runs que terminaron bien y ni un solo posteo
  // pedido volvió. Lo más probable es que los ids o las URLs no coincidan
  // (ver README), no que todos estén borrados.
  if (runs > 0 && requested.length > 0 && postsAnswered === 0) {
    console.log(
      `[metricsRefresh] (${plataforma}) ATENCIÓN: ${requested.length} posteos pedidos por URL, 0 respondieron. ` +
        `Revisar que los ids y las URLs del actor coincidan con los guardados.`
    );
  }

  return {
    mode: 'url',
    hotCount,
    warmCount,
    coldCount,
    accountsChecked: 0,
    resultsConsumed,
    rowsUpdated,
    jumpsDetected,
    leftOut: deferred,
    quotaExceeded,
    postsRequested: requested.length,
    postsAnswered,
    postsMissing,
    postsStopped,
    deferred,
    runs,
    runsFailed,
    withoutCode,
    skippedByAccount,
  };
}

// --------------------------------------------------------------------------

const TOTAL_KEYS = [
  'hotCount',
  'warmCount',
  'coldCount',
  'accountsChecked',
  'resultsConsumed',
  'rowsUpdated',
  'jumpsDetected',
  'leftOut',
  'postsRequested',
  'postsAnswered',
  'postsMissing',
  'postsStopped',
  'deferred',
  'runs',
  'runsFailed',
  'withoutCode',
  'skippedByAccount',
];

/**
 * Refresca las métricas de los posteos guardados que les toca según su
 * antigüedad, plataforma por plataforma (solo las que tienen esa
 * capability), en el modo que indique REFRESH_MODE, sin volver a consultar
 * las cuentas que el propio ciclo ya scrapeó o pasó por el benchmark en
 * esta misma corrida.
 *
 * @param {{ plataformas?: string[], skipAccounts?: Object<string, string[]> | string[] }} [options]
 *   skipAccounts: por plataforma ({ instagram: [...] }, lo que devuelve
 *   runMonitoringCycle); un array plano se aplica a todas.
 */
async function refreshPostMetrics({ plataformas, skipAccounts = {} } = {}) {
  const totals = { quotaExceeded: false, porPlataforma: {} };
  for (const key of TOTAL_KEYS) totals[key] = 0;
  for (const plataforma of refreshPlatformIds(plataformas)) {
    const skipList = Array.isArray(skipAccounts) ? skipAccounts : skipAccounts[plataforma] || [];
    const skipSet = new Set(skipList.map((a) => String(a).toLowerCase()));
    const platform = getPlatform(plataforma);
    const result =
      refreshModeFor(platform) === 'url' ? await refreshByUrlFor(plataforma, skipSet) : await refreshPostMetricsFor(plataforma, skipSet);
    totals.porPlataforma[plataforma] = result;
    for (const key of TOTAL_KEYS) totals[key] += result[key] || 0;
    totals.quotaExceeded = totals.quotaExceeded || result.quotaExceeded;
  }
  return totals;
}

module.exports = {
  refreshPostMetrics,
  refreshPlatformIds,
  refreshModeFor,
  REFRESH_MODE,
  REFRESH_HOT_HOURS,
  REFRESH_HOT_EVERY_HOURS,
  REFRESH_WARM_DAYS,
  REFRESH_WARM_EVERY_HOURS,
  REFRESH_COLD_EVERY_DAYS,
  REFRESH_COLD_MAX_DAYS,
  MAX_ACCOUNTS_PER_REFRESH,
  REFRESH_MAX_POSTS,
  REFRESH_MISSES_TO_STOP,
  REFRESH_URLS_PER_RUN,
  // Para el heartbeat del ciclo (Cambio G, ver src/scheduler.js).
  refreshLimiter,
};
