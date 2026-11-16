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
// Apify limita los Actor runs simultáneos y la memoria total según el plan
// (en la consola: Settings → Limits). La detección del monitoreo lanza
// todas las fuentes juntas y, en su momento con el plan Free (5 runs), 12
// cuentas + hashtags fallaban con 402 "concurrent-runs-limit-exceeded". Por eso
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
// POST /acts/{id}/runs (arranca el run y vuelve enseguida con su id), GET
// del run hasta que termine (dentro del plazo de la llamada) y GET de los
// items del dataset. Tres requests en vez de una, sin costo extra: la fila
// de apify_calls queda con el apify_run_id. El costo NO se lee al terminar: Apify asienta el cobro con
// demora (en el ciclo real del 2026-09-18, leído al terminar el run, 10 de
// 29 llamadas daban 0 y a las demás les faltaban los posteos extra; minutos
// después estaba completo). usd_real se concilia más tarde con
// fetchRunCost (apifyCost.reconcileRealCosts, que el scheduler corre al
// cerrar cada ciclo para las llamadas de ciclos anteriores).
// APIFY_REAL_COST=0 lo apaga (vuelve al sincrónico, sin run id ni costo
// real). El actor oficial (la publicación del análisis, el detalle, el
// refresco e IG_ACTOR=apify) sigue con el sincrónico de siempre: sus filas
// no tienen usd_real. Los comentarios del análisis (COMMENTS_ACTOR) van
// siempre por el asincrónico: con miles de comentarios pasan los 300 s del
// sincrónico.
//
// EL ID DEL RUN NUNCA SE PIERDE (noviembre 2026, ventana-por-fuente)
// --------------------------------------------------------------------------
// Hasta noviembre 2026 una llamada que pasaba su tope se cortaba con un
// Promise.race: el run seguía en Apify, se cobraba, y la app no guardaba ni
// su id (corridas #55 y #56 del piloto: diez búsquedas cortadas que
// terminaron bien, US$ 1,57 sin registrar y sus resultados perdidos). Ahora,
// en el flujo asincrónico:
//   - el POST que arranca el run no espera; apenas vuelve, la fila de
//     apify_calls se ABRE con el id (estado en_curso) y se avisa a quien
//     llamó (onRunStarted). Si el proceso muere ahí, el gasto ya quedó;
//   - el seguimiento tiene plazo propio; un 5xx, 408, 429, corte de red o
//     tiempo agotado de ESA lectura se reintenta (los dos 502 de la #56
//     tiraron búsquedas cuyo run siguió y terminó bien);
//   - al vencer el plazo el error lleva apifyRunId y runPending: el run NO
//     se aborta, quien llamó puede levantarlo después (fetchRun,
//     fetchDatasetItems);
//   - un run que Apify cortó (FAILED, ABORTED, TIMED-OUT) entrega lo que
//     dejó en el dataset (err.partialItems), que igual se cobró;
//   - el POST nunca se reintenta por su cuenta (crearía otro run pago): el
//     único reintento es el del 402 por runs simultáneos, que no creó nada.
// ==========================================================================

const { createLimiter } = require('./concurrencyLimiter');
const { getContext } = require('./usageContext');
const { recordApifyCall, openApifyCall, closeApifyCall, describeInput } = require('./apifyCost');

// Nombre del actor en la API (el "/" se escribe como "~")
const APIFY_ACTOR = 'apify~instagram-scraper';
// Los comentarios del análisis, con sus respuestas (fase G): el oficial no
// trae respuestas. Cobra por resultado, como el oficial (apifyCost.js), y
// cada respuesta es un resultado.
const COMMENTS_ACTOR = 'apify~instagram-comment-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';

// Cuánto esperamos como máximo antes de cortar por nuestra cuenta (5 min).
const REQUEST_TIMEOUT_MS = 300000;

