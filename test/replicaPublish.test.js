'use strict';

// src/replicaPublish.js: al cerrar cada ciclo la PC principal arma el
// snapshot para las réplicas (REQ-REP-02) y lo publica como un commit único
// con force-push (REQ-REP-03). Base, media, config y carpeta de publicación
// son temporales; git es simulado: nada toca GitHub ni data/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot, publishSnapshot, publishFromEnv } = require('../src/replicaPublish');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-'));
  const dbPath = path.join(root, 'monitoring.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE detected_posts (id TEXT PRIMARY KEY, caption TEXT)');
  db.exec('CREATE TABLE magic_links (token_hash TEXT, email TEXT)');
  db.prepare('INSERT INTO detected_posts VALUES (?, ?)').run('1', 'Jorge Macri inauguró');
  db.prepare('INSERT INTO detected_posts VALUES (?, ?)').run('2', 'Bache en Flores');
  db.prepare('INSERT INTO magic_links VALUES (?, ?)').run('hash', 'alguien@org.gob.ar');

  const mediaDir = path.join(root, 'media');
  fs.mkdirSync(path.join(mediaDir, 'instagram'), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'instagram', '1_thumb.jpg'), 'foto-1-thumb');
  fs.writeFileSync(path.join(mediaDir, 'instagram', '1_full.jpg'), 'foto-1-full');

  const configPath = path.join(root, 'monitoring.json');
  fs.writeFileSync(configPath, JSON.stringify({ instagram: { searches: ['jorge macri'] } }));

  const publishDir = path.join(root, 'publicar');
  fs.mkdirSync(publishDir);
  return { root, db, dbPath, mediaDir, configPath, publishDir };
}

function snapshotOptions(f, extra = {}) {
  return {
    publishDir: f.publishDir,
    dbPath: f.dbPath,
    mediaDir: f.mediaDir,
    configPath: f.configPath,
    runId: 42,
    appVersion: 'abc1234',
    now: new Date('2026-10-20T14:40:00.000Z'),
    ...extra,
  };
}

function readCopy(publishDir, sql) {
  const copy = new DatabaseSync(path.join(publishDir, 'monitoring.db'), { readOnly: true });
  try {
    return copy.prepare(sql).all();
  } finally {
    copy.close();
  }
}

function fakeGit({ hasHead = true, failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, cwd: options && options.cwd });
      if (failOn && args.includes(failOn)) throw new Error(`git ${failOn} falló: rejected`);
      if (args[0] === 'rev-parse' && !hasHead) throw new Error('git rev-parse falló: no HEAD');
      return '';
    },
  };
}

test('la copia de la base tiene los posteos y no tiene magic_links', () => {
  const f = fixture();
  buildSnapshot(snapshotOptions(f));
  assert.deepEqual(
    readCopy(f.publishDir, 'SELECT id FROM detected_posts ORDER BY id').map((r) => r.id),
    ['1', '2']
  );
  assert.equal(readCopy(f.publishDir, 'SELECT COUNT(*) AS n FROM magic_links')[0].n, 0);
  // La base original no se toca.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM magic_links').get().n, 1);
});

test('la copia incluye lo escrito en el WAL que todavía no pasó al archivo', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO detected_posts VALUES (?, ?)').run('3', 'recién guardado');
  buildSnapshot(snapshotOptions(f));
  assert.equal(readCopy(f.publishDir, 'SELECT COUNT(*) AS n FROM detected_posts')[0].n, 3);
});

test('snapshot.json con fecha, ciclo y versión; la config va a config/', () => {
  const f = fixture();
  buildSnapshot(snapshotOptions(f));
  const info = JSON.parse(fs.readFileSync(path.join(f.publishDir, 'snapshot.json'), 'utf8'));
  assert.deepEqual(info, { publishedAt: '2026-10-20T14:40:00.000Z', runId: 42, appVersion: 'abc1234' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.publishDir, 'config', 'monitoring.json'), 'utf8')), {
    instagram: { searches: ['jorge macri'] },
  });
});

