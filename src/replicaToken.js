// ==========================================================================
// replicaToken.js — El token de lectura que se pega en la réplica.
// --------------------------------------------------------------------------
// La primera vez la réplica no tiene DATA_REPO_TOKEN: el frontend muestra un
// modal y POST /api/replica/token (src/replicaRoutes.js) lo prueba contra el
// repo de datos con un git ls-remote (no baja nada) y, si sirve, lo guarda
// en el .env de la app. El token nunca vuelve al navegador ni va a un log.
// ==========================================================================

const fs = require('fs');
const { writeFileAtomic } = require('./replicaFiles');
const { createGitRunner } = require('./replicaGit');

const NETWORK_ERROR = /could not resolve host|unable to connect|failed to connect|timed out|connection (refused|reset)|network is unreachable|ETIMEDOUT|ENOTFOUND|ECONNRESET/i;

/** Reemplaza (o agrega) NAME=value en un .env, sin tocar las demás líneas. */
function writeEnvValue(envPath, name, value) {
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current === '' ? [] : current.replace(/\r?\n$/, '').split(/\r?\n/);
  const line = `${name}=${value}`;
  const index = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  writeFileAtomic(envPath, lines.join(eol) + eol);
}

/**
 * @param {{ repoUrl: string, token: string, gitPath?: string, createGitRunnerFn?: Function }} options
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'sin-repo'|'acceso'|'red' }>}
 */
async function verifyToken({ repoUrl, token, gitPath = 'git', createGitRunnerFn = createGitRunner }) {
  if (!repoUrl) return { ok: false, reason: 'sin-repo' };
  const git = createGitRunnerFn({ gitPath, token });
  try {
    await git.run(['ls-remote', repoUrl, 'refs/heads/snapshot']);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: NETWORK_ERROR.test(err.message) ? 'red' : 'acceso' };
  }
}

module.exports = { writeEnvValue, verifyToken };
