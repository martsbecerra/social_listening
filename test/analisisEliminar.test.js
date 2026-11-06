'use strict';

// "Eliminar análisis" de la galería (db.deleteAnalisis y DELETE
// /api/analisis/:id) y adónde lleva "Ver posteo" en el pop-up del Mapa
// (verPosteo de GET /api/reclamos). Lo gastado queda en apify_calls; los
// reclamos de la publicación se van solo con su último análisis (nunca los
// importados); la foto, solo si no la usa otro análisis ni el Monitoreo.
// Express con una sesión simulada, una base y una carpeta de fotos
// temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-eliminar-'));
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.MONITORING_MEDIA_DIR = MEDIA;
process.env.MONITORING_GEO_DIR = tmp;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const postImages = require('../src/postImages');
const analysisRoutes = require('../src/analysisRoutes');
const reclamosRoutes = require('../src/reclamosRoutes');

const URL_A = 'https://www.instagram.com/p/AAA/';
const URL_B = 'https://www.instagram.com/p/BBB/';
const URL_C = 'https://www.instagram.com/p/CCC/';

function analisisOk(url, postId) {
  const id = db.startAnalisis({ plataforma: 'instagram', url });
  db.saveAnalisisPost(id, 'instagram', { id: postId, ownerUsername: 'cuenta', caption: 'Texto', commentsCount: 10 });
  db.finishAnalisis(id, 'instagram', {
    traidos: 10,
    analizados: 10,
    tonos: { positivos: 5, neutrales: 3, negativos: 2, ruido: 0 },
    resultado: { lecturaEstrategica: 'Una lectura.' },
    temas: [],
    comentarios: [],
    reclamos: 1,
    usdApify: 0.1,
    usdModelo: 0.05,
  });
  db.insertApifyCall({ phase: 'analisis', plataforma: 'instagram', actor: 'apify/instagram-scraper', target: url, items: 1, ok: true, usd: 0.1, analisisId: id });
  return id;
}

const reclamo = (id, extra = {}) => ({
  id, comentarioId: id, plataforma: 'instagram', textoOriginal: 'Está sucio', categoria: 'Higiene', detectedAt: '2026-10-25T10:00:00.000Z', ...extra,
});

function fotoEnDisco(postId) {
  const paths = postImages.imagePaths('instagram', postId);
  fs.mkdirSync(paths.dir, { recursive: true });
  for (const size of postImages.SIZES) fs.writeFileSync(paths[size], 'jpg');
  return paths;
}

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { email: 'equipo@buenosaires.gob.ar' };
    next();
  });
  analysisRoutes.register(app);
  reclamosRoutes.register(app);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const borrar = (id, plataforma = 'instagram') => fetch(`${base}/api/analisis/${id}?plataforma=${plataforma}`, { method: 'DELETE' });

describe('eliminar un análisis', { concurrency: false }, () => {
  test('con otro de la misma publicación, sus reclamos y la foto quedan; lo gastado también', async () => {
    const viejo = analisisOk(URL_A, '3700000000000000001');
    const nuevo = analisisOk(URL_A, '3700000000000000001');
    db.upsertReclamo(reclamo('ig:a1', { postUrl: URL_A }));
    const paths = fotoEnDisco('3700000000000000001');

    const r = await borrar(viejo);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: viejo, reclamos: 0, foto: false });
    assert.equal(db.getAnalisis(viejo, 'instagram'), null);
    assert.ok(db.getAnalisis(nuevo, 'instagram'), 'el otro sigue');
    assert.ok(db.getReclamo('ig:a1'), 'el reclamo lo muestra el que queda');
    assert.ok(fs.existsSync(paths.thumb) && fs.existsSync(paths.full));
    assert.deepEqual(db.sumApifyUsdForAnalisis(viejo), { usd: 0.1, calls: 1 }, 'la llamada a Apify sigue en los gastos');

    const ultimo = await (await borrar(nuevo)).json();
    assert.deepEqual(ultimo, { id: nuevo, reclamos: 1, foto: true });
    assert.equal(db.getReclamo('ig:a1'), null, 'con el último se van sus reclamos');
    assert.ok(!fs.existsSync(paths.thumb) && !fs.existsSync(paths.full), 'y la foto');
  });

  test('un reclamo importado de un Excel no se borra', () => {
    const id = analisisOk(URL_B, '3700000000000000002');
    db.upsertReclamo(reclamo('ig:b1', { postUrl: URL_B }));
    db.upsertReclamo(reclamo('xlsx:b2', { postUrl: URL_B, importOrigen: 'reclamos_historicos.xlsx' }));
    assert.deepEqual(db.deleteAnalisis(id, 'instagram'), { reclamos: 1, fotoLibre: '3700000000000000002' });
    assert.ok(db.getReclamo('xlsx:b2'));
  });

  test('la foto de una publicación del Monitoreo queda', async () => {
    const postId = '3700000000000000003';
    db.saveDetectedPost({ id: postId, plataforma: 'instagram', account: 'gcba', url: URL_C, caption: 'x', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: '2026-10-25T10:00:00.000Z', title: 'T', sentiment: 'neutral', postType: 'imagen' });
    const paths = fotoEnDisco(postId);
    const id = analisisOk(URL_C, postId);
    assert.deepEqual(await (await borrar(id)).json(), { id, reclamos: 0, foto: false });
    assert.ok(fs.existsSync(paths.full));
  });

  test('uno en curso no (409); de otra red o que no existe, 404; sin plataforma, 400', async () => {
    const enCurso = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/DDD/' });
    assert.equal((await borrar(enCurso)).status, 409);
    assert.ok(db.getAnalisis(enCurso, 'instagram'));
    assert.throws(() => db.deleteAnalisis(enCurso, 'instagram'), (err) => err.code === 'ANALISIS_EN_CURSO');
    const id = analisisOk('https://www.instagram.com/p/EEE/', '3700000000000000005');
    assert.equal((await borrar(id, 'x')).status, 404);
    assert.ok(db.getAnalisis(id, 'instagram'), 'desde otra red no se borra');
    assert.equal((await borrar(999999)).status, 404);
    assert.equal((await fetch(`${base}/api/analisis/${id}`, { method: 'DELETE' })).status, 400);
    assert.throws(() => db.deleteAnalisis(id), /falta plataforma/);
  });
});

