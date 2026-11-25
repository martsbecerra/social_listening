'use strict';

// Cache-Control: no-store en /api (noStoreApi de src/httpSecurity.js, rama
// rate-limit-y-salud): lo llevan las respuestas JSON con sesión, los 401 del
// gate, un 404 de la ruta de la foto y /API/... en mayúsculas; NO lo llevan
// las fotos (conservan su caché de un año, también en el 304), el resumen
// público (60 s), una ruta que pone su propia caché ni lo que no es /api.
//
// App de prueba con el gate real, la ruta real de la foto de un posteo y la
// del resumen público. Base y carpeta de fotos temporales; la imagen se
// genera con sharp. No carga server.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-no-store-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_MEDIA_DIR = path.join(tmp, 'media');
process.env.APP_BASE_URL = 'http://localhost';
process.env.ALLOWED_EMAILS = 'prueba@test.local';
delete process.env.POST_IMAGES;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sharp = require('sharp');

const db = require('../src/db');
const postImages = require('../src/postImages');
const postImageRoutes = require('../src/postImageRoutes');
const publicResumen = require('../src/publicResumen');
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');
const { noStoreApi, securityHeaders } = require('../src/httpSecurity');

const ROOT = path.join(__dirname, '..');
let server;
let base;
let COOKIE;

function sessionCookie(email = 'prueba@test.local') {
  let header = '';
  setSessionCookie({ append: (name, value) => (header = value) }, email);
  return header.split(';')[0];
}

const pedir = (ruta, { cookie = COOKIE, headers = {} } = {}) =>
  fetch(`${base}${ruta}`, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });

before(async () => {
  const ahora = new Date().toISOString();
  assert.equal(
    db.saveDetectedPost({ id: 'CONFOTO', plataforma: 'instagram', account: 'cuenta', url: 'https://www.instagram.com/p/CONFOTO/', caption: 't', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: ahora, title: 'T', sentiment: 'neutral', postType: 'imagen' }),
    true
  );
  const imagen = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 90, b: 160 } } }).jpeg().toBuffer();
  const link = 'https://scontent-eze1-1.cdninstagram.com/v/foto.jpg';
  const saved = await postImages.savePostImage(
    { plataforma: 'instagram', id: 'CONFOTO', url: link },
    { fetchFn: async () => new Response(imagen, { status: 200, headers: { 'content-type': 'image/jpeg' } }) }
  );
  assert.equal(saved.ok, true);
  db.markPostImageSaved('CONFOTO', 'instagram', { sourceUrl: link, width: saved.width, height: saved.height, savedAt: ahora });

  const app = express();
  app.use(securityHeaders());
  app.use(noStoreApi);
  app.use(createAuthGate());
  postImageRoutes.register(app);
  publicResumen.register(app);
  app.get('/api/algo', (req, res) => res.json({ ok: true }));
  app.get('/api/propia', (req, res) => {
    res.set('Cache-Control', 'private, max-age=86400');
    res.json({ ok: true });
  });
  app.get('/js/algo.js', (req, res) => res.type('js').send('1;'));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  COOKIE = sessionCookie();
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('JSON con sesión, un 401 del gate, un 404 de la foto y /API/... llevan no-store', async () => {
  assert.equal((await pedir('/api/algo')).headers.get('cache-control'), 'no-store');
  const sinSesion = await pedir('/api/algo', { cookie: null });
  assert.equal(sinSesion.status, 401);
  assert.equal(sinSesion.headers.get('cache-control'), 'no-store');
  const sinFoto = await pedir('/api/monitoring/posts/NOEXISTE/image?plataforma=instagram&size=thumb');
  assert.equal(sinFoto.status, 404);
  assert.equal(sinFoto.headers.get('cache-control'), 'no-store');
  assert.equal((await pedir('/API/Algo')).headers.get('cache-control'), 'no-store');
});

test('la foto conserva su caché de un año, también en el 304', async () => {
  const ruta = '/api/monitoring/posts/CONFOTO/image?plataforma=instagram&size=thumb';
  const r = await pedir(ruta);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), postImageRoutes.CACHE_CONTROL);
  assert.match(postImageRoutes.CACHE_CONTROL, /max-age=31536000/);
  const etag = r.headers.get('etag');
  assert.ok(etag);
  // Con http.request: fetch le agrega Cache-Control: no-cache a un pedido
  // condicional y Express contesta 200 en vez de 304.
  const otraVez = await new Promise((resolve, reject) => {
    const u = new URL(`${base}${ruta}`);
    const req = require('http').request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { Cookie: COOKIE, 'If-None-Match': etag } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(otraVez.statusCode, 304);
  assert.equal(otraVez.headers['cache-control'], postImageRoutes.CACHE_CONTROL);
});

test('el resumen público y una ruta con caché propia la conservan; lo que no es /api no se toca', async () => {
  const resumen = await pedir('/api/public/resumen', { cookie: null });
  assert.equal(resumen.status, 200);
  assert.equal(resumen.headers.get('cache-control'), `public, max-age=${publicResumen.CACHE_MS / 1000}`);
  assert.equal((await pedir('/api/propia')).headers.get('cache-control'), 'private, max-age=86400');
  assert.notEqual((await pedir('/js/algo.js')).headers.get('cache-control'), 'no-store');
});

test('la foto del análisis y las comunas siguen poniendo su propia caché (código)', () => {
  const analisis = fs.readFileSync(path.join(ROOT, 'src', 'analysisRoutes.js'), 'utf8');
  assert.match(analisis, /headers: \{ 'Cache-Control': CACHE_CONTROL/);
  const reclamos = fs.readFileSync(path.join(ROOT, 'src', 'reclamosRoutes.js'), 'utf8');
  assert.match(reclamos, /res\.set\('Cache-Control', 'private, max-age=86400'\)/);
});