// Runs simultáneos permitidos a esta app. 10 (era 3, pensado para los 5
// runs del plan Free): con el plan pago, 10 en vuelo corrieron ciclos
// reales sin un solo 402 (septiembre 2026) y el ciclo dura la mitad. Si tu
// plan permite menos runs o menos memoria (Settings → Limits en la consola
// de Apify), bajalo en el .env; si permite más, subilo.
const APIFY_MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.APIFY_MAX_CONCURRENT) || 10));
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
// Reintentos de una lectura del seguimiento (o del dataset) que falló por
// algo pasajero: esperas crecientes, y la última se repite mientras quede
// plazo. APIFY_POLL_RETRY_MS (solo para tests) las deja todas en ese valor.
const POLL_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000];
function pollRetryDelayMs(attempt) {
  const fixed = parseDelayMs(process.env.APIFY_POLL_RETRY_MS, null);
  if (fixed != null) return fixed;
  return POLL_RETRY_DELAYS_MS[Math.min(attempt, POLL_RETRY_DELAYS_MS.length - 1)];
}
// Cuántas veces se reintenta bajar el dataset de un run ya terminado.
const DATASET_RETRIES = 4;
// La guarda contra un cuelgue (withTimeout) salta este rato después del
// plazo propio del flujo asincrónico, que es el que conserva el id del run.
const ASYNC_GUARD_MS = 30000;
// Con menos que esto de plazo no vale la pena arrancar ni seguir esperando.
const MIN_WAIT_MS = 1000;

// Cuelgue de ~30 minutos visto en vivo (Cambio G): timeout de seguridad por
// llamada, aparte del REQUEST_TIMEOUT_MS de cada request HTTP individual —
// cubre también un bucle de espera que nunca termina. Cada intento de
// once() (el inicial y el único reintento por 402) lo respeta por separado.
// 5 minutos (era 2): hubo consultas reales de 84, 87 y 106 s, y una que
// pasa el tope se corta, se cobra igual y sus resultados se pierden. El
// timeout es contra el cuelgue, no contra una consulta lenta.
const APIFY_CALL_TIMEOUT_MS = Math.max(1000, Math.floor(Number(process.env.APIFY_CALL_TIMEOUT_MS) || 300000));
// Los comentarios de un análisis con miles de comentarios y sus respuestas
// tardan más que eso: su llamada tiene su propio tope, 30 minutos.
const ANALISIS_COMMENTS_TIMEOUT_MS = 30 * 60 * 1000;

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
 * @param {{ actorId?: string, plataforma: string, onQueued?: () => void, onAcquired?: () => void, timeoutMs?: number,
 *   asincronico?: boolean, deadlineAt?: number, runTimeoutSecs?: number, recuperable?: boolean,
 *   onRunStarted?: (run: { id: string, datasetId: string|null }) => void }} options -
 *   Actor a correr. Por defecto el oficial (la publicación del análisis,
 *   abajo, no lo pasa); los adapters de src/platforms/ pasan el suyo, así
 *   este módulo queda genérico. plataforma: para la fila de apify_calls,
 *   obligatoria (sin default a instagram: el gasto de otra red no se
 *   etiqueta como Instagram en silencio). onQueued / onAcquired: avisos
 *   para el progreso del análisis (tuvo que esperar cupo / lo consiguió);
 *   un error suyo no afecta la llamada. timeoutMs: el tope de la llamada,
 *   APIFY_CALL_TIMEOUT_MS si no se pasa; uno mayor que REQUEST_TIMEOUT_MS
 *   va siempre por el flujo asincrónico (el sincrónico de Apify corta a
 *   los 300 s) y espera el run hasta ese tope.
 *   asincronico: fuerza el flujo asincrónico (las búsquedas del monitoreo:
 *   necesitan el id del run aunque APIFY_REAL_COST=0). deadlineAt: instante
 *   (ms) hasta el que se espera, en vez de timeoutMs; se mide cuando la
 *   llamada consigue su cupo, y si ya pasó NO se lanza nada (error code
 *   NO_LANZADA, sin fila: no hubo llamada). runTimeoutSecs: tope del run en
 *   Apify (lo corta Apify, no esta app). recuperable: quien llama va a
 *   levantar después un run que no se llegó a esperar (la fila queda
 *   `esperando` en vez de `error`) y usa lo que deje un run cortado
 *   (`parcial`). onRunStarted: aviso apenas Apify devuelve el run.
 * @returns {Promise<Array>} Lista de items scrapeados.
 */
