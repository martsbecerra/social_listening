// ==========================================================================
// concurrencyLimiter.js
// --------------------------------------------------------------------------
// Cola FIFO mínima para acotar cuántas tareas asincrónicas corren a la vez.
// Sin dependencias. La usa src/apify.js (apifyLimiter, las llamadas REALES
// a Apify) y, cada uno con su PROPIA instancia (nunca la misma que
// apifyLimiter), src/accountStats.js y src/metricsRefresh.js para acotar
// cuántas cuentas de benchmark/refresco corren a la vez.
//
// IMPORTANTE — por qué cada nivel necesita su propio limitador: una tarea
// de "cuenta" (benchmark/refresco) termina llamando, más adentro, a
// runActorSync -> apifyLimiter. Si esa tarea de cuenta ocupara TAMBIÉN un
// cupo de apifyLimiter mientras espera su propia llamada interna, con
// límite N y N tareas de cuenta en vuelo, las N ya agotaron los N cupos de
// apifyLimiter antes de que ninguna llegue a pedir el suyo para la llamada
// real: ninguna puede terminar nunca (deadlock). Pasó en producción con
// benchmark/refresco (Cambio C original) — el fix es que cada capa tenga su
// cola separada; compartir el VALOR de APIFY_MAX_CONCURRENT entre capas
// está bien, compartir la INSTANCIA no.
//
// Logging siempre activo (sin flag de DEBUG, a propósito — ver Cambio G):
// cada vez que una tarea espera cupo, lo adquiere o lo libera, y expone qué
// tareas están activas en este momento (activeTargets) para el heartbeat
// del ciclo (src/scheduler.js).
// ==========================================================================

/**
 * @param {number} max cuántas tareas pueden estar en vuelo a la vez (mínimo 1;
 *   un valor inválido cae a 1, nunca a "sin límite").
 * @param {string} [label] prefijo de los logs de este limitador (ej. "apify", "benchmark").
 * @returns {{
 *   run: (fn: () => Promise<any>, target?: string) => Promise<any>,
 *   inFlight: () => number, pending: () => number, limit: number,
 *   activeTargets: () => Array<{ target: string|undefined, elapsedMs: number }>,
 * }}
 *   run(fn, target): ejecuta fn cuando hay lugar y devuelve su resultado (o
 *   su error); `target` es solo para los logs y activeTargets(), no afecta
 *   el orden ni el resultado.
 */
function createLimiter(max, label = 'limiter') {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  let inFlight = 0;
  const queue = [];
  // taskId -> { target, startedAt }: solo las que YA adquirieron su cupo
  // (las encoladas todavía no cuentan como "activas").
  const active = new Map();
  let nextTaskId = 0;

  const next = () => {
    if (inFlight >= limit || queue.length === 0) return;
    inFlight += 1;
    const { fn, resolve, reject, target, taskId } = queue.shift();
    active.set(taskId, { target, startedAt: Date.now() });
    console.log(`[limiter:${label}] cupo adquirido${target ? ` (${target})` : ''}: activos ${inFlight}/${limit}, cola ${queue.length}`);
    // release() SUELTA el cupo (inFlight, active, next()) ANTES de resolver
    // o rechazar la promesa que le devolvimos a quien llamó: así, apenas su
    // `await run(fn)` resuelve, inFlight()/activeTargets() ya reflejan el
    // cupo liberado — no un tick de microtareas después (que es lo que
    // pasa si primero se llama resolve/reject y recién después un .finally
    // hace la limpieza: quien llama podría leer el contador viejo).
    const release = () => {
      active.delete(taskId);
      inFlight -= 1;
      console.log(`[limiter:${label}] cupo liberado${target ? ` (${target})` : ''}: activos ${inFlight}/${limit}, cola ${queue.length}`);
      next();
    };
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          release();
          resolve(value);
        },
        (err) => {
          release();
          reject(err);
        }
      );
  };

  return {
    run(fn, target) {
      return new Promise((resolve, reject) => {
        const taskId = nextTaskId++;
        if (inFlight >= limit) {
          console.log(`[limiter:${label}] esperando cupo${target ? ` (${target})` : ''}: cola=${queue.length + 1} activos=${inFlight}/${limit}`);
        }
        queue.push({ fn, resolve, reject, target, taskId });
        next();
      });
    },
    inFlight: () => inFlight,
    pending: () => queue.length,
    limit,
    activeTargets: () => [...active.values()].map(({ target, startedAt }) => ({ target, elapsedMs: Date.now() - startedAt })),
  };
}

module.exports = { createLimiter };
