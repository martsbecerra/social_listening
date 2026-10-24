'use strict';

// Lo que trae Apify para un análisis (src/apify.js): la publicación con su
// fecha, id, código, tipo y foto; los comentarios con likes "sin dato"
// cuando no vienen; los topes (300 por defecto); las dos corridas con sus
// avisos y su gasto atado al análisis; el aviso de espera del limitador.
// fetch simulado y base temporal: ni Apify real ni data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-apify-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.APIFY_API_TOKEN = 'token-de-test';
delete process.env.COMMENTS_LIMIT;
delete process.env.COMMENTS_ANALYSIS_LIMIT;
delete process.env.X_COMMENTS_ANALYSIS_LIMIT;

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const apify = require('../src/apify');
const { createLimiter } = require('../src/concurrencyLimiter');
const { runWithContext, getContext } = require('../src/usageContext');
const { prepareCommentSample } = require('../src/commentSample');
const { prepareXSample } = require('../src/x/sample');

const POST_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'apify', 'post-detail.json'), 'utf8'));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.COMMENTS_LIMIT;
  delete process.env.COMMENTS_ANALYSIS_LIMIT;
  delete process.env.X_COMMENTS_ANALYSIS_LIMIT;
});

describe('la publicación de un análisis', () => {
  test('trae id, código, fecha, tipo y foto, además de lo de siempre', () => {
    const post = apify.normalizePost(POST_FIXTURE, [], 'https://www.instagram.com/p/DdaeSUND2AU/');
    assert.equal(post.id, '3988633620029857812');
    assert.equal(post.shortCode, 'DdaeSUND2AU');
    assert.equal(post.postedAt, '2026-09-18T03:30:29.000Z');
    assert.equal(post.postType, 'reel');
    assert.equal(post.imageUrl, 'https://cdn.invalid/displayUrl');
    assert.equal(post.likesCount, 2);
    assert.equal(post.commentsCount, 0);
    assert.equal(post.videoPlayCount, 225);
    assert.equal(post.ownerUsername, 'jorge2027macri');
  });

  test('likes ocultos (-1) quedan null, nunca -1 ni 0', () => {
    const post = apify.normalizePost([{ ...POST_FIXTURE[0], likesCount: -1 }], [], 'u');
    assert.equal(post.likesCount, null);
  });

  test('sin la corrida de la publicación: sin id, fecha ni foto (no se inventan)', () => {
    const post = apify.normalizePost([], [{ ownerUsername: 'respaldo', caption: 'del padre' }], 'u');
    assert.equal(post.id, null);
    assert.equal(post.postedAt, null);
    assert.equal(post.imageUrl, null);
    assert.equal(post.ownerUsername, 'respaldo');
  });
});

describe('los comentarios', () => {
  test('likes sin dato o negativos quedan null; sin texto no entra; la fecha queda', () => {
    const comments = apify.normalizeComments([
      { id: '1', ownerUsername: 'a', text: ' hola ', likesCount: 3, timestamp: '2026-10-20T10:00:00.000Z' },
      { id: '2', ownerUsername: 'b', text: 'sin likes' },
      { id: '3', ownerUsername: 'c', text: 'raro', likesCount: -1 },
      { id: '4', ownerUsername: 'd', text: '   ' },
    ]);
    assert.deepEqual(
      comments.map((c) => [c.apifyId, c.likesCount, c.timestamp]),
      [
        ['1', 3, '2026-10-20T10:00:00.000Z'],
        ['2', null, null],
        ['3', null, null],
      ]
    );
    assert.equal(comments[0].text, 'hola');
  });
});

