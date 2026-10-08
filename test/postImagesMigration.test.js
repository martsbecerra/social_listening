'use strict';

// Columnas image_* de detected_posts (src/db.js, openspec/changes/
// monitoreo-fotos): la migración es aditiva, con guarda, no toca las filas
// guardadas y se puede correr más de una vez; y las funciones que anotan
// cómo salió la foto van por id y plataforma. db.js abre la base al hacer
// require y es un singleton por proceso: los casos de migración arrancan
// src/db.js en un proceso hijo contra una base temporal; los de las
// funciones usan la base temporal de este proceso. Nunca toca
// data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fotos-db-'));
process.env.MONITORING_DB_PATH = path.join(tmpDir, 'funciones.db'); // ANTES de cargar db.js

const { DatabaseSync } = require('node:sqlite');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const DB_JS = path.join(__dirname, '..', 'src', 'db.js');
const IMAGE_COLUMNS = ['image_source_url', 'image_status', 'image_saved_at', 'image_width', 'image_height'];
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

// Una base "de antes del cambio": el esquema de hoy sin las columnas de la
// foto (se arma con db.js y se le sacan), con posteos guardados.
function createOldDb(dbPath, { drop = IMAGE_COLUMNS } = {}) {
  bootDb(dbPath);
  const db = new DatabaseSync(dbPath);
  for (const column of drop) db.exec(`ALTER TABLE detected_posts DROP COLUMN ${column}`);
  const insert = db.prepare(`
    INSERT INTO detected_posts
      (id, account, url, caption, matched_reason, likes, comments, posted_at, detected_at, notified, title, sentiment, post_type, followers, plataforma, metrics_updated_at, ignored, refresh_misses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('3988633620029857812', 'cuenta_uno', 'https://www.instagram.com/p/AAA111/', 'Texto con ñ y emoji 🎉', 'Búsqueda: jorge macri', 1500, 42, NOW, NOW, 1, 'Un título', 'negativo', 'reel', 9500, 'instagram', NOW, 0, 0);
  insert.run('3988633620029857813', 'cuenta_dos', 'https://www.instagram.com/p/BBB222/', '', 'Búsqueda: gcba', null, 7, NOW, NOW, 0, null, null, null, null, 'instagram', null, 1, 2);
  insert.run('1900000000000000001', 'cuenta_x', 'https://x.com/cuenta_x/status/1900000000000000001', 'un tuit', 'Coincidencia con palabra clave: "macri"', 3, 1, NOW, NOW, 0, 'Tuit', 'neutral', null, null, 'x', null, 0, 0);
  // Pasadas por JSON, igual que las que devuelve bootDb: así se comparan
  // objeto contra objeto.
  const rows = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM detected_posts ORDER BY id').all()));
  const columns = db.prepare('PRAGMA table_info(detected_posts)').all().map((c) => c.name);
  db.close();
  return { rows, columns };
}

const names = (out) => out.columns.map((c) => c.name);
const withoutImage = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !IMAGE_COLUMNS.includes(key)));

describe('migración de las columnas image_* de detected_posts', { concurrency: false }, () => {
  test('base anterior al cambio: suma las cinco columnas y no toca ninguna fila', () => {
    const dbPath = path.join(tmpDir, 'vieja.db');
    const antes = createOldDb(dbPath);
    for (const column of IMAGE_COLUMNS) assert.ok(!antes.columns.includes(column), `la base vieja no tiene ${column}`);

    const out = bootDb(dbPath);
    // Las columnas de antes siguen, en el mismo orden, y las nuevas van al final.
    assert.deepEqual(names(out), [...antes.columns, ...IMAGE_COLUMNS]);
    const nuevas = out.columns.filter((c) => IMAGE_COLUMNS.includes(c.name));
    assert.deepEqual(
      nuevas.map((c) => [c.name, c.type, c.notnull]),
      [
        ['image_source_url', 'TEXT', 0],
        ['image_status', 'TEXT', 0],
        ['image_saved_at', 'TEXT', 0],
        ['image_width', 'INTEGER', 0],
        ['image_height', 'INTEGER', 0],
      ],
      'todas anulables'
    );
    // Las filas, idénticas en todo lo que ya tenían; lo nuevo, vacío.
    assert.equal(out.rows.length, 3);
    assert.deepEqual(out.rows.map(withoutImage), antes.rows);
    for (const row of out.rows) for (const column of IMAGE_COLUMNS) assert.equal(row[column], null);
    assert.deepEqual(out.integrity, [{ integrity_check: 'ok' }]);
  });

  test('segunda carga: no cambia nada', () => {
    const dbPath = path.join(tmpDir, 'vieja.db');
    const primera = bootDb(dbPath);
    const segunda = bootDb(dbPath);
    assert.deepEqual(segunda.columns, primera.columns);
    assert.deepEqual(segunda.rows, primera.rows);
    assert.equal(names(segunda).filter((n) => n.startsWith('image_')).length, 5, 'sin columnas repetidas');
  });

  test('migración que quedó a medias: completa las que faltan', () => {
    const dbPath = path.join(tmpDir, 'a-medias.db');
    const antes = createOldDb(dbPath, { drop: ['image_saved_at', 'image_height'] });
    assert.ok(antes.columns.includes('image_status') && !antes.columns.includes('image_saved_at'));
    const out = bootDb(dbPath);
    for (const column of IMAGE_COLUMNS) assert.ok(names(out).includes(column), column);
    assert.equal(names(out).length, antes.columns.length + 2);
    assert.equal(out.rows.length, 3);
  });

  test('base nueva: nace con las columnas', () => {
    const out = bootDb(path.join(tmpDir, 'nueva.db'));
    for (const column of IMAGE_COLUMNS) assert.ok(names(out).includes(column), column);
    assert.deepEqual(out.rows, []);
  });
});

describe('funciones de la foto del posteo', { concurrency: false }, () => {
  // La base temporal de este proceso (MONITORING_DB_PATH de arriba).
  const db = require('../src/db');
  const post = (id, plataforma, url) => ({ id, plataforma, account: 'cuenta', url, caption: 'texto', matchedReason: 'Búsqueda: x', likes: 10, comments: 2, postedAt: NOW, title: 'T', sentiment: 'neutral', postType: 'imagen' });
  const SIN_FOTO = { sourceUrl: null, status: null, savedAt: null, width: null, height: null };
  const LINK = 'https://scontent.cdninstagram.com/v/foto.jpg?oh=abc';

  test('un posteo recién guardado no tiene foto', () => {
    assert.equal(db.saveDetectedPost(post('ig1', 'instagram', 'https://www.instagram.com/p/IG1/')), true);
    assert.equal(db.saveDetectedPost(post('ig2', 'instagram', 'https://www.instagram.com/p/IG2/')), true);
    assert.equal(db.saveDetectedPost(post('x1', 'x', 'https://x.com/c/status/1')), true);
    assert.deepEqual({ ...db.getPostImage('ig1', 'instagram') }, SIN_FOTO);
    assert.equal(db.getPostImage('no-existe', 'instagram'), null);
    assert.equal(db.getPostImage('ig1', 'x'), null, 'desde otra plataforma no se ve');
  });

  test('anotar las copias guardadas', () => {
    assert.equal(db.markPostImageSaved('ig1', 'instagram', { sourceUrl: LINK, width: 1080, height: 1920, savedAt: '2026-10-02T10:00:00.000Z' }), true);
    assert.deepEqual({ ...db.getPostImage('ig1', 'instagram') }, { sourceUrl: LINK, status: 'ok', savedAt: '2026-10-02T10:00:00.000Z', width: 1080, height: 1920 });
    // Otro posteo y otra plataforma: sin cambios.
    assert.deepEqual({ ...db.getPostImage('ig2', 'instagram') }, SIN_FOTO);
    assert.equal(db.markPostImageSaved('ig1', 'x', { sourceUrl: LINK, width: 1, height: 1 }), false, 'id de otra plataforma');
    assert.equal(db.markPostImageSaved('no-existe', 'instagram', { sourceUrl: LINK, width: 1, height: 1 }), false);
  });

  test('un intento fallido cambia el estado y el link, no la marca de "hay foto"', () => {
    const otroLink = 'https://scontent.cdninstagram.com/v/foto.jpg?oh=vencido';
    assert.equal(db.markPostImageFailed('ig1', 'instagram', { sourceUrl: otroLink, status: 'vencido' }), true);
    assert.deepEqual({ ...db.getPostImage('ig1', 'instagram') }, { sourceUrl: otroLink, status: 'vencido', savedAt: '2026-10-02T10:00:00.000Z', width: 1080, height: 1920 });

    // En un posteo sin copia: queda el estado, sigue sin foto.
    assert.equal(db.markPostImageFailed('ig2', 'instagram', { sourceUrl: LINK, status: 'error' }), true);
    assert.deepEqual({ ...db.getPostImage('ig2', 'instagram') }, { sourceUrl: LINK, status: 'error', savedAt: null, width: null, height: null });
    assert.equal(db.markPostImageFailed('ig2', 'x', { sourceUrl: LINK, status: 'error' }), false);
  });

  test('guardar después de un fallo deja todo en "ok"; savedAt por defecto es ahora', () => {
    const antes = Date.now();
    assert.equal(db.markPostImageSaved('ig2', 'instagram', { sourceUrl: LINK, width: 900.4, height: 0 }), true);
    const image = db.getPostImage('ig2', 'instagram');
    assert.equal(image.status, 'ok');
    assert.equal(image.width, 900, 'redondea');
    assert.equal(image.height, null, 'una medida que no sirve queda vacía');
    assert.ok(Date.parse(image.savedAt) >= antes - 1000);
  });

  test('dejar la foto pendiente de reintentar, y listar las pendientes', () => {
    const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);
    for (const n of [3, 4, 5, 6]) assert.equal(db.saveDetectedPost(post(`ig${n}`, 'instagram', `https://www.instagram.com/p/IG${n}/`)), true);
    assert.deepEqual(db.listPostsWithPendingImage('instagram'), []);

    const linkDe = (id) => `${LINK}&de=${id}`;
    for (const id of ['ig3', 'ig4', 'ig5', 'ig6']) assert.equal(db.markPostImagePending(id, 'instagram', { sourceUrl: linkDe(id) }), true);
    assert.deepEqual({ ...db.getPostImage('ig3', 'instagram') }, { sourceUrl: linkDe('ig3'), status: 'pendiente', savedAt: null, width: null, height: null });
    assert.equal(db.markPostImagePending('ig3', 'x', { sourceUrl: LINK }), false, 'id de otra plataforma');
    assert.equal(db.markPostImagePending('no-existe', 'instagram', { sourceUrl: LINK }), false);

    // Primero el que recibió su link hace menos: el último refresco o, si
    // nunca se refrescó, la detección.
    raw.prepare('UPDATE detected_posts SET detected_at = ?, metrics_updated_at = NULL WHERE id = ?').run('2026-10-05T10:00:00.000Z', 'ig3');
    raw.prepare('UPDATE detected_posts SET detected_at = ?, metrics_updated_at = ? WHERE id = ?').run('2026-09-01T10:00:00.000Z', '2026-10-07T10:00:00.000Z', 'ig4');
    raw.prepare('UPDATE detected_posts SET detected_at = ?, metrics_updated_at = NULL WHERE id = ?').run('2026-10-06T10:00:00.000Z', 'ig5');
    raw.prepare('UPDATE detected_posts SET detected_at = ?, metrics_updated_at = NULL WHERE id = ?').run('2026-10-01T10:00:00.000Z', 'ig6');
    assert.deepEqual(db.listPostsWithPendingImage('instagram').map((r) => ({ ...r })), [
      { id: 'ig4', url: linkDe('ig4') },
      { id: 'ig5', url: linkDe('ig5') },
      { id: 'ig3', url: linkDe('ig3') },
      { id: 'ig6', url: linkDe('ig6') },
    ]);
    assert.deepEqual(db.listPostsWithPendingImage('instagram', 2).map((r) => r.id), ['ig4', 'ig5'], 'con tope');
    assert.deepEqual(db.listPostsWithPendingImage('x'), [], 'por plataforma');

    // Un ignorado no se reintenta; uno que ya se guardó o falló, tampoco.
    assert.equal(db.ignorePost('ig5', 'instagram'), true);
    db.markPostImageSaved('ig4', 'instagram', { sourceUrl: linkDe('ig4'), width: 10, height: 10 });
    db.markPostImageFailed('ig6', 'instagram', { sourceUrl: linkDe('ig6'), status: 'vencido' });
    assert.deepEqual(db.listPostsWithPendingImage('instagram').map((r) => r.id), ['ig3']);

    // Con copias guardadas: queda pendiente sin perder la marca de "hay foto".
    const antes = db.getPostImage('ig2', 'instagram');
    assert.equal(db.markPostImagePending('ig2', 'instagram', { sourceUrl: linkDe('ig2') }), true);
    const despues = db.getPostImage('ig2', 'instagram');
    assert.deepEqual([despues.status, despues.savedAt, despues.width], ['pendiente', antes.savedAt, antes.width]);
    assert.throws(() => db.markPostImagePending('ig3', undefined, { sourceUrl: LINK }), /falta plataforma/);
    assert.throws(() => db.listPostsWithPendingImage(), /falta plataforma/);
    raw.close();
  });

  test('no toca nada más del posteo, y el listado trae las columnas', () => {
    const { posts } = db.listDetectedPosts({ page: 1, pageSize: 50, plataforma: 'instagram' });
    const ig1 = posts.find((p) => p.id === 'ig1');
    assert.deepEqual([ig1.likes, ig1.comments, ig1.title, ig1.sentiment, ig1.post_type, ig1.caption], [10, 2, 'T', 'neutral', 'imagen', 'texto']);
    assert.equal(ig1.image_status, 'vencido');
    assert.equal(ig1.image_saved_at, '2026-10-02T10:00:00.000Z');
    const equis = db.listDetectedPosts({ page: 1, pageSize: 50, plataforma: 'x' }).posts[0];
    for (const column of IMAGE_COLUMNS) assert.equal(equis[column], null);
  });

  test('sin plataforma, o con un estado que no existe, es un error de programación', () => {
    assert.throws(() => db.getPostImage('ig1'), /falta plataforma/);
    assert.throws(() => db.markPostImageSaved('ig1', '', { sourceUrl: LINK }), /falta plataforma/);
    assert.throws(() => db.markPostImageFailed('ig1', undefined, { sourceUrl: LINK, status: 'error' }), /falta plataforma/);
    for (const status of ['ok', 'pendiente', '', undefined]) {
      assert.throws(() => db.markPostImageFailed('ig1', 'instagram', { sourceUrl: LINK, status }), /estado inválido/);
    }
    assert.equal(db.getPostImage('ig1', 'instagram').status, 'vencido', 'un estado inválido no escribe nada');
  });
});
