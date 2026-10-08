'use strict';

// Fotos, paso 6 (openspec/changes/monitoreo-fotos, REQ-FOTO-06): la ruta que
// sirve la foto de un posteo y cómo sale cada posteo en el listado
// (src/postImageRoutes.js). Solo con sesión iniciada, por id y plataforma,
// con un tamaño de lista cerrada; el archivo se arma con datos de la base y
// el link original de Instagram no va al navegador.
//
// La ruta se prueba con una app de prueba en un puerto local de esta
// máquina: el mismo gate de login de la app (src/auth/gate.js) y la ruta
// montada con postImageRoutes.register. No se levanta server.js ni el
// scheduler. Base y carpeta de fotos temporales; las imágenes se generan.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fotos-ruta-'));
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_MEDIA_DIR = MEDIA;
process.env.SESSION_SECRET = 'secreto-de-test';
process.env.APP_BASE_URL = 'http://localhost'; // cookie sin "secure"
delete process.env.POST_IMAGES;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sharp = require('sharp');

const db = require('../src/db');
const postImages = require('../src/postImages');
const postImageRoutes = require('../src/postImageRoutes');
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');

const IG_DIR = path.join(MEDIA, 'instagram');
const LINK = 'https://scontent-eze1-1.cdninstagram.com/v/t51/foto.jpg?oh=FIRMA_SECRETA';
const NOW = new Date().toISOString();

// Cookie de sesión como la que deja el login.
function sessionCookie(email = 'prueba@test.local') {
  let header = '';
  setSessionCookie({ append: (name, value) => (header = value) }, email);
  return header.split(';')[0];
}

let server;
let base;
let COOKIE;
const logs = [];
const consoleOriginal = { log: console.log, error: console.error };

function guardar(id, plataforma, url) {
  assert.equal(
    db.saveDetectedPost({ id, plataforma, account: 'cuenta', url, caption: 'texto', matchedReason: 'Búsqueda: x', likes: 10, comments: 2, postedAt: NOW, title: 'T', sentiment: 'neutral', postType: 'imagen' }),
    true
  );
}

