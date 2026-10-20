'use strict';

// src/replicaSync.js (REQ-REP-06): antes de arrancar, la réplica trae el
// último snapshot (clon superficial la primera vez, fetch + reset después) y
// lo aplica: la base nueva pasa integrity_check antes de reemplazar la
// actual, el reemplazo es por renombre y borra el -wal y el -shm viejos;
// media queda en espejo y la config copiada. Sin red, aplica lo que ya
// tiene. Todo en carpetas temporales, con git simulado.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchSnapshot, applySnapshot, syncReplica, replicaOptionsFromEnv } = require('../src/replicaSync');

const silent = { log: () => {}, error: () => {} };

function makeDb(file, ids) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE detected_posts (id TEXT PRIMARY KEY)');
  for (const id of ids) db.prepare('INSERT INTO detected_posts VALUES (?)').run(id);
  db.close();
}

function idsIn(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT id FROM detected_posts ORDER BY id').all().map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Un snapshot como el que publica la principal. */
function writeSnapshot(dir, { ids = ['1', '2'], fotos = { 'instagram/1_thumb.jpg': 'f1' }, publishedAt = '2026-10-20T14:40:00.000Z' } = {}) {
  makeDb(path.join(dir, 'monitoring.db'), ids);
  for (const [rel, content] of Object.entries(fotos)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'media', rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media', rel), content);
  }
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'monitoring.json'), '{"instagram":{"searches":["macri"]}}');
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ publishedAt, runId: 9, appVersion: 'abc1234' }));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sync-'));
  return {
    root,
    dataDir: path.join(root, 'replica-datos'),
    dbPath: path.join(root, 'data', 'monitoring.db'),
    mediaDir: path.join(root, 'data', 'media'),
    configPath: path.join(root, 'config', 'monitoring.json'),
    infoPath: path.join(root, 'data', 'replica-snapshot.json'),
  };
}

function applyOptions(f) {
  return { snapshotDir: f.dataDir, dbPath: f.dbPath, mediaDir: f.mediaDir, configPath: f.configPath, infoPath: f.infoPath, ...silent };
}

function fakeGit({ onClone = () => {}, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, cwd: options && options.cwd });
      if (fail && args.includes(fail)) throw new Error(`git ${fail} falló: Could not resolve host: github.com`);
      if (args[0] === 'clone') onClone(args[args.length - 1]);
      return '';
    },
  };
}

// --------------------------------------------------------------------------
// fetchSnapshot
// --------------------------------------------------------------------------

test('sin clon: clon superficial de la rama snapshot', async () => {
  const f = fixture();
  const git = fakeGit({ onClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }) });
  const result = await fetchSnapshot({ dataDir: f.dataDir, repoUrl: 'https://github.com/org/datos.git', git, ...silent });
  assert.equal(result.ok, true);
  assert.deepEqual(git.calls[0].args, ['clone', '--depth', '1', '--branch', 'snapshot', 'https://github.com/org/datos.git', f.dataDir]);
});

test('con clon: fetch superficial y reset a lo que llegó', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.dataDir, '.git'), { recursive: true });
  const git = fakeGit();
  await fetchSnapshot({ dataDir: f.dataDir, repoUrl: 'https://github.com/org/datos.git', git, ...silent });
  assert.deepEqual(
    git.calls.map((c) => c.args),
    [
      ['fetch', '--depth', '1', 'origin', 'snapshot'],
      ['reset', '--hard', 'FETCH_HEAD'],
    ]
  );
  assert.ok(git.calls.every((c) => c.cwd === f.dataDir));
});

test('sin red: no tira, devuelve ok false y lo dice', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.dataDir, '.git'), { recursive: true });
  const errores = [];
  const result = await fetchSnapshot({
    dataDir: f.dataDir,
    repoUrl: 'https://github.com/org/datos.git',
    git: fakeGit({ fail: 'fetch' }),
    log: () => {},
    error: (m) => errores.push(m),
  });
  assert.equal(result.ok, false);
  assert.match(errores.join('\n'), /\[réplica\].*sin conexión|\[réplica\].*no se pudo traer/);
});

test('sin clon y sin REPLICA_REPO_URL: no llama a git', async () => {
  const f = fixture();
  const git = fakeGit();
  const result = await fetchSnapshot({ dataDir: f.dataDir, repoUrl: '', git, ...silent });
  assert.equal(result.ok, false);
  assert.equal(git.calls.length, 0);
});

// --------------------------------------------------------------------------
// applySnapshot
// --------------------------------------------------------------------------

