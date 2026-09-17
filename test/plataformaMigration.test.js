'use strict';

// Migración del esquema `platform` -> `plataforma` en detected_posts,
// account_stats y account_followers, conservando los datos. Una base puede
// venir de la rama refactor (columna `platform`), de main (`plataforma` +
// retweets/views) o de ambas (las dos columnas a la vez). db.js abre la base
// al hacer require y es un singleton por proceso, así que cada caso arranca
// src/db.js en un proceso hijo contra una base temporal armada a mano con el
// esquema viejo. Nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const DB_JS = path.join(__dirname, '..', 'src', 'db.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-migracion-'));
const NOW = new Date().toISOString();

// Esquema de detected_posts previo a la columna de plataforma: el CREATE
// base de db.js más las columnas que fue sumando por ALTER.
function createOldSchema(dbPath, { detectedExtraCols = [], accountTables = true } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE detected_posts (
      id TEXT PRIMARY KEY,
      account TEXT,
      url TEXT NOT NULL,
      caption TEXT,
      matched_reason TEXT,
      likes INTEGER,
      comments INTEGER,
      posted_at TEXT,
      detected_at TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      sentiment TEXT,
      post_type TEXT,
      followers INTEGER,
      metrics_updated_at TEXT,
      ignored INTEGER NOT NULL DEFAULT 0,
      ignored_at TEXT${detectedExtraCols.map((c) => `,\n      ${c}`).join('')}
    )
  `);
  if (accountTables) {
    // Así nacieron en la base común de refactor y main: con `platform`.
    db.exec(`
      CREATE TABLE account_stats (
        account TEXT NOT NULL,
        platform TEXT NOT NULL,
        post_type TEXT CHECK(post_type IN ('reel','imagen','carrusel') OR post_type IS NULL),
        n_posts INTEGER NOT NULL,
        median_likes REAL,
        median_comments REAL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (account, platform, post_type)
      )
    `);
    db.exec(`
      CREATE TABLE account_followers (
        account TEXT NOT NULL,
        platform TEXT NOT NULL,
        followers INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account, platform)
      )
    `);
    db.prepare(
      "INSERT INTO account_stats (account, platform, post_type, n_posts, median_likes, median_comments, computed_at) VALUES ('cuenta', 'instagram', NULL, 7, 10, 2, ?)"
    ).run(NOW);
    db.prepare("INSERT INTO account_followers (account, platform, followers, updated_at) VALUES ('cuenta', 'instagram', 1234, ?)").run(NOW);
  }
  return db;
}

function insertDetected(db, id, extra) {
  const cols = ['id', 'account', 'url', 'detected_at', ...Object.keys(extra)];
  const values = [id, 'cuenta', `https://ex.com/${id}`, NOW, ...Object.values(extra)];
  db.prepare(`INSERT INTO detected_posts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
}

// Arranca src/db.js en un proceso hijo contra dbPath, ejercita la API con
// `plataforma` y devuelve el estado resultante del esquema y de las filas.
function bootDb(dbPath) {
  const script = `
    const db = require(${JSON.stringify(DB_JS)});
    const { DatabaseSync } = require('node:sqlite');
    // Ejercita la PK compuesta ya renombrada: un upsert sobre la fila
    // existente tiene que ACTUALIZAR, no duplicar.
    if (db.getAccountStats('cuenta', 'instagram', null)) {
      db.upsertAccountStats({ account: 'cuenta', plataforma: 'instagram', postType: null, nPosts: 9, medianLikes: 10, medianComments: 2 });
      db.upsertAccountFollowers({ account: 'cuenta', plataforma: 'instagram', followers: 4321 });
    }
    const raw = new DatabaseSync(process.env.MONITORING_DB_PATH, { readOnly: true });
    const cols = (t) => raw.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    const out = {
      detected: cols('detected_posts'),
      stats: cols('account_stats'),
      followers: cols('account_followers'),
      rows: raw.prepare('SELECT id, plataforma FROM detected_posts ORDER BY id').all(),
      statsRows: raw.prepare('SELECT account, plataforma, post_type, n_posts FROM account_stats').all(),
      followersRows: raw.prepare('SELECT account, plataforma, followers FROM account_followers').all(),
      apiStats: db.getAccountStats('cuenta', 'instagram', null),
      apiFollowers: db.getAccountFollowers('cuenta', 'instagram'),
      countX: db.countRecentPosts(36500, 'x'),
    };
    console.log('__OUT__' + JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, MONITORING_DB_PATH: dbPath },
    encoding: 'utf8',
  });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('__OUT__'));
  assert.ok(line, 'el proceso hijo no devolvió el estado de la base');
  return JSON.parse(line.slice('__OUT__'.length));
}