test('media queda en espejo: copia las nuevas y borra las que ya no están', () => {
  const f = fixture();
  const vieja = path.join(f.publishDir, 'media', 'instagram', '9_thumb.jpg');
  fs.mkdirSync(path.dirname(vieja), { recursive: true });
  fs.writeFileSync(vieja, 'foto-borrada');

  buildSnapshot(snapshotOptions(f));

  const dest = path.join(f.publishDir, 'media', 'instagram');
  assert.deepEqual(fs.readdirSync(dest).sort(), ['1_full.jpg', '1_thumb.jpg']);
  assert.equal(fs.readFileSync(path.join(dest, '1_thumb.jpg'), 'utf8'), 'foto-1-thumb');
});

test('sin carpeta de media publica igual, con media vacía', () => {
  const f = fixture();
  buildSnapshot(snapshotOptions(f, { mediaDir: path.join(f.root, 'no-existe') }));
  assert.ok(fs.existsSync(path.join(f.publishDir, 'monitoring.db')));
});

test('no pisa .git de la carpeta de publicación', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.publishDir, '.git'));
  fs.writeFileSync(path.join(f.publishDir, '.git', 'HEAD'), 'ref: refs/heads/snapshot');
  buildSnapshot(snapshotOptions(f));
  assert.equal(fs.readFileSync(path.join(f.publishDir, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/snapshot');
});

test('con commit previo: add, commit --amend y push --force a snapshot', async () => {
  const f = fixture();
  const git = fakeGit({ hasHead: true });
  const result = await publishSnapshot({ ...snapshotOptions(f), git, log: () => {}, error: () => {} });

  assert.equal(result.ok, true);
  const args = git.calls.map((c) => c.args);
  assert.deepEqual(args[0], ['add', '-A']);
  assert.deepEqual(args[1], ['rev-parse', '--verify', '--quiet', 'HEAD']);
  assert.ok(args[2].includes('commit') && args[2].includes('--amend'), JSON.stringify(args[2]));
  assert.deepEqual(args[3], ['push', '--force', 'origin', 'HEAD:refs/heads/snapshot']);
  assert.ok(git.calls.every((c) => c.cwd === f.publishDir));
});

test('sin commit previo: el primero, sin --amend', async () => {
  const f = fixture();
  const git = fakeGit({ hasHead: false });
  await publishSnapshot({ ...snapshotOptions(f), git, log: () => {}, error: () => {} });
  const commit = git.calls.find((c) => c.args.includes('commit')).args;
  assert.ok(!commit.includes('--amend'));
  assert.ok(commit.includes('user.name=Social Listening'));
});

test('un push rechazado no tira: devuelve ok false y loguea [réplica]', async () => {
  const f = fixture();
  const errores = [];
  const result = await publishSnapshot({
    ...snapshotOptions(f),
    git: fakeGit({ failOn: 'push' }),
    log: () => {},
    error: (msg) => errores.push(msg),
  });
  assert.equal(result.ok, false);
  assert.match(errores.join('\n'), /\[réplica\] no se pudo publicar: .*push/);
});

test('publishFromEnv sin REPLICA_PUBLISH_DIR no hace nada', async () => {
  const f = fixture();
  const git = fakeGit();
  const result = await publishFromEnv({ env: {}, git, dbPath: f.dbPath, mediaDir: f.mediaDir, configPath: f.configPath });
  assert.deepEqual(result, { skipped: true });
  assert.equal(git.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.publishDir), []);
});

test('publishFromEnv con REPLICA_PUBLISH_DIR publica en esa carpeta', async () => {
  const f = fixture();
  const git = fakeGit();
  const result = await publishFromEnv({
    env: { REPLICA_PUBLISH_DIR: f.publishDir },
    runId: 7,
    git,
    dbPath: f.dbPath,
    mediaDir: f.mediaDir,
    configPath: f.configPath,
    appVersion: 'abc1234',
    log: () => {},
    error: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.publishDir, 'snapshot.json'), 'utf8')).runId, 7);
  assert.ok(git.calls.some((c) => c.args[0] === 'push'));
});

test('una base que no existe no tira', async () => {
  const f = fixture();
  const errores = [];
  const result = await publishSnapshot({
    ...snapshotOptions(f, { dbPath: path.join(f.root, 'no-existe.db') }),
    git: fakeGit(),
    log: () => {},
    error: (msg) => errores.push(msg),
  });
  assert.equal(result.ok, false);
  assert.equal(errores.length, 1);
});