async function runActorSync(
  input,
  {
    actorId = APIFY_ACTOR,
    plataforma,
    onQueued,
    onAcquired,
    timeoutMs = APIFY_CALL_TIMEOUT_MS,
    asincronico = false,
    deadlineAt = null,
    runTimeoutSecs = null,
    recuperable = false,
    onRunStarted = null,
  } = {}
) {
  if (typeof plataforma !== 'string' || !plataforma.trim()) {
    throw new Error('runActorSync: falta plataforma (instagram | x); no hay default.');
  }
  const { target } = describeInput(input);
  return apifyLimiter.run(async () => {
    if (typeof onAcquired === 'function') {
      try {
        onAcquired();
      } catch {
        /* el aviso no frena la llamada */
      }
    }
    // Con vencimiento compartido (las búsquedas de un ciclo): lo que queda
    // se mide recién acá, con el cupo en la mano. Si ya venció no se le pide
    // nada a Apify.
    let waitMs = timeoutMs;
    if (deadlineAt != null) {
      waitMs = Number(deadlineAt) - Date.now();
      if (!(waitMs >= MIN_WAIT_MS)) {
        const e = new Error(`Apify: no se lanzó la consulta${target ? ` (${target})` : ''}: venció la espera antes de conseguir cupo.`);
        e.code = 'NO_LANZADA';
        e.userMessage = 'No se llegó a lanzar la consulta: venció la espera de esta corrida.';
        throw e;
      }
    }
    const context = getContext();
    const phase = (context && context.phase) || 'desconocida';
    const startedAt = Date.now();
    const base = {
      runId: context && context.runId != null ? context.runId : null,
      analisisId: context && context.analisisId != null ? context.analisisId : null,
      phase,
      plataforma,
      actor: actorId,
      input,
    };
    // En el flujo asincrónico la fila se abre cuando Apify devuelve el run
    // (ver encabezado) y acá solo se cierra; en el sincrónico se registra al
    // final, como siempre.
    const handle = { runId: null, datasetId: null, rowId: null };
    const record = ({ items, error, run }) => {
      const pending = Boolean(error && error.runPending);
      const partial = error && Array.isArray(error.partialItems) ? error.partialItems.length : 0;
      const call = {
        ...base,
        items: error ? partial : Array.isArray(items) ? items.length : 0,
        ok: !error,
        error: error ? describeError(error) : null,
        durationMs: Date.now() - startedAt,
        // usd_real queda vacío acá a propósito: se concilia después (ver encabezado).
        apifyRunId: run ? run.id : (error && error.apifyRunId) || handle.runId || null,
        estado: !error ? 'ok' : recuperable && pending ? 'esperando' : recuperable && partial > 0 ? 'parcial' : 'error',
      };
      if (handle.rowId != null) closeApifyCall(handle.rowId, call);
      else recordApifyCall(call);
    };
    const started = (run) => {
      handle.runId = run.id;
      handle.datasetId = run.datasetId || null;
      handle.rowId = openApifyCall({ ...base, apifyRunId: run.id });
      if (typeof onRunStarted === 'function') {
        try {
          onRunStarted({ id: run.id, datasetId: run.datasetId || null });
        } catch {
          /* el aviso no frena la llamada */
        }
      }
    };
    // once() respeta el tope por intento (Cambio G: un cuelgue real de ~30
    // min sin timeout mató el proceso a mano). No cuenta como "de
    // plataforma" (ver platforms/errors.js): una sola cuenta/hashtag con
    // timeout se loguea y se sigue, no tira abajo el resto del ciclo.
    const useAsync = usesRealCost(actorId) || asincronico || waitMs > REQUEST_TIMEOUT_MS;
    const once = () =>
      useAsync
        ? withTimeout(runActorRealCostOnce(input, actorId, { maxWaitMs: waitMs, runTimeoutSecs, onRunStarted: started }), waitMs + ASYNC_GUARD_MS, target).catch((err) => {
            // La guarda saltó con el run ya creado: el id no se pierde.
            if (err && err.code === 'TIMEOUT' && !err.apifyRunId && handle.runId) {
              err.apifyRunId = handle.runId;
              err.datasetId = handle.datasetId;
              err.runPending = true;
            }
            throw err;
          })
        : withTimeout(runActorSyncOnce(input, actorId).then((items) => ({ items, run: null })), waitMs, target);

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
        console.error(
          `[apify] ← TIMEOUT target=${target || '(sin target)'} tras ${durationMs}ms (tope ${Math.round(waitMs)}ms)` +
            (err.apifyRunId ? `; el run ${err.apifyRunId} sigue en Apify${recuperable ? ' y se levanta después' : ''}` : '')
        );
      } else {
        console.error(`[apify] ← error target=${target || '(sin target)'} en ${durationMs}ms: ${describeError(err)}`);
      }
      record({ error: err });
      throw err;
    }
    console.log(`[apify] ← ok target=${target || '(sin target)'} en ${Date.now() - startedAt}ms, items=${(result.items || []).length}`);
    record({ items: result.items, run: result.run });
    return result.items;
  }, target, { onQueued });
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

const unwrapRun = (body) => (body && typeof body === 'object' && !Array.isArray(body) && body.data ? body.data : body);

