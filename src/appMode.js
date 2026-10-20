// ==========================================================================
// appMode.js — Interruptor APP_MODE.
// --------------------------------------------------------------------------
// En qué modo arranca el server (ver openspec/changes/replicas-solo-lectura):
//   - "principal" (default): la app de siempre. Monitorea (scheduler, Apify,
//     LLM), pide login y, si REPLICA_PUBLISH_DIR está configurado, publica
//     un snapshot de los datos al cerrar cada ciclo.
//   - "replica": copia de solo lectura para las máquinas de la red. Sin
//     scheduler ni claves, escucha solo en 127.0.0.1, sin login, y responde
//     403 a todo lo que no sea GET/HEAD.
// Un valor desconocido aborta el arranque (server.js lo valida antes de
// cargar los módulos), igual que IG_ACTOR y REFRESH_MODE.
// ==========================================================================

const APP_MODES = ['principal', 'replica'];
const DEFAULT_APP_MODE = 'principal';

/**
 * @param {string} [raw] valor de APP_MODE (por defecto, el del entorno).
 * @returns {'principal'|'replica'}
 * @throws {Error} con userMessage si el valor no es válido.
 */
function resolveAppMode(raw = process.env.APP_MODE) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (value === '') return DEFAULT_APP_MODE;
  if (APP_MODES.includes(value)) return value;
  const e = new Error(
    `APP_MODE="${raw}" no es válido. Valores posibles: ${APP_MODES.map((v) => `"${v}"`).join(' o ')} ` +
      `(vacío = "${DEFAULT_APP_MODE}"). Revisá el archivo .env.`
  );
  e.userMessage = e.message;
  throw e;
}

/** true si el entorno pide modo réplica. Tira si APP_MODE no es válido. */
function isReplica(env = process.env) {
  return resolveAppMode(env.APP_MODE) === 'replica';
}

module.exports = { APP_MODES, DEFAULT_APP_MODE, resolveAppMode, isReplica };
