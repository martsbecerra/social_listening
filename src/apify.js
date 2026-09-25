// ==========================================================================
// apify.js
// --------------------------------------------------------------------------
// Se encarga de hablar con Apify para extraer (scrapear) los datos de
// Instagram: los comentarios de la publicación y los datos del posteo en sí.
//
// El ANÁLISIS de una publicación (scrapeInstagram, abajo) usa siempre el
// actor oficial "apify/instagram-scraper": es el único que devuelve
// comentarios. El MONITOREO de Instagram (src/platforms/instagram.js) pasa
// por el mismo runActorSync pero con el actor que elija IG_ACTOR
// (apidojo/instagram-scraper-api por defecto, ver src/platforms/igActor.js):
// runActorSync recibe el id del actor como parámetro y no sabe cuál de los
// dos está corriendo; la cola, el reintento del 402 y el registro de costo
// valen para ambos.
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
//
// RUNS SIMULTÁNEOS (cola global)
// --------------------------------------------------------------------------
// El plan Free de Apify permite 5 Actor runs a la vez. La detección del
// monitoreo lanza todas las fuentes de Instagram juntas y con 12 cuentas +
// hashtags varias fallaban con 402 "concurrent-runs-limit-exceeded". Por eso
// TODAS las llamadas a Apify de la app (detección, benchmark, refresco de
// métricas, análisis a demanda, validación de cuentas y hashtags) pasan por
// runActorSync y este único limitador: como mucho APIFY_MAX_CONCURRENT
// corridas en vuelo, el resto espera su turno en orden de llegada. El lugar
// se retiene mientras dura el run (el endpoint sincrónico mantiene la
// conexión abierta hasta que el actor termina). Si igual llega un 402 por
// runs simultáneos, esa llamada espera y reintenta UNA vez sin soltar su
// lugar; recién ahí falla.
//
// COSTO REAL (flujo asincrónico para el actor apidojo)
// --------------------------------------------------------------------------
// El endpoint sincrónico devuelve los items pero NO el id del run, y lo que
// Apify cobró de verdad por un run pay-per-event solo se lee del objeto del
// run (GET /v2/actor-runs/{id}: usageTotalUsd, chargedEventCounts). Para el
// actor apidojo, que cobra por consulta y con descuentos por plan que no
// conocemos de antemano, las llamadas van por el flujo asincrónico:
// POST /acts/{id}/runs?waitForFinish=60 (arranca el run y espera hasta 60 s
// en la misma request), GET del run hasta que termine (dentro de
// REQUEST_TIMEOUT_MS) y GET de los items del dataset. Dos o tres requests
// en vez de una, sin costo extra: la fila de apify_calls queda con el
// apify_run_id. El costo NO se lee al terminar: Apify asienta el cobro con
// demora (en el ciclo real del 2026-09-18, leído al terminar el run, 10 de
// 29 llamadas daban 0 y a las demás les faltaban los posteos extra; minutos
// después estaba completo). usd_real se concilia más tarde con
// fetchRunCost (apifyCost.reconcileRealCosts, que el scheduler corre al
// cerrar cada ciclo para las llamadas de ciclos anteriores).
// APIFY_REAL_COST=0 lo apaga (vuelve al sincrónico, sin run id ni costo
// real). El actor oficial (análisis de publicación e IG_ACTOR=apify) sigue
// con el sincrónico de siempre: sus filas no tienen usd_real.
// ==========================================================================

const { createLimiter } = require('./concurrencyLimiter');
const { getContext } = require('./usageContext');
const { recordApifyCall, describeInput } = require('./apifyCost');

// Nombre del actor en la API (el "/" se escribe como "~")
const APIFY_ACTOR = 'apify~instagram-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';

// Cuánto esperamos como máximo antes de cortar por nuestra cuenta (5 min).
const REQUEST_TIMEOUT_MS = 300000;