describe('topes', () => {
  test('COMMENTS_LIMIT: 300 por defecto, el del .env, hasta 500', () => {
    assert.equal(apify.resolveCommentsLimit(), 300);
    process.env.COMMENTS_LIMIT = '120';
    assert.equal(apify.resolveCommentsLimit(), 120);
    process.env.COMMENTS_LIMIT = '9999';
    assert.equal(apify.resolveCommentsLimit(), 500);
    process.env.COMMENTS_LIMIT = 'muchos';
    assert.equal(apify.resolveCommentsLimit(), 300);
  });

  test('COMMENTS_ANALYSIS_LIMIT: 300 en Instagram; X sigue con 150 y no lo lee: tiene X_COMMENTS_ANALYSIS_LIMIT', () => {
    const comments = Array.from({ length: 400 }, (_, i) => ({ username: `u${i}`, text: `t${i}`, likesCount: i, timestamp: null, isVerified: false }));
    assert.equal(prepareCommentSample(comments).sample.length, 300);
    const items = Array.from({ length: 400 }, (_, i) => ({ id: String(i), username: `u${i}`, text: `t${i}`, likes: i, kind: 'reply' }));
    const muestraX = () => prepareXSample({ post: { id: 'p', text: 'post', username: 'x' }, items }, new Map()).sample.length;
    assert.equal(muestraX(), 150);
    process.env.COMMENTS_ANALYSIS_LIMIT = '200';
    assert.equal(prepareCommentSample(comments).sample.length, 200);
    assert.equal(muestraX(), 150, 'subir el de Instagram no sube X');
    process.env.X_COMMENTS_ANALYSIS_LIMIT = '120';
    assert.equal(muestraX(), 120);
    assert.equal(prepareCommentSample(comments).sample.length, 200);
  });
});

describe('las dos corridas', () => {
  test('cada una pide lo suyo, avisa al conseguir cupo y queda atada al análisis', async () => {
    const bodies = [];
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      const items = body.resultsType === 'posts' ? POST_FIXTURE : [{ id: 'c1', ownerUsername: 'a', text: 'hola', timestamp: '2026-09-18T04:00:00.000Z' }];
      return new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const avisos = [];
    const analisisId = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/DdaeSUND2AU/' });
    const [postItems, { items: commentItems, limit }] = await runWithContext({ phase: 'analisis', analisisId }, () =>
      Promise.all([
        apify.fetchAnalysisPost('https://www.instagram.com/p/DdaeSUND2AU/', { onAcquired: () => avisos.push('publicación') }),
        apify.fetchAnalysisComments('https://www.instagram.com/p/DdaeSUND2AU/', { onAcquired: () => avisos.push('comentarios') }),
      ])
    );
    assert.equal(limit, 300);
    const comentarios = bodies.find((b) => b.resultsType === 'comments');
    assert.equal(comentarios.resultsLimit, 300);
    assert.equal(comentarios.addParentData, true);
    assert.equal(bodies.find((b) => b.resultsType === 'posts').resultsLimit, 1);
    assert.deepEqual(avisos.sort(), ['comentarios', 'publicación']);
    const data = apify.buildAnalysisData(postItems, commentItems, 'https://www.instagram.com/p/DdaeSUND2AU/', limit);
    assert.equal(data.comments.length, 1);
    assert.equal(data.scrapeMeta.rawCommentItems, 1);
    assert.equal(db.sumApifyUsdForAnalisis(analisisId).calls, 2, 'las dos filas de apify_calls llevan el id del análisis');
  });
});

