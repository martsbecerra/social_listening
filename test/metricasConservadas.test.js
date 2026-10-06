'use strict';

// Regla única de métricas (openspec/changes/refresco-url, REQ-RURL-06): al
// refrescar un posteo YA guardado (db.applyMetricsRefresh, que usa el
// refresco de métricas, y db.updatePostMetricsIfChanged, que usa el
// benchmark), un valor ausente, null o negativo NUNCA pisa lo guardado de
// ese campo, aunque el otro campo sí venga; solo un número >= 0 pisa. Antes
// `likes ?? null` escribía NULL encima de un valor real cuando faltaba uno
// solo de los dos. Base temporal: nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-metricas-'));
const dbPath = path.join(dbDir, 'monitoring.db');
process.env.MONITORING_DB_PATH = dbPath;

const db = require('../src/db');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readRaw(id) {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return raw.prepare('SELECT likes, comments, retweets, views, post_type, metrics_updated_at FROM detected_posts WHERE id = ?').get(id);
  } finally {
    raw.close();
  }
}

function seed(id, overrides = {}) {
  assert.equal(
    db.saveDetectedPost({
      id,
      account: 'cuenta',
      url: `https://www.instagram.com/p/${id}/`,
      caption: 'obras',
      matchedReason: 'test',
      likes: 50,
      comments: 7,
      postedAt: new Date().toISOString(),
      title: 't',
      sentiment: 'neutral',
      postType: null,
      followers: null,
      plataforma: 'instagram',
      ...overrides,
    }),
    true
  );
}

describe('regla única de métricas: ausente, null o negativo nunca pisa lo guardado', { concurrency: false }, () => {
  test('applyMetricsRefresh: falta un solo campo, centinela -1, objeto vacío, 0 real, texto', async () => {
    seed('p1');

    // Falta solo likes: los comentarios se actualizan, los likes quedan.
    let r = db.applyMetricsRefresh('p1', { likes: null, comments: 9 });
    assert.equal(r.changed, true);
    assert.deepEqual([r.previousLikes, r.previousComments, r.likes, r.comments], [50, 7, 50, 9]);
    let row = readRaw('p1');
    assert.deepEqual([row.likes, row.comments], [50, 9]);
    const marca1 = row.metrics_updated_at;
    assert.ok(marca1, 'metrics_updated_at se escribe');

    // Centinela -1 en los dos: nada cambia, pero la marca avanza (la
    // cadencia tiene que poder decir "ya lo revisé recién").
    await sleep(5);
    r = db.applyMetricsRefresh('p1', { likes: -1, comments: -1 });
    assert.equal(r.changed, false);
    row = readRaw('p1');
    assert.deepEqual([row.likes, row.comments], [50, 9]);
    assert.ok(row.metrics_updated_at > marca1, 'la marca avanza aunque no haya cambios');

    // Sin métricas (claves ausentes): igual.
    r = db.applyMetricsRefresh('p1', {});
    assert.equal(r.changed, false);
    assert.deepEqual([readRaw('p1').likes, readRaw('p1').comments], [50, 9]);

    // Un texto no es un número: se trata como ausente.
    r = db.applyMetricsRefresh('p1', { likes: '5', comments: 'x' });
    assert.equal(r.changed, false);
    assert.deepEqual([readRaw('p1').likes, readRaw('p1').comments], [50, 9]);

    // Un 0 real sí pisa (el contador oculto ya llega como null desde el adapter).
    r = db.applyMetricsRefresh('p1', { likes: 0, comments: 0 });
    assert.equal(r.changed, true);
    assert.deepEqual([readRaw('p1').likes, readRaw('p1').comments], [0, 0]);
  });

  test('applyMetricsRefresh: un valor guardado en null se completa cuando llega un número', () => {
    seed('p2', { likes: null, comments: null });
    const r = db.applyMetricsRefresh('p2', { likes: 12, comments: null });
    assert.equal(r.changed, true);
    assert.deepEqual([readRaw('p2').likes, readRaw('p2').comments], [12, null]);
  });

  test('applyMetricsRefresh: la misma regla para retweets y vistas (X)', () => {
    assert.equal(
      db.saveDetectedPost({
        id: 'x1',
        account: 'cuentax',
        url: 'https://x.com/cuentax/status/1',
        caption: 'obras',
        matchedReason: 'test',
        likes: 3,
        comments: 1,
        retweets: 10,
        views: 1000,
        postedAt: new Date().toISOString(),
        title: 't',
        sentiment: 'neutral',
        postType: null,
        followers: null,
        plataforma: 'x',
      }),
      true
    );
    const r = db.applyMetricsRefresh('x1', { likes: 4, comments: null, retweets: -1, views: undefined });
    assert.equal(r.changed, true);
    const row = readRaw('x1');
    assert.deepEqual([row.likes, row.comments, row.retweets, row.views], [4, 1, 10, 1000]);
  });

  test('updatePostMetricsIfChanged (benchmark): null o -1 conservan el campo; post_type se completa solo si faltaba', () => {
    seed('p3', { likes: 20, comments: 3 });

    // Solo post_type nuevo: escribe (true) sin tocar los contadores.
    assert.equal(db.updatePostMetricsIfChanged('p3', { likes: null, comments: null, postType: 'reel' }), true);
    let row = readRaw('p3');
    assert.deepEqual([row.likes, row.comments, row.post_type], [20, 3, 'reel']);

    // -1 en likes, número en comments: solo cambian los comentarios.
    assert.equal(db.updatePostMetricsIfChanged('p3', { likes: -1, comments: 5, postType: 'imagen' }), true);
    row = readRaw('p3');
    assert.deepEqual([row.likes, row.comments, row.post_type], [20, 5, 'reel'], 'post_type ya conocido no se pisa');

    // Nada nuevo: false, sin escribir.
    assert.equal(db.updatePostMetricsIfChanged('p3', { likes: undefined, comments: 5, postType: null }), false);
    assert.deepEqual([readRaw('p3').likes, readRaw('p3').comments], [20, 5]);
  });

  test('un posteo ignorado no se toca por ninguno de los dos caminos', () => {
    seed('p4', { url: 'https://www.instagram.com/p/p4/' });
    db.ignorePost('p4', 'instagram');
    assert.equal(db.applyMetricsRefresh('p4', { likes: 99, comments: 99 }), null);
    assert.equal(db.updatePostMetricsIfChanged('p4', { likes: 99, comments: 99, postType: 'reel' }), false);
    assert.deepEqual([readRaw('p4').likes, readRaw('p4').comments], [50, 7]);
  });
});