before(async () => {
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  // Posteos: uno con sus dos copias, uno sin foto, uno con la marca en la
  // base pero sin archivos, uno de X.
  guardar('CONFOTO', 'instagram', 'https://www.instagram.com/p/CONFOTO/');
  guardar('SINFOTO', 'instagram', 'https://www.instagram.com/p/SINFOTO/');
  guardar('SINARCHIVO', 'instagram', 'https://www.instagram.com/p/SINARCHIVO/');
  guardar('x1', 'x', 'https://x.com/cuenta/status/1');

  const imagen = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
  const fetchFn = async () => new Response(imagen, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const saved = await postImages.savePostImage({ plataforma: 'instagram', id: 'CONFOTO', url: LINK }, { fetchFn });
  assert.equal(saved.ok, true);
  db.markPostImageSaved('CONFOTO', 'instagram', { sourceUrl: LINK, width: saved.width, height: saved.height, savedAt: '2026-10-07T12:00:00.000Z' });
  db.markPostImageFailed('SINFOTO', 'instagram', { sourceUrl: LINK, status: 'vencido' });
  db.markPostImageSaved('SINARCHIVO', 'instagram', { sourceUrl: LINK, width: 100, height: 100, savedAt: '2026-10-07T12:00:00.000Z' });

  // Un archivo fuera de la carpeta de fotos, que nunca tiene que salir.
  fs.writeFileSync(path.join(tmp, 'secreto.jpg'), 'no deberia servirse');

  // App de prueba: el gate de login de la app y la ruta de la imagen.
  const app = express();
  app.use(createAuthGate());
  postImageRoutes.register(app);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  COOKIE = sessionCookie();
});

after(async () => {
  Object.assign(console, consoleOriginal);
  await new Promise((resolve) => server.close(resolve));
});

const pedir = (ruta, { cookie = COOKIE, headers = {} } = {}) =>
  fetch(`${base}${ruta}`, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
const ruta = (id, query) => `/api/monitoring/posts/${encodeURIComponent(id)}/image?${new URLSearchParams(query)}`;

describe('ruta de la foto de un posteo', { concurrency: false }, () => {
  test('sin sesión: 401, y con una cookie inventada también', async () => {
    const sinCookie = await pedir(ruta('CONFOTO', { plataforma: 'instagram', size: 'thumb' }), { cookie: null });
    assert.equal(sinCookie.status, 401);
    assert.match((await sinCookie.json()).error, /iniciar sesión/);
    const falsa = await pedir(ruta('CONFOTO', { plataforma: 'instagram', size: 'thumb' }), { cookie: 'sl_session=inventada.firma' });
    assert.equal(falsa.status, 401);
  });

  test('con sesión: manda la miniatura y la imagen grande, como JPEG y con caché privada', async () => {
    for (const size of ['thumb', 'full']) {
      const res = await pedir(ruta('CONFOTO', { plataforma: 'instagram', size }));
      assert.equal(res.status, 200, size);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(fs.readFileSync(path.join(IG_DIR, `CONFOTO_${size}.jpg`))), 'los mismos bytes que el archivo');
      const meta = await sharp(body).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height], size === 'thumb' ? ['jpeg', 360, 450] : ['jpeg', 720, 900]);
    }
  });

  test('si el navegador ya la tiene, responde 304', async () => {
    const primera = await pedir(ruta('CONFOTO', { plataforma: 'instagram', size: 'thumb' }));
    const etag = primera.headers.get('etag');
    assert.ok(etag);
    await primera.arrayBuffer();
    // Cache-Control propio: sin él, el fetch de Node suma "no-cache" a todo
    // pedido condicional y el servidor manda el archivo entero.
    const segunda = await pedir(ruta('CONFOTO', { plataforma: 'instagram', size: 'thumb' }), { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
    assert.equal(segunda.status, 304);
    assert.equal((await segunda.arrayBuffer()).byteLength, 0);
  });

  test('tamaño fuera de la lista o sin plataforma: 400', async () => {
    for (const query of [{ plataforma: 'instagram', size: 'original' }, { plataforma: 'instagram' }, { plataforma: 'instagram', size: '../thumb' }, { size: 'thumb' }, { plataforma: '', size: 'thumb' }]) {
      const res = await pedir(ruta('CONFOTO', query));
      assert.equal(res.status, 400, JSON.stringify(query));
      assert.match(res.headers.get('content-type'), /application\/json/);
    }
  });

  test('otra plataforma, posteo sin foto, posteo que no existe: 404', async () => {
    const casos = [
      ['CONFOTO', { plataforma: 'x', size: 'thumb' }], // el id es de Instagram
      ['x1', { plataforma: 'x', size: 'thumb' }], // X no tiene fotos
      ['x1', { plataforma: 'instagram', size: 'thumb' }],
      ['SINFOTO', { plataforma: 'instagram', size: 'thumb' }], // el intento falló: no hay copia
      ['no-existe', { plataforma: 'instagram', size: 'full' }],
      ['CONFOTO', { plataforma: 'tiktok', size: 'thumb' }],
    ];
    for (const [id, query] of casos) {
      const res = await pedir(ruta(id, query));
      assert.equal(res.status, 404, `${id} ${JSON.stringify(query)}`);
      assert.match((await res.json()).error, /no tiene imagen guardada/);
    }
  });

  test('la base dice que hay copia pero el archivo no está: 404, sin romper', async () => {
    const res = await pedir(ruta('SINARCHIVO', { plataforma: 'instagram', size: 'thumb' }));
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no tiene imagen guardada/);
  });

  test('el archivo sale de la base, no del pedido: nada fuera de la carpeta de fotos', async () => {
    // Posteos GUARDADOS y con la foto anotada, cuyo id intenta salir de la
    // carpeta o nombrar otro archivo. Con el id en la base, el pedido pasa
    // los controles anteriores y llega a armar el camino del archivo: ahí lo
    // tiene que frenar que ese id no sirve como nombre.
    // En cada lugar donde uno de esos ids podría terminar apuntando hay un
    // archivo cebo: si la defensa se cae, sale en la respuesta.
    const CEBO = 'CEBO: esto no deberia servirse';
    const hostiles = ['../cebo', '..\\cebo', '../../cebo', 'sub/cebo', 'cebo.x', 'cebo x', 'CONFOTO_thumb.jpg'];
    hostiles.forEach((id, i) => {
      guardar(id, 'instagram', `https://www.instagram.com/p/HOSTIL${i}/`);
      assert.equal(db.markPostImageSaved(id, 'instagram', { sourceUrl: LINK, width: 100, height: 100, savedAt: '2026-10-07T12:00:00.000Z' }), true);
      assert.ok(db.getPostImage(id, 'instagram').savedAt, `${id}: está guardado y con foto anotada`);
    });
    const cebos = [
      path.join(tmp, 'cebo_thumb.jpg'),
      path.join(MEDIA, 'cebo_thumb.jpg'),
      path.join(IG_DIR, 'cebo_thumb.jpg'),
      path.join(IG_DIR, 'sub', 'cebo_thumb.jpg'),
      path.join(IG_DIR, 'cebo.x_thumb.jpg'),
      path.join(IG_DIR, 'cebo x_thumb.jpg'),
      path.join(IG_DIR, 'CONFOTO_thumb.jpg_thumb.jpg'),
    ];
    for (const file of cebos) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, CEBO);
    }

    for (const id of hostiles) {
      const res = await pedir(ruta(id, { plataforma: 'instagram', size: 'thumb' }));
      const texto = await res.text();
      assert.equal(res.status, 404, `${id} -> ${res.status}`);
      assert.ok(!texto.includes('CEBO'), id);
    }

    // Control del propio test: con la defensa apagada (un camino armado sin
    // validar el id), esos mismos pedidos SÍ entregan el cebo. Si esto
    // dejara de pasar, lo de arriba ya no estaría probando nada.
    const original = postImages.imagePaths;
    postImages.imagePaths = (plataforma, id) => {
      const dir = path.join(MEDIA, plataforma);
      return { dir, thumb: path.join(dir, `${id}_thumb.jpg`), full: path.join(dir, `${id}_full.jpg`) };
    };
    try {
      for (const id of ['../cebo', 'cebo.x', 'CONFOTO_thumb.jpg']) {
        const res = await pedir(ruta(id, { plataforma: 'instagram', size: 'thumb' }));
        assert.equal(res.status, 200, `sin la defensa, ${id} entrega el cebo`);
        assert.equal(await res.text(), CEBO);
      }
    } finally {
      postImages.imagePaths = original;
    }

    // Ids que no están en la base, escritos de varias formas: tampoco.
    for (const id of ['../secreto', '..%2Fsecreto', '..\\secreto', 'instagram/CONFOTO', '%2e%2e/%2e%2e/secreto']) {
      const res = await fetch(`${base}/api/monitoring/posts/${id}/image?plataforma=instagram&size=thumb`, { redirect: 'manual', headers: { Cookie: COOKIE } });
      assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`);
      assert.ok(!(await res.text()).includes('no deberia servirse'), id);
    }
    // Y la carpeta de fotos no se sirve como estático.
    const directo = await pedir('/media/instagram/CONFOTO_thumb.jpg');
    assert.equal(directo.status, 404);

    for (const file of cebos) fs.rmSync(file, { force: true });
  });

  test('POST_IMAGES=0 apaga las descargas, no las fotos: lo ya guardado se sigue sirviendo', async () => {
    process.env.POST_IMAGES = '0';
    try {
      assert.equal(postImages.isEnabled(), false);
      const res = await pedir(ruta('CONFOTO', { plataforma: 'instagram', size: 'full' }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      await res.arrayBuffer();
      // Y el listado sigue armando las direcciones.
      const fila = db.listDetectedPosts({ page: 1, pageSize: 50, plataforma: 'instagram' }).posts.find((p) => p.id === 'CONFOTO');
      assert.ok(postImageRoutes.withImage(fila, 'instagram').image.thumbUrl);
    } finally {
      delete process.env.POST_IMAGES;
    }
  });
});

describe('el posteo en el listado', { concurrency: false }, () => {
  const fila = (id, plataforma) => db.listDetectedPosts({ page: 1, pageSize: 50, plataforma }).posts.find((p) => p.id === id);

  test('con copias guardadas: direcciones de la miniatura y de la imagen grande, que la ruta atiende', async () => {
    const original = fila('CONFOTO', 'instagram');
    const post = postImageRoutes.withImage(original, 'instagram');
    assert.deepEqual(post.image, {
      thumbUrl: '/api/monitoring/posts/CONFOTO/image?plataforma=instagram&size=thumb&v=2026-10-07T12%3A00%3A00.000Z',
      fullUrl: '/api/monitoring/posts/CONFOTO/image?plataforma=instagram&size=full&v=2026-10-07T12%3A00%3A00.000Z',
      status: 'ok',
      width: 1080,
      height: 1350,
    });
    for (const url of [post.image.thumbUrl, post.image.fullUrl]) {
      const res = await pedir(url);
      assert.equal(res.status, 200, url);
      await res.arrayBuffer();
    }
    // El resto del posteo no cambia y la fila original no se toca.
    assert.deepEqual([post.id, post.likes, post.title, post.post_type, post.url], ['CONFOTO', 10, 'T', 'imagen', 'https://www.instagram.com/p/CONFOTO/']);
    assert.equal(original.image_saved_at, '2026-10-07T12:00:00.000Z');
  });

  test('las columnas crudas no salen: el link original de Instagram no va al navegador', () => {
    for (const id of ['CONFOTO', 'SINFOTO', 'SINARCHIVO']) {
      const post = postImageRoutes.withImage(fila(id, 'instagram'), 'instagram');
      for (const column of ['image_source_url', 'image_status', 'image_saved_at', 'image_width', 'image_height']) assert.ok(!(column in post), `${id}.${column}`);
      const json = JSON.stringify(post);
      assert.ok(!json.includes('cdninstagram') && !json.includes('FIRMA_SECRETA'), id);
    }
  });

  test('sin copias: direcciones en null y el estado del último intento', () => {
    assert.deepEqual(postImageRoutes.withImage(fila('SINFOTO', 'instagram'), 'instagram').image, { thumbUrl: null, fullUrl: null, status: 'vencido', width: null, height: null });
    guardar('NUNCA', 'instagram', 'https://www.instagram.com/p/NUNCA/');
    assert.deepEqual(postImageRoutes.withImage(fila('NUNCA', 'instagram'), 'instagram').image, { thumbUrl: null, fullUrl: null, status: null, width: null, height: null });
  });

  test('una plataforma sin fotos: image es null', () => {
    const post = postImageRoutes.withImage(fila('x1', 'x'), 'x');
    assert.equal(post.image, null);
    assert.ok(!('image_source_url' in post));
    assert.equal(post.id, 'x1');
  });

  test('un id con caracteres raros va escapado en la dirección', () => {
    const post = postImageRoutes.withImage({ id: 'a b/c?d', image_saved_at: '2026-10-07T12:00:00.000Z', image_status: 'ok', image_width: 1, image_height: 1 }, 'instagram');
    assert.ok(post.image.thumbUrl.startsWith('/api/monitoring/posts/a%20b%2Fc%3Fd/image?'));
  });
});
