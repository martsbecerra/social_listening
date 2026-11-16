// ==========================================================================
// searchWait.js
// --------------------------------------------------------------------------
// Cuánto espera el monitoreo a las búsquedas de Apify (noviembre 2026,
// openspec/changes/ventana-por-fuente). Sin dependencias: server.js lo valida
// al arrancar, antes de cargar el resto, como IG_ACTOR y REFRESH_MODE.
//
//   SEARCH_WAIT_MS            cuánto dura como mucho la detección de una red
//                             en un ciclo (default 15 min, piso 1 s). Es UNA
//                             espera para todas las búsquedas de esa red, no
//                             una por búsqueda: lo que no terminó al vencer
//                             queda "esperando" con el id de su corrida y se
//                             levanta al empezar el ciclo siguiente. Una
//                             búsqueda de una ventana de varios días tarda de
//                             7 a 13 minutos (medido el 16/11/2026): con los
//                             300 s de antes se cortaba, se cobraba y se
//                             perdía.
//   SEARCH_RUN_TIMEOUT_SECS   tope de la corrida EN APIFY (default 3600, piso
//                             60): Apify la corta ahí, para que una que nadie
//                             espera no quede corriendo.
// ==========================================================================

const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const MIN_WAIT_MS = 1000;
const DEFAULT_RUN_TIMEOUT_SECS = 3600;
const MIN_RUN_TIMEOUT_SECS = 60;

function invalid(name, raw, hint) {
  // El nombre de la variable va en el message (al log); el userMessage, sin él.
  const e = new Error(`${name}="${raw}" no es válido: ${hint}.`);
  e.userMessage = 'Falta configuración del servidor.';
  return e;
}

function readInt(env, name, { fallback, min, hint }) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isFinite(n) || n < min) throw invalid(name, raw, hint);
  return n;
}

/**
 * Los dos valores en uso. Un valor mal escrito tira (server.js aborta el
 * arranque con ese mensaje).
 * @returns {{ waitMs: number, runTimeoutSecs: number }}
 */
function resolveSearchWait(env = process.env) {
  return {
    waitMs: readInt(env, 'SEARCH_WAIT_MS', { fallback: DEFAULT_WAIT_MS, min: MIN_WAIT_MS, hint: `tiene que ser un entero de milisegundos, ${MIN_WAIT_MS} o más` }),
    runTimeoutSecs: readInt(env, 'SEARCH_RUN_TIMEOUT_SECS', {
      fallback: DEFAULT_RUN_TIMEOUT_SECS,
      min: MIN_RUN_TIMEOUT_SECS,
      hint: `tiene que ser un entero de segundos, ${MIN_RUN_TIMEOUT_SECS} o más`,
    }),
  };
}

/** Lo mismo, pero un valor mal escrito vale el default (para el ciclo, que no puede tirar por esto: ya se validó al arrancar). */
function searchWait(env = process.env) {
  try {
    return resolveSearchWait(env);
  } catch {
    return { waitMs: DEFAULT_WAIT_MS, runTimeoutSecs: DEFAULT_RUN_TIMEOUT_SECS };
  }
}

/** "15 min de espera por corrida · las corridas se cortan en Apify a los 60 min", para la línea del arranque. */
function describeSearchWait({ waitMs, runTimeoutSecs } = searchWait()) {
  const min = (ms) => (ms >= 60000 ? `${Math.round(ms / 6000) / 10} min`.replace('.', ',') : `${Math.round(ms / 1000)} s`);
  return `hasta ${min(waitMs)} por corrida para todas las búsquedas; lo que no termina se levanta en la corrida siguiente (Apify corta cada búsqueda a los ${min(runTimeoutSecs * 1000)})`;
}

module.exports = { resolveSearchWait, searchWait, describeSearchWait, DEFAULT_WAIT_MS, MIN_WAIT_MS, DEFAULT_RUN_TIMEOUT_SECS };