/** ¿Vale la pena reintentar esa lectura? 5xx, 408, 429, corte de red o tiempo agotado de la request. */
function isTransientReadError(err) {
  if (!err) return false;
  if (err.network || err.requestTimeout) return true;
  const status = Number(err.status);
  return status >= 500 || status === 408 || status === 429;
}

/** El error de "se dejó de esperar": el run sigue en Apify con su id. */
function pendingRunError(run, maxWaitMs, cause) {
  const e = new Error(
    `Apify: se superó la espera (${Math.round(maxWaitMs)}ms); el run ${run.id} sigue en ${run.status || 'curso'}` +
      (cause ? ` (última lectura: ${describeError(cause)})` : '')
  );
  e.code = 'TIMEOUT';
  e.userMessage = 'La consulta a Apify tardó demasiado y se dejó de esperar. Probá de nuevo en unos minutos.';
  e.apifyRunId = run.id;
  e.datasetId = run.defaultDatasetId || null;
  e.runPending = true;
  return e;
}

/**
 * Los items de un dataset, con reintento de los fallos pasajeros. Lectura
 * de la API: no cuesta ni pasa por la cola.
 * @param {string} datasetId
 * @param {{ retries?: number }} [options]
 * @returns {Promise<Array>}
 */
async function fetchDatasetItems(datasetId, { retries = DATASET_RETRIES } = {}) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const items = await apifyRequest(`${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?token=${token}`, { timeoutMs: REAL_COST_REQUEST_TIMEOUT_MS });
      return Array.isArray(items) ? items : [];
    } catch (err) {
      if (!isTransientReadError(err) || attempt >= retries) throw err;
      await sleep(pollRetryDelayMs(attempt));
    }
  }
}

/**
 * Flujo asincrónico (ver encabezado): arranca el run sin esperar, lo sigue
 * de a 60 s hasta `maxWaitMs` (REQUEST_TIMEOUT_MS si no se pasa) y baja los
 * items del dataset. Devuelve el id del run para conciliar el costo después.
 * Errores, siempre con err.apifyRunId si el run llegó a existir:
 *   - venció la espera (o el dataset de un run terminado no se pudo bajar):
 *     code TIMEOUT y runPending, el run se puede levantar después;
 *   - el run no terminó en SUCCEEDED: el estado y el statusMessage de
 *     Apify, runStatus y partialItems (lo que dejó, [] si no se pudo leer);
 *   - una lectura rechazada sin vuelta (401, 403, 404): tal cual.
 * @param {{ maxWaitMs?: number, runTimeoutSecs?: number|null, onRunStarted?: (run: { id: string, datasetId: string|null }) => void }} [options]
 * @returns {Promise<{ items: Array, run: { id: string, datasetId: string|null } }>}
 */
async function runActorRealCostOnce(input, actorId, { maxWaitMs = REQUEST_TIMEOUT_MS, runTimeoutSecs = null, onRunStarted = null } = {}) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  const deadline = Date.now() + maxWaitMs;
  const secs = Math.floor(Number(runTimeoutSecs));
  const timeoutParam = Number.isFinite(secs) && secs > 0 ? `&timeout=${secs}` : '';

  // Sin waitForFinish: el POST vuelve enseguida con el id. No se reintenta
  // (un segundo POST sería otro run pago).
  let run = unwrapRun(
    await apifyRequest(`${APIFY_BASE}/acts/${actorId}/runs?token=${token}${timeoutParam}`, { timeoutMs: REAL_COST_REQUEST_TIMEOUT_MS, method: 'POST', body: input })
  );
  if (!run || !run.id) {
    const e = new Error('Apify no devolvió el run al arrancar el actor.');
    e.userMessage = 'El servicio de extracción (Apify) no confirmó la corrida. Intentá de nuevo en unos minutos.';
    throw e;
  }
  if (typeof onRunStarted === 'function') {
    try {
      onRunStarted({ id: run.id, datasetId: run.defaultDatasetId || null });
    } catch {
      /* el aviso no frena la llamada */
    }
  }

  let retries = 0;
  let lastReadError = null;
  while (!TERMINAL_STATUSES.includes(run.status)) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_WAIT_MS) throw pendingRunError(run, maxWaitMs, lastReadError);
    const waitSecs = Math.max(1, Math.min(REAL_COST_WAIT_SECS, Math.floor(remaining / 1000)));
    try {
      const next = unwrapRun(
        await apifyRequest(`${APIFY_BASE}/actor-runs/${run.id}?token=${token}&waitForFinish=${waitSecs}`, { timeoutMs: (waitSecs + 30) * 1000 })
      );
      if (next && next.id) run = next;
      retries = 0;
      lastReadError = null;
    } catch (err) {
      if (!isTransientReadError(err)) {
        err.apifyRunId = run.id;
        throw err;
      }
      lastReadError = err;
      const delay = pollRetryDelayMs(retries);
      retries += 1;
      if (Date.now() + delay >= deadline) throw pendingRunError(run, maxWaitMs, err);
      console.warn(`[apify] el seguimiento del run ${run.id} falló (${describeError(err).slice(0, 80)}); se reintenta en ${delay} ms.`);
      await sleep(delay);
    }
  }

  if (run.status !== 'SUCCEEDED') {
    const e = new Error(`El run ${run.id} de Apify terminó en ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ''}`);
    e.userMessage = `La corrida de Apify terminó en ${run.status}. Revisá el run ${run.id} en la consola de Apify.`;
    e.apifyRunId = run.id;
    e.runStatus = run.status;
    // Lo que alcanzó a dejar en el dataset se cobró igual: que no se pierda.
    e.partialItems = [];
    if (run.defaultDatasetId) {
      try {
        e.partialItems = await fetchDatasetItems(run.defaultDatasetId, { retries: 1 });
      } catch {
        /* sin lectura: queda vacío */
      }
    }
    throw e;
  }

  let items;
  try {
    items = await fetchDatasetItems(run.defaultDatasetId);
  } catch (err) {
    // El run terminó bien y sus resultados siguen en Apify: se puede levantar después.
    if (isTransientReadError(err)) throw pendingRunError(run, maxWaitMs, err);
    err.apifyRunId = run.id;
    throw err;
  }
  return { items, run: { id: run.id, datasetId: run.defaultDatasetId || null } };
}