test('aplica base, media, config y snapshot.json', () => {
  const f = fixture();
  writeSnapshot(f.dataDir);
  const result = applySnapshot(applyOptions(f));
  assert.equal(result.applied, true);
  assert.deepEqual(idsIn(f.dbPath), ['1', '2']);
  assert.equal(fs.readFileSync(path.join(f.mediaDir, 'instagram', '1_thumb.jpg'), 'utf8'), 'f1');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{"instagram":{"searches":["macri"]}}');
  assert.equal(JSON.parse(fs.readFileSync(f.infoPath, 'utf8')).publishedAt, '2026-10-20T14:40:00.000Z');
});

test('reemplaza la base anterior y borra su -wal y -shm', () => {
  const f = fixture();
  makeDb(f.dbPath, ['viejo']);
  fs.writeFileSync(`${f.dbPath}-wal`, 'wal viejo');
  fs.writeFileSync(`${f.dbPath}-shm`, 'shm viejo');
  writeSnapshot(f.dataDir, { ids: ['nuevo'] });

  applySnapshot(applyOptions(f));

  assert.deepEqual(idsIn(f.dbPath), ['nuevo']);
  assert.ok(!fs.existsSync(`${f.dbPath}-wal`));
  assert.ok(!fs.existsSync(`${f.dbPath}-shm`));
  assert.ok(!fs.existsSync(`${f.dbPath}.nuevo`));
});

test('una base dañada no reemplaza la actual', () => {
  const f = fixture();
  makeDb(f.dbPath, ['bueno']);
  writeSnapshot(f.dataDir);
  fs.writeFileSync(path.join(f.dataDir, 'monitoring.db'), 'esto no es una base sqlite');
  const errores = [];

  const result = applySnapshot({ ...applyOptions(f), error: (m) => errores.push(m) });

  assert.equal(result.applied, false);
  assert.deepEqual(idsIn(f.dbPath), ['bueno']);
  assert.ok(!fs.existsSync(`${f.dbPath}.nuevo`));
  assert.match(errores.join('\n'), /\[réplica\]/);
});

test('media en espejo: borra las fotos que ya no están en el snapshot', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.mediaDir, 'instagram'), { recursive: true });
  fs.writeFileSync(path.join(f.mediaDir, 'instagram', '7_thumb.jpg'), 'vieja');
  writeSnapshot(f.dataDir);
  applySnapshot(applyOptions(f));
  assert.deepEqual(fs.readdirSync(path.join(f.mediaDir, 'instagram')), ['1_thumb.jpg']);
});

test('sin snapshot todavía: no toca nada', () => {
  const f = fixture();
  makeDb(f.dbPath, ['local']);
  const result = applySnapshot(applyOptions(f));
  assert.equal(result.applied, false);
  assert.deepEqual(idsIn(f.dbPath), ['local']);
});

test('replicaOptionsFromEnv: rutas de la app y el snapshot.json al lado de la base', () => {
  const f = fixture();
  const options = replicaOptionsFromEnv({
    REPLICA_DATA_DIR: f.dataDir,
    REPLICA_REPO_URL: ' https://github.com/org/datos.git ',
    MONITORING_DB_PATH: f.dbPath,
    MONITORING_MEDIA_DIR: f.mediaDir,
    MONITORING_CONFIG_PATH: f.configPath,
  });
  assert.equal(options.dataDir, f.dataDir);
  assert.equal(options.repoUrl, 'https://github.com/org/datos.git');
  assert.equal(options.dbPath, f.dbPath);
  assert.equal(options.mediaDir, f.mediaDir);
  assert.equal(options.configPath, f.configPath);
  assert.equal(options.infoPath, path.join(path.dirname(f.dbPath), 'replica-snapshot.json'));
  assert.equal(typeof options.git.run, 'function');
});

// --------------------------------------------------------------------------
// syncReplica: traer + aplicar
// --------------------------------------------------------------------------

test('sin red aplica lo que ya tenía el clon y arranca igual', async () => {
  const f = fixture();
  writeSnapshot(f.dataDir, { ids: ['de-ayer'] });
  fs.mkdirSync(path.join(f.dataDir, '.git'), { recursive: true });
  const result = await syncReplica({
    ...applyOptions(f),
    dataDir: f.dataDir,
    repoUrl: 'https://github.com/org/datos.git',
    git: fakeGit({ fail: 'fetch' }),
  });
  assert.equal(result.fetched, false);
  assert.equal(result.applied, true);
  assert.deepEqual(idsIn(f.dbPath), ['de-ayer']);
});
