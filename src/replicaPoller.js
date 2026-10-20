// ==========================================================================
// replicaPoller.js — La réplica se entera de que hay datos nuevos.
// --------------------------------------------------------------------------
// Cada REPLICA_POLL_MINUTES (default 10) compara el commit remoto de la rama
// snapshot (git ls-remote: no baja nada) con el HEAD del clon local. Si
// cambió, el server sale con el código 75 y el lanzador
// (installer/iniciar-replica.bat) corre la sincronización y lo vuelve a
// levantar con la base nueva: src/db.js abre la base al cargarse y la
// comparten muchos módulos, así que reiniciar es más simple y más seguro que
// reabrirla en caliente. Un error al consultar (sin red) se loguea y se
// reintenta en la vuelta siguiente: nunca termina el proceso por eso.
// ==========================================================================

const RESTART_EXIT_CODE = 75;
const DEFAULT_POLL_MINUTES = 10;
const MINUTE_MS = 60 * 1000;

/** REPLICA_POLL_MINUTES en ms: entero, piso 1 minuto, default 10. */
function pollIntervalMs(env = process.env) {
  const minutes = Number.parseInt(String(env.REPLICA_POLL_MINUTES ?? ''), 10);
  if (!Number.isFinite(minutes)) return DEFAULT_POLL_MINUTES * MINUTE_MS;
  return Math.max(1, minutes) * MINUTE_MS;
}

/**
 * @param {{ dataDir: string, git: { run: Function }, intervalMs?: number, exit?: Function,
 *   log?: Function, error?: Function, setIntervalFn?: Function, clearIntervalFn?: Function }} options
 */
function createReplicaPoller({
  dataDir,
  git,
  intervalMs = DEFAULT_POLL_MINUTES * MINUTE_MS,
  exit = (code) => process.exit(code),
  log = console.log,
  error = console.error,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let timer = null;
  let checking = false;

  async function localHead() {
    try {
      return (await git.run(['rev-parse', 'HEAD'], { cwd: dataDir })).trim() || null;
    } catch (err) {
      return null;
    }
  }

  /** @returns {Promise<'same'|'new'|'error'>} */
  async function checkOnce() {
    let remote;
    try {
      const out = await git.run(['ls-remote', 'origin', 'refs/heads/snapshot'], { cwd: dataDir });
      remote = out.trim().split(/\s+/)[0] || null;
    } catch (err) {
      error(`[réplica] no se pudo consultar si hay datos nuevos: ${err.message}`);
      return 'error';
    }
    if (!remote) return 'same';
    if (remote === (await localHead())) return 'same';
    log('[réplica] hay datos nuevos: se reinicia la app para cargarlos.');
    exit(RESTART_EXIT_CODE);
    return 'new';
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(async () => {
      if (checking) return;
      checking = true;
      try {
        await checkOnce();
      } finally {
        checking = false;
      }
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { checkOnce, start, stop };
}

module.exports = { createReplicaPoller, pollIntervalMs, RESTART_EXIT_CODE };