function assertUnifiedSchema(out) {
  assert.ok(out.detected.includes('plataforma'), 'detected_posts.plataforma existe');
  assert.ok(!out.detected.includes('platform'), 'detected_posts.platform ya no existe');
  assert.ok(out.detected.includes('retweets') && out.detected.includes('views'), 'columnas de X presentes');
  assert.ok(out.stats.includes('plataforma') && !out.stats.includes('platform'), 'account_stats renombrada');
  assert.ok(out.followers.includes('plataforma') && !out.followers.includes('platform'), 'account_followers renombrada');
}

function assertAccountTablesKeptData(out) {
  // Una sola fila (el upsert actualizó, no duplicó) y con los datos nuevos.
  assert.deepEqual(out.statsRows, [{ account: 'cuenta', plataforma: 'instagram', post_type: null, n_posts: 9 }]);
  assert.deepEqual(out.followersRows, [{ account: 'cuenta', plataforma: 'instagram', followers: 4321 }]);
  assert.equal(out.apiStats.nPosts, 9);
  assert.equal(out.apiStats.plataforma, 'instagram');
  assert.equal(out.apiFollowers, 4321);
}

describe('migración platform -> plataforma', { concurrency: false }, () => {
  test('(a) base que corrió solo refactor: RENAME COLUMN conserva las filas', () => {
    const dbPath = path.join(tmpDir, 'solo-refactor.db');
    const db = createOldSchema(dbPath, { detectedExtraCols: ["platform TEXT NOT NULL DEFAULT 'instagram'"] });
    insertDetected(db, 'r1', { platform: 'instagram' });
    insertDetected(db, 'r2', { platform: 'tiktok' });
    db.close();

    const out = bootDb(dbPath);
    assertUnifiedSchema(out);
    assert.deepEqual(out.rows, [
      { id: 'r1', plataforma: 'instagram' },
      { id: 'r2', plataforma: 'tiktok' },
    ]);
    assertAccountTablesKeptData(out);
  });

  test('(b) base que corrió solo main: no toca detected_posts, renombra las tablas de benchmark', () => {
    const dbPath = path.join(tmpDir, 'solo-main.db');
    const db = createOldSchema(dbPath, {
      detectedExtraCols: ["plataforma TEXT NOT NULL DEFAULT 'instagram'", 'retweets INTEGER', 'views INTEGER'],
    });
    insertDetected(db, 'm1', { plataforma: 'instagram' });
    insertDetected(db, 'm2', { plataforma: 'x', retweets: 5, views: 100 });
    db.close();

    const out = bootDb(dbPath);
    assertUnifiedSchema(out);
    assert.deepEqual(out.rows, [
      { id: 'm1', plataforma: 'instagram' },
      { id: 'm2', plataforma: 'x' },
    ]);
    assert.equal(out.countX, 1);
    assertAccountTablesKeptData(out);
  });

  test('(c) base que corrió las dos ramas: unifica las dos columnas sin perder X ni las otras', () => {
    const dbPath = path.join(tmpDir, 'ambas.db');
    const db = createOldSchema(dbPath, {
      detectedExtraCols: [
        "platform TEXT NOT NULL DEFAULT 'instagram'",
        "plataforma TEXT NOT NULL DEFAULT 'instagram'",
        'retweets INTEGER',
        'views INTEGER',
      ],
    });
    // Fila anterior a ambas ramas: las dos columnas en su default.
    insertDetected(db, 'c1', { platform: 'instagram', plataforma: 'instagram' });
    // Fila escrita por main (X): `plataforma` real, `platform` en default.
    insertDetected(db, 'c2', { platform: 'instagram', plataforma: 'x', retweets: 3, views: 50 });
    // Fila escrita por refactor con otra plataforma: `platform` real,
    // `plataforma` en default.
    insertDetected(db, 'c3', { platform: 'tiktok', plataforma: 'instagram' });
    db.close();

    const out = bootDb(dbPath);
    assertUnifiedSchema(out);
    assert.deepEqual(out.rows, [
      { id: 'c1', plataforma: 'instagram' },
      { id: 'c2', plataforma: 'x' },
      { id: 'c3', plataforma: 'tiktok' },
    ]);
    assert.equal(out.countX, 1);
    assertAccountTablesKeptData(out);

    // Idempotente: un segundo arranque contra la base ya migrada no falla
    // ni cambia nada.
    const again = bootDb(dbPath);
    assertUnifiedSchema(again);
    assert.deepEqual(again.rows, out.rows);
  });

  test('(d) base nueva: nace directamente con plataforma', () => {
    const dbPath = path.join(tmpDir, 'nueva.db');
    const out = bootDb(dbPath);
    assertUnifiedSchema(out);
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.statsRows, []);
    assert.equal(out.apiStats, null);
    assert.equal(out.apiFollowers, null);
  });
});