describe('el limitador', () => {
  test('onQueued avisa solo a la tarea que tiene que esperar', async () => {
    const limiter = createLimiter(1, 'test', { quiet: true });
    const avisos = [];
    let soltar;
    const primera = limiter.run(() => new Promise((r) => (soltar = r)), 'a', { onQueued: () => avisos.push('a') });
    const segunda = limiter.run(async () => 'b', 'b', { onQueued: () => avisos.push('b') });
    assert.deepEqual(avisos, ['b']);
    await new Promise((r) => setImmediate(r)); // la tarea arranca en el tick siguiente
    soltar('a');
    assert.deepEqual(await Promise.all([primera, segunda]), ['a', 'b']);
  });

  test('un aviso que tira no frena la tarea', async () => {
    const limiter = createLimiter(1, 'test', { quiet: true });
    let soltar;
    const primera = limiter.run(() => new Promise((r) => (soltar = r)));
    const segunda = limiter.run(async () => 'sigue', 'x', {
      onQueued: () => {
        throw new Error('aviso roto');
      },
    });
    await new Promise((r) => setImmediate(r));
    soltar('listo');
    assert.equal(await segunda, 'sigue');
    await primera;
  });

  test('la tarea que esperó cupo corre con el contexto de quien la encoló, no con el de la que lo soltó', async () => {
    const limiter = createLimiter(1, 'test', { quiet: true });
    let soltar;
    const vistos = [];
    const primera = runWithContext({ runId: 17, phase: 'benchmark' }, () =>
      limiter.run(() => new Promise((r) => (soltar = r)).then(() => vistos.push(['benchmark', getContext()])))
    );
    const segunda = runWithContext({ phase: 'analisis', analisisId: 5 }, () => limiter.run(async () => vistos.push(['analisis', getContext()])));
    const tercera = runWithContext({ runId: 18, phase: 'busqueda' }, () => limiter.run(async () => vistos.push(['busqueda', getContext()])));
    await new Promise((r) => setImmediate(r));
    soltar();
    await Promise.all([primera, segunda, tercera]);
    assert.deepEqual(vistos, [
      ['benchmark', { runId: 17, phase: 'benchmark' }],
      ['analisis', { phase: 'analisis', analisisId: 5 }],
      ['busqueda', { runId: 18, phase: 'busqueda' }],
    ]);
  });

  test('con el limitador de Apify lleno, la corrida del análisis queda con su analisis_id y las del ciclo sin él', async () => {
    const sueltas = [];
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.resultsType !== 'posts') await new Promise((r) => sueltas.push(r));
      const items = body.resultsType === 'posts' ? POST_FIXTURE : [];
      return new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const analisisId = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/LLENO1/' });
    const ciclo = runWithContext({ phase: 'benchmark' }, () =>
      Promise.all(
        Array.from({ length: apify.APIFY_MAX_CONCURRENT }, (_, i) =>
          apify.runActorSync({ directUrls: [`https://www.instagram.com/cuentallena${i}/`], resultsType: 'details' }, { plataforma: 'instagram' })
        )
      )
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(apify.apifyLimiter.inFlight(), apify.APIFY_MAX_CONCURRENT);
    let encolada = false;
    const delAnalisis = runWithContext({ phase: 'analisis', analisisId }, () =>
      apify.fetchAnalysisPost('https://www.instagram.com/p/LLENO1/', { onQueued: () => (encolada = true) })
    );
    assert.equal(encolada, true, 'esperó cupo');
    while (sueltas.length < apify.APIFY_MAX_CONCURRENT) await new Promise((r) => setImmediate(r));
    sueltas.forEach((r) => r());
    await Promise.all([ciclo, delAnalisis]);
    const { DatabaseSync } = require('node:sqlite');
    const base = new DatabaseSync(process.env.MONITORING_DB_PATH, { readOnly: true });
    const filas = base.prepare("SELECT phase, analisis_id, target FROM apify_calls WHERE target LIKE '%LLENO1%' OR target LIKE '%cuentallena%'").all();
    base.close();
    const delPost = filas.filter((f) => f.target.includes('LLENO1'));
    assert.equal(delPost.length, 1);
    assert.equal(delPost[0].phase, 'analisis');
    assert.equal(delPost[0].analisis_id, analisisId);
    const delCiclo = filas.filter((f) => f.target.includes('cuentallena'));
    assert.equal(delCiclo.length, apify.APIFY_MAX_CONCURRENT);
    assert.ok(delCiclo.every((f) => f.phase === 'benchmark' && f.analisis_id === null));
  });
});
