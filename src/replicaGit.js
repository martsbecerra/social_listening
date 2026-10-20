// ==========================================================================
// replicaGit.js — Corre git para el snapshot de las réplicas.
// --------------------------------------------------------------------------
// Lo usan la publicación (PC principal, sin token: usa el git ya
// autenticado de la máquina) y la sincronización y el sondeo de las
// réplicas (con DATA_REPO_TOKEN, de solo lectura).
//
// El token va SOLO por variables de entorno del proceso hijo
// (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0 =
// http.extraHeader), nunca en los argumentos (se ven en el administrador de
// tareas) ni en la URL del remoto (queda en .git/config y en los mensajes de
// git). Un error de git pasa por redact antes de salir de acá: si el
// header apareciera en el mensaje, el token y su base64 quedan como ***.
// GIT_TERMINAL_PROMPT=0: si la autenticación falla, git corta en vez de
// quedarse esperando una contraseña que nadie va a escribir.
// ==========================================================================

const { execFile } = require('node:child_process');

const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;

function basicFor(token) {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

function redact(text, token) {
  let out = String(text || '');
  if (!token) return out;
  for (const secret of [token, basicFor(token)]) {
    out = out.split(secret).join('***');
  }
  return out;
}

/**
 * @param {{ gitPath?: string, token?: string, machineCredentials?: boolean, execFileFn?: Function, env?: object }} [options]
 *   machineCredentials: false en la réplica. Vacía credential.helper y pone
 *   GCM_INTERACTIVE=never: con un token rechazado, Git para Windows abre la
 *   ventana de login de Git Credential Manager (GIT_TERMINAL_PROMPT no la
 *   frena) y git queda colgado esperándola.
 *   execFileFn: para tests (misma firma que child_process.execFile).
 */
function createGitRunner({ gitPath = 'git', token = '', machineCredentials = true, execFileFn = execFile, env = process.env } = {}) {
  const childEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const config = [];
  if (token) config.push(['http.extraHeader', `Authorization: Basic ${basicFor(token)}`]);
  if (!machineCredentials) {
    config.push(['credential.helper', '']);
    childEnv.GCM_INTERACTIVE = 'never';
  }
  if (config.length > 0) {
    childEnv.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], i) => {
      childEnv[`GIT_CONFIG_KEY_${i}`] = key;
      childEnv[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }

  /**
   * @param {string[]} args
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<string>} stdout
   */
  function run(args, { cwd } = {}) {
    return new Promise((resolve, reject) => {
      execFileFn(
        gitPath,
        args,
        { cwd, env: childEnv, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || '').trim();
            const message = `git ${args[0] || ''} falló: ${err.message}${detail ? ` | ${detail}` : ''}`;
            reject(new Error(redact(message, token)));
            return;
          }
          resolve(String(stdout || ''));
        }
      );
    });
  }

  return { run };
}

module.exports = { createGitRunner, redact };
