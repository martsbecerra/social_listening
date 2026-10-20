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
// Sin clon todavía (la réplica arrancó sin datos) se consulta la URL del
// repo: si ya hay snapshot, es nuevo. checkForUpdate hace la misma consulta
// sin salir (el botón "Buscar datos nuevos" responde antes de reiniciar).
// Si el repo rechaza el token (venció o lo revocaron; un error que no es de
// red), devuelve 'denied' y tokenRejected() queda en true hasta que una
// consulta vuelva a andar: /api/app/mode lo avisa y el frontend abre el
// modal para pegar uno nuevo.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { classifyGitError } = require('./replicaToken');

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
 * @param {{ dataDir: string, repoUrl?: string, git: { run: Function }, intervalMs?: number, exit?: Function,
 *   log?: Function, error?: Function, setIntervalFn?: Function, clearIntervalFn?: Function }} options
 */
function createReplicaPoller({
  dataDir,
  repoUrl = '',
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
  let denied = false;

  async function localHead() {
    try {
      return (await git.run(['rev-parse', 'HEAD'], { cwd: dataDir })).trim() || null;
    } catch (err) {
      return null;
    }
  }

  /** @returns {Promise<'same'|'new'|'error'|'denied'>} 'denied': el repo no acepta el token. */
  async function checkForUpdate() {
    const hasClone = fs.existsSync(path.join(dataDir, '.git'));
    if (!hasClone && !repoUrl) {
      error('[réplica] falta REPLICA_REPO_URL: no hay dónde consultar si hay datos nuevos.');
      return 'error';
    }
    let remote;
    try {
      const out = hasClone
        ? await git.run(['ls-remote', 'origin', 'refs/heads/snapshot'], { cwd: dataDir })
        : await git.run(['ls-remote', repoUrl, 'refs/heads/snapshot']);
      remote = out.trim().split(/\s+/)[0] || null;
    } catch (err) {
      if (classifyGitError(err.message) === 'acceso') {
        denied = true;
        error(`[réplica] el repo de datos no acepta el token de lectura (venció o lo revocaron): ${err.message}`);
        return 'denied';
      }
      error(`[réplica] no se pudo consultar si hay datos nuevos: ${err.message}`);
      return 'error';
    }
    denied = false;
    if (!remote) return 'same';
    if (hasClone && remote === (await localHead())) return 'same';
    return 'new';
  }

  /** @returns {Promise<'same'|'new'|'error'|'denied'>} */
  async function checkOnce() {
    const result = await checkForUpdate();
    if (result === 'new') {
      log('[réplica] hay datos nuevos: se reinicia la app para cargarlos.');
      exit(RESTART_EXIT_CODE);
    }
    return result;
  }

  /**
   * checkNow: una consulta apenas arranca, para saber enseguida si el token
   * dejó de servir. No sale aunque haya datos nuevos: la sincronización
   * recién corrió, y salir podría dejar la app reiniciándose en bucle.
   */
  async function start({ checkNow = false } = {}) {
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
    if (checkNow) await checkForUpdate();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  /** La última consulta falló porque el repo no acepta el token (hasta que una vuelva a andar). */
  function tokenRejected() {
    return denied;
  }

  return { checkForUpdate, checkOnce, start, stop, tokenRejected };
}

module.exports = { createReplicaPoller, pollIntervalMs, RESTART_EXIT_CODE };
