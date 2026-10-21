'use strict';

// Estadísticas (fase 2 del rediseño, estadisticas-backend): las lecturas de
// la base para la sección (db.listPostsForStats, getFirstPostedAt,
// listFollowersForStats). Base temporal; nunca toca data/monitoring.db, ni
// llama a Apify o a un LLM.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-stats-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');

let siguienteId = 1000;
function guardar(campos) {
  const id = String(campos.id || siguienteId++);
  const plataforma = campos.plataforma || 'instagram';
  const url = plataforma === 'x' ? `https://x.com/cuenta/status/${id}` : `https://www.instagram.com/p/C${id}/`;
  assert.equal(
    db.saveDetectedPost({
      id,
      plataforma,
      url,
      account: 'cuenta',
      caption: 'texto',
      matchedReason: 'Búsqueda: x',
      likes: 10,
      comments: 2,
      ...campos,
      id,
    }),
    true
  );
  return id;
}

describe('db: lecturas para Estadísticas', { concurrency: false }, () => {
  test('sin posteos: getFirstPostedAt da null y las listas vienen vacías', () => {
    assert.equal(db.getFirstPostedAt('instagram'), null);
    assert.deepEqual(db.listPostsForStats({ plataforma: 'instagram', desdeIso: '2026-01-01T00:00:00.000Z', hastaIso: '2027-01-01T00:00:00.000Z' }), []);
    assert.equal(db.listFollowersForStats('instagram').size, 0);
  });

  test('listPostsForStats: rango [desde, hasta), solo visibles y de esa plataforma, en orden de publicación', () => {
    const a = guardar({ postedAt: '2026-10-02T12:00:00.000Z' });
    const b = guardar({ postedAt: '2026-10-01T03:00:00.000Z' }); // justo en el borde de abajo: entra
    guardar({ postedAt: '2026-10-03T03:00:00.000Z' }); // justo en el borde de arriba: no entra
    const ignorado = guardar({ postedAt: '2026-10-02T13:00:00.000Z' });
    assert.equal(db.ignorePost(ignorado, 'instagram'), true);
    guardar({ plataforma: 'x', postedAt: '2026-10-02T14:00:00.000Z' });

    const filas = db.listPostsForStats({ plataforma: 'instagram', desdeIso: '2026-10-01T03:00:00.000Z', hastaIso: '2026-10-03T03:00:00.000Z' });
    assert.deepEqual(filas.map((f) => f.id), [b, a]);
    assert.deepEqual(
      Object.keys(filas[0]).sort(),
      ['account', 'caption', 'comments', 'followers', 'id', 'likes', 'post_type', 'posted_at', 'sentiment', 'tema', 'title'].sort()
    );
  });

  test('getFirstPostedAt: el primer posteo visible de la plataforma', () => {
    const viejo = guardar({ postedAt: '2026-09-01T10:00:00.000Z' });
    assert.equal(db.ignorePost(viejo, 'instagram'), true); // ignorado: no cuenta
    assert.equal(db.getFirstPostedAt('instagram'), '2026-10-01T03:00:00.000Z');
    assert.equal(db.getFirstPostedAt('x'), '2026-10-02T14:00:00.000Z');
  });

  test('listFollowersForStats: manda la caché; sin caché, el posteo más reciente que lo trae', () => {
    guardar({ account: 'medio', followers: 500, postedAt: '2026-10-05T10:00:00.000Z' });
    guardar({ account: 'chica', followers: 90, postedAt: '2026-10-04T10:00:00.000Z' });
    const t = Date.now();
    while (Date.now() - t < 3); // detected_at distinto del anterior
    guardar({ account: 'chica', followers: 120, postedAt: '2026-10-01T10:00:00.000Z' }); // detectado después: más reciente
    guardar({ account: 'sin_numero', followers: null, postedAt: '2026-10-05T10:00:00.000Z' });
    db.upsertAccountFollowers({ account: 'medio', plataforma: 'instagram', followers: 800 });
    db.upsertAccountFollowers({ account: 'medio', plataforma: 'x', followers: 5 });

    const seguidores = db.listFollowersForStats('instagram');
    assert.equal(seguidores.get('medio'), 800);
    assert.equal(seguidores.get('chica'), 120);
    assert.equal(seguidores.has('sin_numero'), false);
  });

  test('sin plataforma tiran, como el resto de las funciones por plataforma', () => {
    assert.throws(() => db.listPostsForStats({ desdeIso: 'a', hastaIso: 'b' }), /falta plataforma/);
    assert.throws(() => db.getFirstPostedAt(), /falta plataforma/);
    assert.throws(() => db.listFollowersForStats(''), /falta plataforma/);
  });
});
