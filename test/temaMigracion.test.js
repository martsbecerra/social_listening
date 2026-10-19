'use strict';

// Columna tema de detected_posts (src/db.js): la migración es aditiva, con
// guarda, no toca las filas guardadas y se puede correr más de una vez; y
// saveDetectedPost la escribe. db.js abre la base al hacer require y es un
// singleton por proceso: los casos de migración arrancan src/db.js en un
// proceso hijo contra una base temporal (como postImagesMigration.test.js);
// los del guardado usan la base temporal de este proceso. Nunca toca
// data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tema-db-'));
process.env.MONITORING_DB_PATH = path.join(tmpDir, 'funciones.db'); // ANTES de cargar db.js

const { DatabaseSync } = require('node:sqlite');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const DB_JS = path.join(__dirname, '..', 'src', 'db.js');
const NOW = '2026-10-01T12:00:00.000Z';

// Arranca src/db.js en un proceso hijo contra dbPath (ahí corre la
// migración) y devuelve las columnas y las filas de detected_posts.
function bootDb(dbPath) {
  const script = `
    require(${JSON.stringify(DB_JS)});
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.MONITORING_DB_PATH, { readOnly: true });
    const out = {
      columns: raw.prepare('PRAGMA table_info(detected_posts)').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull })),
      rows: raw.prepare('SELECT * FROM detected_posts ORDER BY id').all(),
      integrity: raw.prepare('PRAGMA integrity_check').all(),
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

// Una base "de antes del cambio": el esquema de hoy sin la columna tema (se
// arma con db.js y se le saca), con posteos guardados de las dos redes.
function createOldDb(dbPath) {
  bootDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE detected_posts DROP COLUMN tema');
  const insert = db.prepare(`
    INSERT INTO detected_posts
      (id, account, url, caption, matched_reason, likes, comments, posted_at, detected_at, notified, title, sentiment, post_type, followers, plataforma, metrics_updated_at, ignored, refresh_misses, image_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('3988633620029857812', 'cuenta_uno', 'https://www.instagram.com/p/AAA111/', 'Texto con ñ y emoji 🎉', 'Búsqueda: jorge macri · habla de CABA', 1500, 42, NOW, NOW, 1, 'Un título', 'negativo', 'reel', 9500, 'instagram', NOW, 0, 0, 'ok');
  insert.run('3988633620029857813', 'cuenta_dos', 'https://www.instagram.com/p/BBB222/', '', 'Búsqueda: gcba — sin clasificar (falló el clasificador, relevancia sin verificar)', null, 7, NOW, NOW, 0, null, null, null, null, 'instagram', null, 1, 2, null);
  insert.run('1900000000000000001', 'cuenta_x', 'https://x.com/cuenta_x/status/1900000000000000001', 'un tuit', 'Búsqueda por palabra clave: "macri"', 3, 1, NOW, NOW, 0, 'Tuit', 'neutral', null, null, 'x', null, 0, 0, null);
  // Pasadas por JSON, igual que las que devuelve bootDb: así se comparan
  // objeto contra objeto.
  const rows = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM detected_posts ORDER BY id').all()));
  const columns = db.prepare('PRAGMA table_info(detected_posts)').all().map((c) => c.name);
  db.close();
  return { rows, columns };
}

const names = (out) => out.columns.map((c) => c.name);
const withoutTema = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tema'));

describe('migración de la columna tema de detected_posts', { concurrency: false }, () => {
  test('base anterior al cambio: suma la columna al final, anulable, y no toca ninguna fila', () => {
    const dbPath = path.join(tmpDir, 'vieja.db');
    const antes = createOldDb(dbPath);
    assert.ok(!antes.columns.includes('tema'), 'la base vieja no tiene tema');

    const out = bootDb(dbPath);
    assert.deepEqual(names(out), [...antes.columns, 'tema']);
    const tema = out.columns.find((c) => c.name === 'tema');
    assert.deepEqual([tema.type, tema.notnull], ['TEXT', 0]);
    assert.equal(out.rows.length, 3);
    assert.deepEqual(out.rows.map(withoutTema), antes.rows);
    for (const row of out.rows) assert.equal(row.tema, null, 'las filas viejas quedan sin tema hasta el backfill');
    assert.deepEqual(out.integrity, [{ integrity_check: 'ok' }]);
  });

  test('segunda carga: no cambia nada', () => {
    const dbPath = path.join(tmpDir, 'vieja.db');
    const primera = bootDb(dbPath);
    const segunda = bootDb(dbPath);
    assert.deepEqual(segunda.columns, primera.columns);
    assert.deepEqual(segunda.rows, primera.rows);
    assert.equal(names(segunda).filter((n) => n === 'tema').length, 1, 'sin columna repetida');
  });

  test('base nueva: nace con la columna', () => {
    const out = bootDb(path.join(tmpDir, 'nueva.db'));
    assert.ok(names(out).includes('tema'));
    assert.deepEqual(out.rows, []);
  });
});

describe('saveDetectedPost guarda el tema', { concurrency: false }, () => {
  // La base temporal de este proceso (MONITORING_DB_PATH de arriba).
  const db = require('../src/db');
  const post = (id, plataforma, url, extra = {}) => ({ id, plataforma, account: 'cuenta', url, caption: 'texto', matchedReason: 'Búsqueda: x', likes: 10, comments: 2, postedAt: NOW, title: 'T', sentiment: 'neutral', ...extra });
  const temaDe = (id, plataforma) => db.listDetectedPosts({ page: 1, pageSize: 50, plataforma }).posts.find((p) => p.id === id).tema;

  test('con tema, sin tema y sin clasificar; el listado lo trae', () => {
    assert.equal(db.saveDetectedPost(post('ig1', 'instagram', 'https://www.instagram.com/p/IG1/', { tema: 'Transporte' })), true);
    assert.equal(db.saveDetectedPost(post('ig2', 'instagram', 'https://www.instagram.com/p/IG2/')), true);
    assert.equal(db.saveDetectedPost(post('ig3', 'instagram', 'https://www.instagram.com/p/IG3/', { title: null, sentiment: null, tema: null })), true);
    assert.equal(db.saveDetectedPost(post('x1', 'x', 'https://x.com/c/status/1', { tema: 'Coyuntura / Otros' })), true);
    assert.equal(temaDe('ig1', 'instagram'), 'Transporte');
    assert.equal(temaDe('ig2', 'instagram'), null, 'un llamador que no manda tema deja null');
    assert.equal(temaDe('ig3', 'instagram'), null);
    assert.equal(temaDe('x1', 'x'), 'Coyuntura / Otros');
  });
});