/**
 * Un run de Apify tal como está ahora: GET /v2/actor-runs/{id}. Lectura de
 * la API: no cuesta ni pasa por la cola. Un 404 tira con err.status 404 (el
 * run ya no existe).
 * @returns {Promise<{ id: string, status: string|null, datasetId: string|null, statusMessage: string|null,
 *   startedAt: string|null, finishedAt: string|null, usdReal: number|null, chargedEventCounts: object|null }>}
 */
async function fetchRun(runId) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  const run = unwrapRun(await apifyRequest(`${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${token}`, { timeoutMs: 30000 })) || {};
  const usd = Number(run.usageTotalUsd);
  return {
    id: run.id || runId,
    status: run.status || null,
    datasetId: run.defaultDatasetId || null,
    statusMessage: run.statusMessage || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    usdReal: run.usageTotalUsd !== undefined && run.usageTotalUsd !== null && Number.isFinite(usd) ? usd : null,
    chargedEventCounts: run.chargedEventCounts || null,
  };
}

/**
 * Las corridas de un actor en Apify, de la más nueva a la más vieja, hasta
 * `sinceMs`. Lecturas de la API (GET /v2/acts/{id}/runs): no cuestan ni
 * pasan por la cola. Sirve para encontrar corridas que la app no registró.
 * @returns {Promise<{ id: string, status: string|null, startedAt: string|null, finishedAt: string|null, usdReal: number|null }[]>}
 */
async function listActorRuns(actorId, { sinceMs = 0, max = 2000 } = {}) {
  const token = encodeURIComponent(process.env.APIFY_API_TOKEN);
  const out = [];
  for (let offset = 0; offset < max; offset += 250) {
    const body = unwrapRun(await apifyRequest(`${APIFY_BASE}/acts/${actorId}/runs?token=${token}&desc=true&limit=250&offset=${offset}`, { timeoutMs: 30000 }));
    const items = (body && Array.isArray(body.items) && body.items) || [];
    for (const run of items) {
      if (sinceMs && Date.parse(run.startedAt) < sinceMs) return out;
      const usd = Number(run.usageTotalUsd);
      out.push({
        id: run.id,
        status: run.status || null,
        startedAt: run.startedAt || null,
        finishedAt: run.finishedAt || null,
        usdReal: run.usageTotalUsd !== undefined && run.usageTotalUsd !== null && Number.isFinite(usd) ? usd : null,
      });
    }
    if (items.length < 250) break;
  }
  return out;
}

/**
 * Lo que Apify cobró por un run ya terminado (usageTotalUsd,
 * chargedEventCounts). La usa apifyCost.reconcileRealCosts minutos después
 * de que el run terminó, cuando el cobro ya está asentado.
 * @returns {Promise<{ id: string, status: string, usdReal: number|null, chargedEventCounts: object|null, finishedAt: string|null }>}
 */
