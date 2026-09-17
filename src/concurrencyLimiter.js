// ==========================================================================
// concurrencyLimiter.js
// --------------------------------------------------------------------------
// Cola FIFO mínima para acotar cuántas tareas asincrónicas corren a la vez.
// Sin dependencias. La usa src/apify.js para no superar los Actor runs
// simultáneos que permite el plan de Apify (5 en el plan Free): cada
// llamada espera su turno en orden de llegada y, cuando termina (bien o
// mal), libera el lugar para la siguiente.
// ==========================================================================

/**
 * @param {number} max cuántas tareas pueden estar en vuelo a la vez (mínimo 1;
 *   un valor inválido cae a 1, nunca a "sin límite").
 * @returns {{ run: (fn: () => Promise<any>) => Promise<any>, inFlight: () => number, pending: () => number, limit: number }}
 *   run(fn): ejecuta fn cuando hay lugar y devuelve su resultado (o su error).
 */
function createLimiter(max) {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  let inFlight = 0;
  const queue = [];

  const next = () => {
    if (inFlight >= limit || queue.length === 0) return;
    inFlight += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        inFlight -= 1;
        next();
      });
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    inFlight: () => inFlight,
    pending: () => queue.length,
    limit,
  };
}

module.exports = { createLimiter };
