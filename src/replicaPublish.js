// ==========================================================================
// replicaPublish.js — Publica el snapshot para las réplicas.
// --------------------------------------------------------------------------
// Corre en la PC principal al cerrar cada ciclo (src/scheduler.js), solo si
// REPLICA_PUBLISH_DIR apunta a un clon del repo privado de datos (ver
// openspec/changes/replicas-solo-lectura). Deja en esa carpeta:
//
//   monitoring.db            copia consistente, sin magic_links
//   snapshot.json            { publishedAt, runId, appVersion }
//   config/monitoring.json   cuentas, keywords y búsquedas
//   media/                   espejo de data/media (fotos de los posteos)
//
// y la publica como UN commit en la rama snapshot (amend si ya había uno) con
// push --force: GitHub guarda solo la foto actual y git sube solo las fotos
// nuevas. La base se copia con VACUUM INTO desde una conexión propia en solo
// lectura (está en WAL: copiar el archivo en caliente puede dar una copia
// inconsistente). magic_links es lo único con datos del login (las sesiones
// son cookies firmadas). Nunca tira: un fallo se loguea y el ciclo sigue.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { mirrorDir, writeFileAtomic, copyFileAtomic } = require('./replicaFiles');

const SNAPSHOT_BRANCH = 'snapshot';
const COMMIT_IDENTITY = ['-c', 'user.name=Social Listening', '-c', 'user.email=snapshot@social-listening.local'];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function copyDatabase(dbPath, destPath) {
  const tmp = `${destPath}.tmp`;
  fs.rmSync(tmp, { force: true });
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${sqlString(tmp)}`);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(tmp);
  try {
    const hasMagicLinks = copy
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'magic_links'")
      .get();
    if (hasMagicLinks) copy.exec('DELETE FROM magic_links');
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
  fs.renameSync(tmp, destPath);
}

/**
 * Arma la carpeta de publicación. Tira si algo falla (lo atrapa
 * publishSnapshot). No toca .git ni nada fuera de lo que publica.
 */
function buildSnapshot({ publishDir, dbPath, mediaDir, configPath, runId = null, appVersion = null, now = new Date() }) {
  copyDatabase(dbPath, path.join(publishDir, 'monitoring.db'));
  if (configPath && fs.existsSync(configPath)) {
    copyFileAtomic(configPath, path.join(publishDir, 'config', 'monitoring.json'));
  }
  const media = mirrorDir(mediaDir, path.join(publishDir, 'media'));
  const info = { publishedAt: now.toISOString(), runId, appVersion };
  writeFileAtomic(path.join(publishDir, 'snapshot.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { info, media };
}

async function commitAndPush({ publishDir, git, info }) {
  const cwd = publishDir;
  await git.run(['add', '-A'], { cwd });
  let hasHead = true;
  try {
    await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  } catch (err) {
    hasHead = false;
  }
  const message = `Snapshot ${info.publishedAt}${info.runId != null ? ` (ciclo #${info.runId})` : ''}`;
  await git.run([...COMMIT_IDENTITY, 'commit', ...(hasHead ? ['--amend'] : []), '-m', message], { cwd });
  await git.run(['push', '--force', 'origin', `HEAD:refs/heads/${SNAPSHOT_BRANCH}`], { cwd });
}

/**
 * Arma y publica. Nunca tira.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function publishSnapshot({ git, log = console.log, error = console.error, ...options }) {
  const startedAt = Date.now();
  try {
    const { info, media } = buildSnapshot(options);
    await commitAndPush({ publishDir: options.publishDir, git, info });
    log(
      `[réplica] snapshot publicado (ciclo #${info.runId ?? '?'}, ${media.copied} foto(s) nueva(s), ` +
        `${media.removed} borrada(s), ${Math.round((Date.now() - startedAt) / 1000)}s)`
    );
    return { ok: true };
  } catch (err) {
    error(`[réplica] no se pudo publicar: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Lo que llama el ciclo: publica solo si REPLICA_PUBLISH_DIR está
 * configurado, con la base, las fotos y la config de la app. Nunca tira.
 * Los demás parámetros son para tests.
 */
async function publishFromEnv({ env = process.env, runId = null, ...overrides } = {}) {
  const publishDir = String(env.REPLICA_PUBLISH_DIR || '').trim();
  if (!publishDir) return { skipped: true };
  const options = {
    publishDir,
    runId,
    dbPath: overrides.dbPath || require('./db').DB_PATH,
    mediaDir: overrides.mediaDir || require('./postImages').MEDIA_DIR,
    configPath: overrides.configPath || require('./monitor').CONFIG_PATH,
    appVersion: overrides.appVersion !== undefined ? overrides.appVersion : require('./appVersion').getAppVersion(),
    git: overrides.git || require('./replicaGit').createGitRunner(),
  };
  if (overrides.log) options.log = overrides.log;
  if (overrides.error) options.error = overrides.error;
  return publishSnapshot(options);
}

module.exports = { buildSnapshot, publishSnapshot, publishFromEnv, SNAPSHOT_BRANCH };