async function fetchRunCost(runId) {
  const { id, status, usdReal, chargedEventCounts, finishedAt } = await fetchRun(runId);
  return { id, status, usdReal, chargedEventCounts, finishedAt };
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
      e.requestTimeout = true;
      throw e;
    }
    const e = new Error(`Error de red al llamar a Apify: ${err.message}`);
    e.userMessage = 'No se pudo conectar con el servicio de extracción. Revisá tu conexión a internet e intentá de nuevo.';
    e.network = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const e = new Error(`Apify respondió ${resp.status}: ${text}`);
    e.status = resp.status;
    // `code` tipificado (ver src/platforms/errors.js): el monitoreo distingue
    // un error de la plataforma entera (clave, cuota, rate limit), que tiene
    // que llegarle al usuario, de un fallo puntual de una fuente. La cuota
    // agotada viene como 403 con un texto fijo (isQuotaExceededError, abajo),
    // así que se mira antes que el status para no confundirla con una clave
    // inválida.
    // Ningún userMessage nombra una variable del .env (va al navegador): el
    // nombre de la variable queda en el log.
    if (isQuotaExceededError(e)) {
      e.code = 'QUOTA_EXCEEDED';
      e.userMessage = 'Se agotó la cuota mensual de Apify. Esperá al próximo período o ampliá el plan.';
    } else if (text.includes(CONCURRENT_RUNS_ERROR)) {
      // Demasiados runs a la vez para el plan: runActorSync lo reintenta una
      // vez (ver arriba, el aviso del log nombra APIFY_MAX_CONCURRENT). Si el
      // usuario llega a ver este error es porque el reintento también falló.
      e.code = 'RATE_LIMITED';
      e.concurrentRunsLimit = true;
      e.userMessage =
        'Apify no acepta más runs simultáneos (límite del plan). Se reintentó una vez sin suerte: ' +
        'esperá unos segundos y volvé a probar.';
    } else {
      if (resp.status === 401 || resp.status === 403) {
        e.code = 'AUTH_INVALID';
        console.error(`[apify] Apify respondió ${resp.status}: revisá APIFY_API_TOKEN en el .env.`);
      } else if (resp.status === 429) e.code = 'RATE_LIMITED';
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
    return 'La clave de Apify del servidor es inválida o no tiene permisos. Falta configuración del servidor.';
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

// Cuántos ítems (comentarios y respuestas) trae como mucho un análisis:
// COMMENTS_LIMIT, 3.000 por defecto (decisión del dueño, fase G), hasta
// COMMENTS_LIMIT_MAX. Cada ítem devuelto se cobra (0,0023 dólares en
// Starter): 3.000 son unos 6,90. Con más de 1.000 comentarios según
// Instagram el análisis pide confirmación antes (src/analysisJob.js). Se
// lee en cada análisis.
const COMMENTS_LIMIT_DEFAULT = 3000;
const COMMENTS_LIMIT_MAX = 5000;
// El actor cuenta solo los comentarios de primer nivel: las respuestas
// llegan de más. En la sonda del 25/10/2026, 10 pedidos trajeron 16 ítems
// (1,6 por comentario): para unos T ítems se le piden T / 1,6.
const FACTOR_RESPUESTAS_DEFAULT = 1.6;

function resolveCommentsLimit() {
  const n = Number(process.env.COMMENTS_LIMIT);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), COMMENTS_LIMIT_MAX);
  return COMMENTS_LIMIT_DEFAULT;
}

/** ANALISIS_FACTOR_RESPUESTAS: ítems por comentario de primer nivel (1 o más; 1,6 por defecto). */
function resolveFactorRespuestas() {
  const raw = process.env.ANALISIS_FACTOR_RESPUESTAS;
  const n = Number(String(raw ?? '').replace(',', '.'));
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 1 ? n : FACTOR_RESPUESTAS_DEFAULT;
}

/**
 * El resultsLimit que se le pide al actor de comentarios para traer unos
 * `tope` ítems. Si Instagram informa N comentarios y N cabe en el tope, N
 * (ese número ya cuenta las respuestas: alcanza para traer todo); si no se
 * sabe o no cabe, tope / ANALISIS_FACTOR_RESPUESTAS.
 * @param {number|null} comentariosInstagram post.commentsCount
 * @param {number} [tope] los ítems que se quieren, COMMENTS_LIMIT por defecto
 */
function commentsResultsLimit(comentariosInstagram, tope = resolveCommentsLimit()) {
  const n = Number(comentariosInstagram);
  if (comentariosInstagram !== null && comentariosInstagram !== undefined && Number.isFinite(n) && n > 0 && n <= tope) return Math.floor(n);
  return Math.max(1, Math.ceil(tope / resolveFactorRespuestas()));
}

