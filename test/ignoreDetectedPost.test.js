'use strict';

// Contrato de ignore-detected-post (openspec/changes/ignore-detected-post).
// Corre contra un tempfile: nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ignore-'));
const dbPath = path.join(dbDir, 'monitoring.db');
process.env.MONITORING_DB_PATH = dbPath;

const db = require('../src/db');

function samplePost(overrides = {}) {
  return {
    id: 'p1',
    account: 'cuenta',
    url: 'https://www.instagram.com/p/AAA/',
    caption: 'hola jorge',
    matchedReason: 'test',
    likes: 10,
    comments: 2,
    postedAt: new Date().toISOString(),
    title: 'titulo',
    sentiment: 'neutral',
    postType: 'imagen',
    followers: 100,
    plataforma: 'instagram',
    ...overrides,
  };
}

function readRaw(id) {
  const raw = new DatabaseSync(dbPath);
  try {
    return raw.prepare('SELECT id, url, likes, ignored, ignored_at FROM detected_posts WHERE id = ?').get(id);
  } finally {
    raw.close();
  }
}

describe('ignore-detected-post', { concurrency: false }, () => {
test('un posteo nuevo se lista y cuenta (REQ-IGNORE-03)', () => {
  assert.equal(db.saveDetectedPost(samplePost()), true);
  const { posts, total } = db.listDetectedPosts({ page: 1, pageSize: 20 });
  assert.equal(total, 1);
  assert.equal(posts[0].id, 'p1');
  assert.equal(db.countRecentPosts(7), 1);
});

test('ignorar y corregir sentimiento van por id Y plataforma: desde otra solapa no se toca nada', () => {
  // Sin plataforma no hay default: es un error de programación.
  assert.throws(() => db.ignorePost('p1'), /falta plataforma/);
  assert.throws(() => db.updateSentiment('p1', 'positivo'), /falta plataforma/);

  // Desde X, el posteo p1 (de Instagram) no existe: false y sin cambios.
  assert.equal(db.ignorePost('p1', 'x'), false);
  assert.equal(db.getPostIgnoreState('p1').ignored, false);
  assert.equal(db.updateSentiment('p1', 'positivo', 'x'), false);
  assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20 }).posts[0].sentiment, 'neutral');

  // Desde Instagram sí.
  assert.equal(db.updateSentiment('p1', 'positivo', 'instagram'), true);
  assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20 }).posts[0].sentiment, 'positivo');
  assert.equal(db.updateSentiment('no-existe', 'positivo', 'instagram'), false);
});

test('ignorar deja la fila, la saca del listado y no pisa ignored_at (REQ-IGNORE-02, REQ-IGNORE-03)', async () => {
  assert.equal(db.ignorePost('p1', 'instagram'), true);
  const after = db.getPostIgnoreState('p1');
  assert.equal(after.ignored, true);
  assert.ok(after.ignoredAt);

  const listed = db.listDetectedPosts({ page: 1, pageSize: 20 });
  assert.equal(listed.total, 0);
  assert.equal(listed.posts.length, 0);
  assert.equal(db.countRecentPosts(7), 0);

  const row = readRaw('p1');
  assert.equal(row.ignored, 1);
  assert.ok(row.ignored_at);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(db.ignorePost('p1', 'instagram'), true, 'ya ignorado: existe igual, no es un 404');
  assert.equal(db.getPostIgnoreState('p1').ignoredAt, after.ignoredAt);
  assert.equal(db.ignorePost('no-existe', 'instagram'), false);
});

test('un ignorado sigue siendo conocido: misma URL no re-inserta (REQ-IGNORE-04)', () => {
  assert.equal(db.isKnownPost('p1', 'https://www.instagram.com/p/AAA/'), true);
  assert.equal(db.findExistingPostId('p1', 'https://www.instagram.com/p/AAA/'), 'p1');
  assert.equal(db.saveDetectedPost(samplePost()), false);
  assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20 }).total, 0);
});

test('applyMetricsRefresh no escribe likes de un ignorado (REQ-IGNORE-05)', () => {
  const result = db.applyMetricsRefresh('p1', { likes: 99, comments: 50 });
  assert.equal(result, null);
  assert.equal(readRaw('p1').likes, 10);
});

test('un posteo no ignorado sigue visible al lado de uno ignorado (REQ-IGNORE-03)', () => {
  assert.equal(
    db.saveDetectedPost(
      samplePost({
        id: 'p2',
        url: 'https://www.instagram.com/p/BBB/',
        likes: 3,
      })
    ),
    true
  );
  const { posts, total } = db.listDetectedPosts({ page: 1, pageSize: 20 });
  assert.equal(total, 1);
  assert.equal(posts[0].id, 'p2');
  assert.equal(db.isKnownPost('p1', 'https://www.instagram.com/p/AAA/'), true);
});
});