// Runs simultáneos permitidos a esta app. 3 deja margen para que dos cosas
// corran a la vez (ej. el cron y un análisis a demanda) sin llegar a los 5
// del plan Free. Al pasar a un plan con más runs, subirlo en el .env.
const APIFY_MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.APIFY_MAX_CONCURRENT) || 3));
// Cuánto esperar antes del único reintento de un 402 por runs simultáneos
// (otro proceso usando el mismo token, o el tope de arriba demasiado alto).
const APIFY_RETRY_DELAY_MS = parseDelayMs(process.env.APIFY_RETRY_DELAY_MS, 5000);
// Tipo de error que devuelve Apify en ese caso (402, cuerpo
// {"error":{"type":"concurrent-runs-limit-exceeded",...}}). Se busca en el
// texto, igual que la cuota mensual, para no depender del status exacto.
const CONCURRENT_RUNS_ERROR = 'concurrent-runs-limit-exceeded';
// Flujo asincrónico (costo real): cuánto espera cada request al run
// (máximo que admite waitForFinish) y el timeout de esa request.
const REAL_COST_WAIT_SECS = 60;
const REAL_COST_REQUEST_TIMEOUT_MS = 90000;
const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];

// Cuelgue de ~30 minutos visto en vivo (Cambio G): timeout de seguridad por
// llamada, aparte del REQUEST_TIMEOUT_MS de cada request HTTP individual —
// cubre también un bucle de espera que nunca termina. Cada intento de
// once() (el inicial y el único reintento por 402) lo respeta por separado.
// 5 minutos (era 2): hubo consultas reales de 84, 87 y 106 s, y una que
// pasa el tope se corta, se cobra igual y sus resultados se pierden. El
// timeout es contra el cuelgue, no contra una consulta lenta.
const APIFY_CALL_TIMEOUT_MS = Math.max(1000, Math.floor(Number(process.env.APIFY_CALL_TIMEOUT_MS) || 300000));

const apifyLimiter = createLimiter(APIFY_MAX_CONCURRENT, 'apify');

/**
 * Corta `promise` a los `ms` si no resolvió antes, con un error `code:
 * 'TIMEOUT'` (mismo tratamiento que QUOTA_EXCEEDED en describeError). No
 * cancela el trabajo real de fondo (fetch no se puede abortar acá sin
 * enhebrar un AbortController hasta este punto) — el timer se limpia igual
 * para no dejar handles colgados.
 */