/**
 * La corrida de la PUBLICACIÓN de un análisis (modo "posts", un ítem). Va
 * aparte de la de los comentarios para que cada una avise al terminar (el
 * progreso del análisis, src/analysisJob.js); las dos corren en paralelo.
 * @param {string} postUrl
 * @param {{ onQueued?: () => void, onAcquired?: () => void }} [hooks]
 * @returns {Promise<Array>} los ítems crudos
 */
function fetchAnalysisPost(postUrl, hooks = {}) {
  return runActorSync({ directUrls: [postUrl], resultsType: 'posts', resultsLimit: 1 }, { plataforma: 'instagram', ...hooks });
}

/**
 * La corrida de los COMENTARIOS de un análisis, con sus respuestas
 * (COMMENTS_ACTOR con includeNestedComments; ver normalizeComments). Su
 * `resultsLimit` cuenta SOLO los comentarios de primer nivel: las
 * respuestas llegan aparte, de más (sonda del 25/10/2026: 10 pedidos, 10 +
 * 6 respuestas). El trabajo del análisis pasa el suyo
 * (commentsResultsLimit con el número de Instagram); sin él, el de un
 * análisis sin ese número. Tiene su propio tope de tiempo
 * (ANALISIS_COMMENTS_TIMEOUT_MS).
 * @param {string} postUrl
 * @param {{ onQueued?: () => void, onAcquired?: () => void }} [hooks]
 * @param {{ resultsLimit?: number }} [options]
 * @returns {Promise<{ items: Array, limit: number }>} los ítems crudos y el tope pedido
 */
async function fetchAnalysisComments(postUrl, hooks = {}, { resultsLimit = commentsResultsLimit(null) } = {}) {
  const items = await runActorSync(
    { directUrls: [postUrl], resultsLimit, includeNestedComments: true },
    { actorId: COMMENTS_ACTOR, plataforma: 'instagram', timeoutMs: ANALISIS_COMMENTS_TIMEOUT_MS, ...hooks }
  );
  return { items, limit: resultsLimit };
}

/**
 * Junta lo que trajeron las dos corridas: la publicación y los comentarios
 * normalizados (con sus respuestas), y los conteos para el log.
 * @returns {{ post: object, comments: Array, scrapeMeta: object }}
 */
function buildAnalysisData(postItems, commentItems, postUrl, commentsLimitRequested = null) {
  const rawCommentItems = Array.isArray(commentItems) ? commentItems.length : 0;
  const post = normalizePost(postItems, commentItems, postUrl);
  const comments = normalizeComments(commentItems);
  const primerNivel = Array.isArray(commentItems) ? commentItems.filter((c) => c && !esItemRespuesta(c)).length : 0;
  const scrapeMeta = {
    commentsLimitRequested,
    rawCommentItems,
    primerNivel,
    respuestas: rawCommentItems - primerNivel,
    commentsOnPost: post.commentsCount,
    comentariosTrasNormalizar: comments.length,
  };
  if (Number.isFinite(commentsLimitRequested) && primerNivel > 0 && primerNivel < commentsLimitRequested) {
    console.warn(
      `[apify] Apify devolvió ${primerNivel} comentarios de primer nivel (y ${rawCommentItems - primerNivel} respuestas), menos que los ${commentsLimitRequested} pedidos.` +
        (post.commentsCount != null && post.commentsCount > rawCommentItems ? ` Instagram reporta ${post.commentsCount} comentarios en el post, con las respuestas.` : '')
    );
  }
  return { post, comments, scrapeMeta };
}

/**
 * Las dos corridas del análisis juntas (publicación y comentarios, en
 * paralelo), para quien no necesita los avisos de cada una.
 * @param {string} postUrl
 * @returns {Promise<{ post: object, comments: Array, scrapeMeta: object }>}
 */
async function scrapeInstagram(postUrl) {
  const [postItems, { items: commentItems, limit }] = await Promise.all([fetchAnalysisPost(postUrl), fetchAnalysisComments(postUrl)]);
  return buildAnalysisData(postItems, commentItems, postUrl, limit);
}

