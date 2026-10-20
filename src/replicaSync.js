// ==========================================================================
// replicaSync.js — La réplica trae y aplica el último snapshot.
// --------------------------------------------------------------------------
// Lo corre scripts/replica-sync.js antes de cada arranque de la réplica (el
// lanzador installer/iniciar-replica.bat), con el server apagado. NO carga
// src/db.js (abriría la base que está por reemplazar): las rutas se arman
// acá con las mismas variables que usa la app.
//
// Traer: sin clon, git clone --depth 1 de la rama snapshot; con clon, fetch
// --depth 1 y reset --hard a lo que llegó (la principal reescribe la rama
// con force-push: no hay historia que combinar). Sin red, sigue con lo que
// ya tiene el clon.
//
// Aplicar: la base nueva (monitoring.db.gz; un snapshot del formato anterior
// trae monitoring.db sin comprimir) se descomprime al lado como
// monitoring.db.nuevo, tiene que
// pasar PRAGMA integrity_check, y recién ahí se borran el -wal y el -shm
// viejos y se renombra sobre monitoring.db. Una base dañada no reemplaza la
// que había. Las fotos quedan en espejo, la config se copia y snapshot.json
// queda como data/replica-snapshot.json (de ahí lee /api/app/mode).
// ==========================================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { mirrorDir, copyFileAtomic } = require('./replicaFiles');

const SNAPSHOT_BRANCH = 'snapshot';
const ROOT_DIR = path.join(__dirname, '..');

async function fetchSnapshot({ dataDir, repoUrl, git, log = console.log, error = console.error }) {
  const hasClone = fs.existsSync(path.join(dataDir, '.git'));
  if (!hasClone && !repoUrl) {
    error('[réplica] falta REPLICA_REPO_URL: no hay de dónde traer los datos.');
    return { ok: false, error: 'sin REPLICA_REPO_URL' };
  }
  try {
    if (hasClone) {
      await git.run(['fetch', '--depth', '1', 'origin', SNAPSHOT_BRANCH], { cwd: dataDir });
      await git.run(['reset', '--hard', 'FETCH_HEAD'], { cwd: dataDir });
    } else {
      fs.mkdirSync(path.dirname(dataDir), { recursive: true });
      await git.run(['clone', '--depth', '1', '--branch', SNAPSHOT_BRANCH, repoUrl, dataDir], {
        cwd: path.dirname(dataDir),
      });
    }
    log('[réplica] snapshot traído del repo de datos.');
    return { ok: true };
  } catch (err) {
    error(`[réplica] no se pudo traer el snapshot (sin conexión o sin acceso): ${err.message}. Se usa lo último que hay.`);
    return { ok: false, error: err.message };
  }
}

function checkIntegrity(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('PRAGMA integrity_check').all();
      return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    } finally {
      db.close();
    }
  } catch (err) {
    return false;
  }
}

/** Deja la base del snapshot en `incoming`. false si el .gz no descomprime. */
function extractDatabase(snapshotDir, incoming) {
  const compressed = path.join(snapshotDir, 'monitoring.db.gz');
  if (!fs.existsSync(compressed)) {
    fs.copyFileSync(path.join(snapshotDir, 'monitoring.db'), incoming);
    return true;
  }
  try {
    fs.writeFileSync(incoming, zlib.gunzipSync(fs.readFileSync(compressed)));
    return true;
  } catch (err) {
    return false;
  }
}

function applySnapshot({ snapshotDir, dbPath, mediaDir, configPath, infoPath, log = console.log, error = console.error }) {
  const hasDatabase = ['monitoring.db.gz', 'monitoring.db'].some((name) => fs.existsSync(path.join(snapshotDir, name)));
  if (!hasDatabase) {
    error('[réplica] todavía no hay datos descargados: la app arranca vacía.');
    return { applied: false, reason: 'sin-snapshot' };
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const incoming = `${dbPath}.nuevo`;
  if (!extractDatabase(snapshotDir, incoming) || !checkIntegrity(incoming)) {
    fs.rmSync(incoming, { force: true });
    error('[réplica] la base descargada está dañada: se deja la que había.');
    return { applied: false, reason: 'base-dañada' };
  }
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.renameSync(incoming, dbPath);

  const media = mirrorDir(path.join(snapshotDir, 'media'), mediaDir);
  const config = path.join(snapshotDir, 'config', 'monitoring.json');
  if (fs.existsSync(config)) copyFileAtomic(config, configPath);
  const info = path.join(snapshotDir, 'snapshot.json');
  if (fs.existsSync(info)) copyFileAtomic(info, infoPath);

  log(`[réplica] datos aplicados (${media.copied} foto(s) nueva(s), ${media.removed} borrada(s)).`);
  return { applied: true };
}

/** Traer y aplicar. Nunca tira por la red: sin conexión aplica lo que hay. */
async function syncReplica({ dataDir, repoUrl, git, ...apply }) {
  const fetched = await fetchSnapshot({ dataDir, repoUrl, git, log: apply.log, error: apply.error });
  const result = applySnapshot({ snapshotDir: dataDir, ...apply });
  return { fetched: fetched.ok, applied: result.applied };
}

/** Rutas y credenciales de la réplica, con las mismas variables que la app. */
function replicaOptionsFromEnv(env = process.env) {
  const dbPath = env.MONITORING_DB_PATH || path.join(ROOT_DIR, 'data', 'monitoring.db');
  const { createGitRunner } = require('./replicaGit');
  return {
    dataDir: env.REPLICA_DATA_DIR || path.join(ROOT_DIR, 'replica-datos'),
    repoUrl: String(env.REPLICA_REPO_URL || '').trim(),
    git: createGitRunner({
      gitPath: env.REPLICA_GIT || 'git',
      token: String(env.DATA_REPO_TOKEN || '').trim(),
      machineCredentials: false,
      env,
    }),
    dbPath,
    mediaDir: env.MONITORING_MEDIA_DIR || path.join(ROOT_DIR, 'data', 'media'),
    configPath: env.MONITORING_CONFIG_PATH || path.join(ROOT_DIR, 'config', 'monitoring.json'),
    infoPath: replicaInfoPath(dbPath),
  };
}

/** Dónde queda el snapshot.json aplicado: al lado de la base. */
function replicaInfoPath(dbPath) {
  return path.join(path.dirname(dbPath), 'replica-snapshot.json');
}

module.exports = { fetchSnapshot, applySnapshot, syncReplica, replicaOptionsFromEnv, replicaInfoPath, SNAPSHOT_BRANCH };