function withTimeout(promise, ms, target) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Apify: se superó el timeout de seguridad (${ms}ms)${target ? ` — target=${target}` : ''}`);
      err.code = 'TIMEOUT';
      err.userMessage = 'La consulta a Apify tardó demasiado y se cortó por seguridad. Probá de nuevo en unos minutos.';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** APIFY_REAL_COST: activado salvo 0 / false / no / off. Se lee en cada llamada. */
function realCostEnabled() {
  const raw = String(process.env.APIFY_REAL_COST ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/** El flujo asincrónico es solo para actores que no sean el oficial (ver encabezado). */
function usesRealCost(actorId) {
  return actorId !== APIFY_ACTOR && realCostEnabled();
}

function parseDelayMs(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isConcurrentRunsError(err) {
  return Boolean(err && err.concurrentRunsLimit);
}

/**
 * Corre un actor de Apify y devuelve los items del dataset. Pasa por la
 * cola global de runs simultáneos (ver encabezado): si ya hay
 * APIFY_MAX_CONCURRENT corridas en vuelo, espera su turno. Un 402 por runs
 * simultáneos se reintenta una vez después de APIFY_RETRY_DELAY_MS, sin
 * soltar el lugar en la cola; si vuelve a fallar, tira con code RATE_LIMITED.
 *
 * Transporte: el actor oficial va por el endpoint sincrónico
 * (run-sync-get-dataset-items); cualquier otro actor, por el flujo
 * asincrónico que además devuelve el costo real del run (salvo
 * APIFY_REAL_COST=0). Para quien llama es lo mismo: una promesa con los
 * items.
 *
 * Cada llamada queda registrada en apify_calls (src/apifyCost.js) con el
 * ciclo y la fase que vienen del contexto (src/usageContext.js), el actor,
 * la cantidad de items devueltos (los de error también: el oficial los
 * cobra), el usd estimado, el usd real y el id del run si se conocen y, si
 * falló, el error. Una fila por llamada: el reintento del 402 no suma otra.
 * La duración se mide desde que la llamada obtiene su lugar en la cola.
 *
 * @param {object} input - La configuración (input) que espera el actor.
 * @param {{ actorId?: string, plataforma: string }} options - Actor a
 *   correr. Por defecto el oficial (scrapeInstagram, abajo, no lo pasa);
 *   los adapters de src/platforms/ pasan el suyo, así este módulo queda
 *   genérico. plataforma: para la fila de apify_calls, obligatoria (sin
 *   default a instagram: el gasto de otra red no se etiqueta como Instagram
 *   en silencio).
 * @returns {Promise<Array>} Lista de items scrapeados.
 */
async function runActorSync(input, { actorId = APIFY_ACTOR, plataforma } = {}) {
  if (typeof plataforma !== 'string' || !plataforma.trim()) {
    throw new Error('runActorSync: falta plataforma (instagram | x); no hay default.');
  }
  const { target } = describeInput(input);
  return apifyLimiter.run(async () => {
    const context = getContext();
    const phase = (context && context.phase) || 'desconocida';
    const startedAt = Date.now();
    const record = ({ items, error, run }) =>
      recordApifyCall({
        runId: context && context.runId != null ? context.runId : null,
        phase,
        plataforma,
        actor: actorId,
        input,
        items: Array.isArray(items) ? items.length : 0,
        ok: !error,
        error: error ? describeError(error) : null,
        durationMs: Date.now() - startedAt,
        // usd_real queda vacío acá a propósito: se concilia después (ver encabezado).
        apifyRunId: run ? run.id : (error && error.apifyRunId) || null,
      });
    // once() respeta APIFY_CALL_TIMEOUT_MS por intento (Cambio G: un cuelgue
    // real de ~30 min sin timeout mató el proceso a mano). No cuenta como
    // "de plataforma" (ver platforms/errors.js): una sola cuenta/hashtag con
    // timeout se loguea y se sigue, no tira abajo el resto del ciclo.
    const once = () =>
      withTimeout(
        usesRealCost(actorId)
          ? runActorRealCostOnce(input, actorId)
          : runActorSyncOnce(input, actorId).then((items) => ({ items, run: null })),
        APIFY_CALL_TIMEOUT_MS,
        target
      );

    console.log(`[apify] → fase=${phase} target=${target || '(sin target)'} actor=${actorId}`);
    let result;
    try {
      try {
        result = await once();
      } catch (err) {
        if (!isConcurrentRunsError(err)) throw err;
        console.warn(
          `[apify] Apify rechazó la corrida por runs simultáneos (${CONCURRENT_RUNS_ERROR}); ` +
            `se reintenta una vez en ${APIFY_RETRY_DELAY_MS} ms ` +
            `(${apifyLimiter.inFlight()} en vuelo acá, tope APIFY_MAX_CONCURRENT=${APIFY_MAX_CONCURRENT}).`
        );
        await sleep(APIFY_RETRY_DELAY_MS);
        result = await once();
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (err.code === 'TIMEOUT') {
        console.error(`[apify] ← TIMEOUT target=${target || '(sin target)'} tras ${durationMs}ms (tope ${APIFY_CALL_TIMEOUT_MS}ms)`);
      } else {
        console.error(`[apify] ← error target=${target || '(sin target)'} en ${durationMs}ms: ${describeError(err)}`);
      }
      record({ error: err });
      throw err;
    }
    console.log(`[apify] ← ok target=${target || '(sin target)'} en ${Date.now() - startedAt}ms, items=${(result.items || []).length}`);
    record({ items: result.items, run: result.run });
    return result.items;
  }, target);
}

/** Texto de la columna `error` de apify_calls: 'QUOTA_EXCEEDED'/'TIMEOUT' para esos casos, si no el mensaje acotado. */
function describeError(err) {
  if (err && err.code === 'TIMEOUT') return 'TIMEOUT';
  if (err && (err.code === 'QUOTA_EXCEEDED' || isQuotaExceededError(err))) return 'QUOTA_EXCEEDED';
  return String((err && err.message) || err || 'error').slice(0, 300);
}

/** Una sola llamada HTTP al endpoint sincrónico, sin cola ni reintento. Devuelve los items. */
async function runActorSyncOnce(input, actorId) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  return apifyRequest(`${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${token}`, { method: 'POST', body: input });
}

/**
 * Flujo asincrónico (ver encabezado): arranca el run y espera hasta 60 s,
 * sigue esperando de a 60 s hasta REQUEST_TIMEOUT_MS y baja los items del
 * dataset. Devuelve el id del run para conciliar el costo después. Un run
 * que no termina en SUCCEEDED tira con el estado y el statusMessage de
 * Apify (y err.apifyRunId, para la fila de apify_calls).
 * @returns {Promise<{ items: Array, run: { id: string } }>}
 */
async function runActorRealCostOnce(input, actorId) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  const t0 = Date.now();
  // Los endpoints de runs envuelven el objeto en { data: ... }; el de items
  // del dataset devuelve la lista pelada.
  const unwrap = (body) => (body && typeof body === 'object' && !Array.isArray(body) && body.data ? body.data : body);
  const opts = { timeoutMs: REAL_COST_REQUEST_TIMEOUT_MS };

  let run = unwrap(
    await apifyRequest(`${APIFY_BASE}/acts/${actorId}/runs?token=${token}&waitForFinish=${REAL_COST_WAIT_SECS}`, { ...opts, method: 'POST', body: input })
  );
  if (!run || !run.id) {
    const e = new Error('Apify no devolvió el run al arrancar el actor.');
    e.userMessage = 'El servicio de extracción (Apify) no confirmó la corrida. Intentá de nuevo en unos minutos.';
    throw e;
  }
  while (!TERMINAL_STATUSES.includes(run.status)) {
    if (Date.now() - t0 > REQUEST_TIMEOUT_MS) {
      const e = new Error(`Apify tardó demasiado en responder (run ${run.id} sigue en ${run.status}).`);
      e.userMessage = 'La extracción tardó demasiado. Probá de nuevo en unos minutos.';
      e.apifyRunId = run.id;
      throw e;
    }
    run = unwrap(await apifyRequest(`${APIFY_BASE}/actor-runs/${run.id}?token=${token}&waitForFinish=${REAL_COST_WAIT_SECS}`, opts));
  }
  if (run.status !== 'SUCCEEDED') {
    const e = new Error(`El run ${run.id} de Apify terminó en ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ''}`);
    e.userMessage = `La corrida de Apify terminó en ${run.status}. Revisá el run ${run.id} en la consola de Apify.`;
    e.apifyRunId = run.id;
    throw e;
  }
  const items = await apifyRequest(`${APIFY_BASE}/datasets/${run.defaultDatasetId}/items?token=${token}`, opts);
  return { items: Array.isArray(items) ? items : [], run: { id: run.id } };
}

/**
 * Lo que Apify cobró por un run ya terminado: GET /v2/actor-runs/{id}
 * (usageTotalUsd, chargedEventCounts). Es una lectura de la API, no un run:
 * no cuesta ni pasa por la cola. La usa apifyCost.reconcileRealCosts
 * minutos después de que el run terminó, cuando el cobro ya está asentado.
 * @returns {Promise<{ id: string, status: string, usdReal: number|null, chargedEventCounts: object|null, finishedAt: string|null }>}
 */
async function fetchRunCost(runId) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  const body = await apifyRequest(`${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${token}`, { timeoutMs: 30000 });
  const run = body && typeof body === 'object' && body.data ? body.data : body || {};
  const usd = Number(run.usageTotalUsd);
  return {
    id: run.id || runId,
    status: run.status || null,
    usdReal: run.usageTotalUsd !== undefined && run.usageTotalUsd !== null && Number.isFinite(usd) ? usd : null,
    chargedEventCounts: run.chargedEventCounts || null,
    finishedAt: run.finishedAt || null,
  };
}

/**
 * Una request a la API de Apify con timeout, errores de red y de status
 * tipificados (ver abajo). Devuelve el JSON de la respuesta tal cual.
 * @param {string} url
 * @param {{ method?: string, body?: object, timeoutMs?: number }} [options]
 */
async function apifyRequest(url, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  // AbortController nos deja cancelar la llamada si tarda demasiado, para
  // devolver un mensaje claro en vez de quedar colgados.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
    // `code` tipificado (ver src/platforms/errors.js): el monitoreo distingue
    // un error de la plataforma entera (clave, cuota, rate limit), que tiene
    // que llegarle al usuario, de un fallo puntual de una fuente. La cuota
    // agotada viene como 403 con un texto fijo (isQuotaExceededError, abajo),
    // así que se mira antes que el status para no confundirla con una clave
    // inválida.
    if (isQuotaExceededError(e)) {
      e.code = 'QUOTA_EXCEEDED';
      e.userMessage = 'Se agotó la cuota mensual de Apify (APIFY_API_TOKEN). Esperá al próximo período o ampliá el plan.';
    } else if (text.includes(CONCURRENT_RUNS_ERROR)) {
      // Demasiados runs a la vez para el plan: runActorSync lo reintenta una
      // vez (ver arriba). Si el usuario llega a ver este error es porque el
      // reintento también falló.
      e.code = 'RATE_LIMITED';
      e.concurrentRunsLimit = true;
      e.userMessage =
        'Apify no acepta más runs simultáneos (límite del plan). Se reintentó una vez sin suerte: ' +
        'esperá unos segundos y volvé a probar, o bajá APIFY_MAX_CONCURRENT en el .env.';
    } else {
      if (resp.status === 401 || resp.status === 403) e.code = 'AUTH_INVALID';
      else if (resp.status === 429) e.code = 'RATE_LIMITED';
      e.userMessage = mapApifyError(resp.status);
    }
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
  if (status === 402) {
    return 'Apify rechazó la corrida por límites del plan (402). Revisá el uso y los límites en la consola de Apify.';
  }
  if (status === 404) {
    return 'No se encontró el actor de Apify o la URL. Verificá el link de la publicación.';
  }
  if (status === 429) {
    return 'Se alcanzó el límite de uso de Apify por el momento. Esperá unos minutos e intentá de nuevo.';
  }
  return 'El servicio de extracción (Apify) falló al procesar la publicación. Intentá de nuevo en unos minutos.';
}

// Texto exacto que devuelve Apify para el límite mensual duro del plan
// (visto en vivo: 403 {"error":{"type":"actor-disabled","message":"Monthly
// usage hard limit exceeded..."}}) — runActorSync lo deja adentro de
// err.message tal cual, así que un includes alcanza sin parsear el JSON.
// Compartida entre scripts/recalc-account-stats.js y src/metricsRefresh.js:
// los dos necesitan cortar la corrida en vez de seguir fallando cuenta por
// cuenta cuando se agota la cuota.
function isQuotaExceededError(err) {
  return String((err && err.message) || '').includes('Monthly usage hard limit exceeded');
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
    runActorSync(commentsInput, { plataforma: 'instagram' }),
    runActorSync(postInput, { plataforma: 'instagram' }),
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

module.exports = {
  scrapeInstagram,
  runActorSync,
  fetchRunCost,
  mapApifyError,
  isQuotaExceededError,
  // Para tests y diagnóstico: el limitador único del proceso y su tope.
  apifyLimiter,
  APIFY_MAX_CONCURRENT,
  APIFY_CALL_TIMEOUT_MS,
};