describe('"Ver posteo" del Mapa', { concurrency: false }, () => {
  test('al análisis, al pop-up del Monitoreo, a la red, o nada', async () => {
    const conAnalisis = 'https://www.instagram.com/p/VP1/';
    const delMonitoreo = 'https://www.instagram.com/p/VP2/';
    const ignorado = 'https://www.instagram.com/p/VP3/';
    const suelto = 'https://www.instagram.com/p/VP4/';
    const analisisId = analisisOk(conAnalisis, '3700000000000000011');
    // Una publicación que además está en el Monitoreo: gana el análisis.
    db.saveDetectedPost({ id: '3700000000000000011', plataforma: 'instagram', account: 'gcba', url: conAnalisis, caption: 'x', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: '2026-10-25T10:00:00.000Z', title: 'T', sentiment: 'neutral', postType: 'imagen' });
    db.saveDetectedPost({ id: '3700000000000000012', plataforma: 'instagram', account: 'gcba', url: delMonitoreo, caption: 'x', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: '2026-10-25T10:00:00.000Z', title: 'T', sentiment: 'neutral', postType: 'imagen' });
    db.saveDetectedPost({ id: '3700000000000000013', plataforma: 'instagram', account: 'gcba', url: ignorado, caption: 'x', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: '2026-10-25T10:00:00.000Z', title: 'T', sentiment: 'neutral', postType: 'imagen' });
    db.ignorePost('3700000000000000013', 'instagram');
    db.upsertReclamo(reclamo('ig:v1', { postUrl: conAnalisis }));
    db.upsertReclamo(reclamo('ig:v1b', { postUrl: conAnalisis }));
    db.upsertReclamo(reclamo('ig:v2', { postUrl: delMonitoreo }));
    db.upsertReclamo(reclamo('ig:v3', { postUrl: ignorado }));
    db.upsertReclamo(reclamo('ig:v4', { postUrl: suelto }));
    db.upsertReclamo(reclamo('elnino:1', { importOrigen: 'Panel El Niño', textoOriginal: 'Salguero 767' }));
    db.upsertReclamo(reclamo('x:1', { plataforma: 'x', commentUrl: 'https://x.com/alguien/status/1' }));

    const ig = await (await fetch(`${base}/api/reclamos?plataforma=instagram`)).json();
    const porId = Object.fromEntries(ig.reclamos.map((r) => [r.id, r.verPosteo]));
    assert.deepEqual(porId['ig:v1'], { tipo: 'analisis', analisisId, url: conAnalisis });
    assert.deepEqual(porId['ig:v1b'], porId['ig:v1']);
    assert.deepEqual(porId['ig:v2'], { tipo: 'monitoreo', postId: '3700000000000000012', url: delMonitoreo });
    assert.deepEqual(porId['ig:v3'], { tipo: 'red', url: ignorado }, 'uno ignorado no está en la tabla: va a la red');
    assert.deepEqual(porId['ig:v4'], { tipo: 'red', url: suelto });
    assert.equal(porId['elnino:1'], null, 'sin link, sin "Ver posteo"');

    const x = await (await fetch(`${base}/api/reclamos?plataforma=x`)).json();
    assert.deepEqual(x.reclamos.find((r) => r.id === 'x:1').verPosteo, { tipo: 'red', url: 'https://x.com/alguien/status/1' });
  });
});
