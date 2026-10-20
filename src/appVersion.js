// ==========================================================================
// appVersion.js — Qué versión del código está corriendo.
// --------------------------------------------------------------------------
// La publica la PC principal en snapshot.json y la compara la réplica con la
// suya para avisar "hay una versión nueva de la app". En una réplica
// instalada no hay git: la versión sale de build-info.json, que escribe el
// armado del instalador (installer/armar-instalador.ps1) con el commit. En
// la PC principal, el commit actual del repo. null si no hay ninguna de las
// dos: sin versión no se avisa nada.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');

function fromBuildInfo(rootDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(rootDir, 'build-info.json'), 'utf8'));
    const commit = String((info && info.commit) || '').trim();
    return commit || null;
  } catch (err) {
    return null;
  }
}

function fromGit(rootDir, execFileSyncFn) {
  try {
    const out = execFileSyncFn('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const commit = String(out || '').trim();
    return commit || null;
  } catch (err) {
    return null;
  }
}

/**
 * @param {{ rootDir?: string, execFileSyncFn?: Function }} [options] para tests
 * @returns {string|null}
 */
function getAppVersion({ rootDir = ROOT_DIR, execFileSyncFn = execFileSync } = {}) {
  return fromBuildInfo(rootDir) || fromGit(rootDir, execFileSyncFn);
}

module.exports = { getAppVersion };