// El actor devuelve -1 en likesCount cuando el autor ocultó los "me gusta"
// (igual que en src/platforms/instagramApify.js): es "sin dato", null,
// nunca -1 ni 0.
function countOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Toma los datos crudos del posteo y los deja en un formato limpio y predecible.
 * Los nombres de campos que devuelve Apify pueden variar según la versión del
 * actor, por eso probamos varias alternativas ("??" usa la primera que exista).
 * Suma lo que el análisis guarda y muestra: el id y el código, la fecha de
 * publicación (para "Cuándo comentaron"), el tipo y el link de la foto (para
 * su copia, sin pedir nada más: src/postImages.js). El tipo y la foto salen
 * de las mismas funciones del monitoreo (instagramApify.derivePostType y
 * pickImageUrl), pedidas recién acá porque ese módulo requiere a este.
 *
 * Sin la corrida de la publicación, cuenta, likes y texto quedan sin dato:
 * los campos de primer nivel de un ítem de comentario (ownerUsername,
 * likesCount) son DEL COMENTARIO, nunca del posteo. Antes se tomaban como
 * respaldo y el informe ponía al primer comentarista como autor.
 * `commentItems` queda en la firma por quienes lo pasan; no se lee.
 */
function normalizePost(postItems, commentItems, postUrl) {
  const raw = (Array.isArray(postItems) && postItems[0]) || {};
  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');
  const { derivePostType, pickImageUrl } = require('./platforms/instagramApify');
  const hasPost = Object.keys(raw).length > 0;

  return {
    url: postUrl,
    id: hasPost && pick(raw.id, raw.pk) != null ? String(pick(raw.id, raw.pk)) : null,
    shortCode: hasPost ? pick(raw.shortCode, raw.code, null) : null,
    ownerFullName: pick(raw.ownerFullName, 'N/D'),
    ownerUsername: pick(raw.ownerUsername, 'N/D'),
    caption: pick(raw.caption, ''),
    likesCount: countOrNull(pick(raw.likesCount, null)),
    commentsCount: countOrNull(pick(raw.commentsCount, null)),
    videoPlayCount: countOrNull(pick(raw.videoPlayCount, raw.videoViewCount, null)),
    postedAt: hasPost ? pick(raw.timestamp, null) : null,
    postType: hasPost ? derivePostType(raw) : null,
    imageUrl: hasPost ? pickImageUrl(raw) : null,
    // El lugar que la cuenta le puso a la publicación (fase H): el modelo lo
    // usa para "acá en la plaza". El actor lo trae solo si lo tiene.
    locationName: hasPost && typeof raw.locationName === 'string' && raw.locationName.trim() ? raw.locationName.trim() : null,
  };
}

// Una respuesta es un ítem propio con parentCommentUrl
// (…/c/<id del padre>/) y un commentUrl que termina en /r/…; el padre trae
// repliesCount, las que declara Instagram (no siempre llegan todas: en la
// sonda, 6 de 10). `replies` viene siempre null.
function esItemRespuesta(c) {
  return typeof c.parentCommentUrl === 'string' && c.parentCommentUrl.trim() !== '';
}

function parentIdOf(c) {
  const m = esItemRespuesta(c) ? c.parentCommentUrl.match(/\/c\/(\d+)/) : null;
  return m ? m[1] : null;
}

/**
 * Deja cada comentario en un formato limpio con solo los campos que necesitamos.
 * El orden del array no se garantiza; commentSample.js lo normaliza antes del análisis.
 * Likes sin dato (o negativos) quedan null, no 0: "sin dato" no es cero.
 * Una respuesta lleva `esRespuesta` y el id de su padre (`parentApifyId`,
 * null si el link no lo trae); un comentario de primer nivel, las
 * respuestas que declara Instagram (`respuestasDeclaradas`).
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
      likesCount: countOrNull(c.likesCount),
      timestamp: c.timestamp || null,
      text: c.text.trim(),
      esRespuesta: esItemRespuesta(c),
      parentApifyId: parentIdOf(c),
      respuestasDeclaradas: esItemRespuesta(c) ? null : countOrNull(c.repliesCount),
    }));
}

module.exports = {
  scrapeInstagram,
  fetchAnalysisPost,
  fetchAnalysisComments,
  buildAnalysisData,
  normalizePost,
  normalizeComments,
  resolveCommentsLimit,
  resolveFactorRespuestas,
  commentsResultsLimit,
  COMMENTS_LIMIT_DEFAULT,
  COMMENTS_LIMIT_MAX,
  COMMENTS_ACTOR,
  ANALISIS_COMMENTS_TIMEOUT_MS,
  runActorSync,
  fetchRunCost,
  fetchRun,
  fetchDatasetItems,
  listActorRuns,
  mapApifyError,
  isQuotaExceededError,
  // Para tests y diagnóstico: el limitador único del proceso y su tope.
  apifyLimiter,
  APIFY_MAX_CONCURRENT,
  APIFY_CALL_TIMEOUT_MS,
};
