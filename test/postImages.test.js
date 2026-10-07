'use strict';

// Foto de los posteos (src/postImages.js, openspec/changes/monitoreo-fotos):
// dos copias JPEG de una sola descarga, reglas de la descarga, un fallo que
// no rompe nada y la tanda con limitador y corte. La red está simulada (se
// inyecta fetchFn) y las imágenes se generan en memoria con sharp: nada
// llama a Instagram ni a Apify, y todo se escribe en una carpeta temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fotos-'));
process.env.MONITORING_MEDIA_DIR = MEDIA; // ANTES de cargar el módulo
delete process.env.POST_IMAGES;

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const postImages = require('../src/postImages');

const IG_DIR = path.join(MEDIA, 'instagram');
// Un link como los de Instagram: host del CDN y una firma que no tiene que
// aparecer nunca en los logs.
const FIRMA = 'oh=FIRMA_SECRETA_123';
const link = (host = 'scontent-eze1-1.cdninstagram.com') => `https://${host}/v/t51.2885-15/foto.jpg?stp=dst-jpg&${FIRMA}`;

// --------------------------------------------------------------------------
// Imágenes de prueba, generadas.
// --------------------------------------------------------------------------
function makeImage(width, height, { format = 'jpeg', alpha = false, orientation } = {}) {
  let image = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 200, g: 60, b: 40, alpha: 0.5 } : { r: 40, g: 120, b: 200 },
    },
  });
  if (orientation) image = image.withMetadata({ orientation });
  return image[format]().toBuffer();
}

function respuesta(body, { status = 200, type = 'image/jpeg', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...headers } });
}

// fetch simulado: anota cada llamada y responde lo que diga "responder".
function fetchSimulado(responder) {
  const fn = async (url, init) => {
    fn.calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = [];
  return fn;
}

async function medidas(file) {
  const meta = await sharp(file).metadata();
  return { format: meta.format, width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha };
}

function archivos() {
  return fs.existsSync(IG_DIR) ? fs.readdirSync(IG_DIR).sort() : [];
}

// Los logs del módulo y del limitador se juntan acá: no ensucian la salida
// y sirven para comprobar que el link firmado no aparece.
const logs = [];
const consoleOriginal = { log: console.log, error: console.error };
before(() => {
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
});
after(() => {
  console.log = consoleOriginal.log;
  console.error = consoleOriginal.error;
  fs.rmSync(MEDIA, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(IG_DIR, { recursive: true, force: true });
  logs.length = 0;
  delete process.env.POST_IMAGES;
});

// --------------------------------------------------------------------------
describe('postImages: dos copias JPEG de una sola descarga', () => {
  const casos = [
    { nombre: 'portada de un reel (9:16)', w: 1080, h: 1920, thumb: [360, 640], full: [506, 900] },
    { nombre: 'imagen 4:5', w: 1080, h: 1350, thumb: [360, 450], full: [720, 900] },
    { nombre: 'imagen cuadrada', w: 1080, h: 1080, thumb: [360, 360], full: [900, 900] },
    { nombre: 'imagen horizontal (1,91:1)', w: 1080, h: 566, thumb: [360, 189], full: [900, 472] },
    { nombre: 'imagen chica: no se agranda', w: 200, h: 200, thumb: [200, 200], full: [200, 200] },
  ];

  for (const caso of casos) {
    test(caso.nombre, async () => {
      const original = await makeImage(caso.w, caso.h);
      const fetchFn = fetchSimulado(() => respuesta(original));
      const result = await postImages.savePostImage({ plataforma: 'instagram', id: '3988633620029857812', url: link() }, { fetchFn });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'ok');
      assert.equal(result.sourceUrl, link());
      assert.deepEqual([result.width, result.height], [caso.w, caso.h], 'medidas de la original');
      assert.ok(!Number.isNaN(Date.parse(result.savedAt)));

      // Una sola descarga, sin seguir redirecciones.
      assert.equal(fetchFn.calls.length, 1);
      assert.equal(fetchFn.calls[0].init.redirect, 'manual');

      assert.deepEqual(archivos(), ['3988633620029857812_full.jpg', '3988633620029857812_thumb.jpg']);
      const thumb = await medidas(path.join(IG_DIR, '3988633620029857812_thumb.jpg'));
      const full = await medidas(path.join(IG_DIR, '3988633620029857812_full.jpg'));
      assert.deepEqual([thumb.format, thumb.width, thumb.height], ['jpeg', ...caso.thumb]);
      assert.deepEqual([full.format, full.width, full.height], ['jpeg', ...caso.full]);
    });
  }

  test('PNG con transparencia y WebP salen como JPEG', async () => {
    const png = await makeImage(1080, 1080, { format: 'png', alpha: true });
    const webp = await makeImage(1080, 1350, { format: 'webp' });
    const a = await postImages.savePostImage({ plataforma: 'instagram', id: 'png1', url: link() }, { fetchFn: fetchSimulado(() => respuesta(png, { type: 'image/png' })) });
    const b = await postImages.savePostImage({ plataforma: 'instagram', id: 'webp1', url: link() }, { fetchFn: fetchSimulado(() => respuesta(webp, { type: 'image/webp' })) });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    for (const id of ['png1', 'webp1']) {
      for (const size of ['thumb', 'full']) {
        const m = await medidas(path.join(IG_DIR, `${id}_${size}.jpg`));
        assert.equal(m.format, 'jpeg');
        assert.equal(m.hasAlpha, false);
      }
    }
  });

  test('respeta la orientación de la foto (EXIF)', async () => {
    // Guardada "acostada" (1080 × 1920 con orientación 6): se ve de 1920 × 1080.
    const original = await makeImage(1080, 1920, { orientation: 6 });
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'exif1', url: link() }, { fetchFn: fetchSimulado(() => respuesta(original)) });
    assert.equal(result.ok, true);
    assert.deepEqual([result.width, result.height], [1920, 1080]);
    const full = await medidas(path.join(IG_DIR, 'exif1_full.jpg'));
    assert.deepEqual([full.width, full.height], [900, 506]);
    const thumb = await medidas(path.join(IG_DIR, 'exif1_thumb.jpg'));
    assert.equal(thumb.width, 360);
    assert.ok(thumb.height >= 202 && thumb.height <= 203);
  });

  test('dónde van los archivos', () => {
    assert.equal(postImages.imagePath('instagram', '123', 'thumb'), path.join(IG_DIR, '123_thumb.jpg'));
    assert.equal(postImages.imagePath('instagram', '123', 'full'), path.join(IG_DIR, '123_full.jpg'));
    assert.equal(postImages.imagePath('instagram', '123', 'original'), null, 'tamaño fuera de la lista');
    assert.equal(postImages.imagePath('instagram', '../123', 'thumb'), null, 'id que no sirve como nombre');
    assert.equal(postImages.imagePath('x', '123', 'thumb'), null, 'plataforma sin imágenes');
    assert.equal(postImages.hasLocalCopy('instagram', '123'), false);
  });
});

// --------------------------------------------------------------------------
describe('postImages: reglas de la descarga', () => {
  test('links que no se piden: ni https, ni host de Instagram, ni parecidos', async () => {
    const original = await makeImage(400, 400);
    const rechazados = [
      'http://scontent.cdninstagram.com/foto.jpg',
      'https://ejemplo.com/foto.jpg',
      'https://malcdninstagram.com/foto.jpg',
      'https://cdninstagram.com.ejemplo.com/foto.jpg',
      'https://fbcdn.net.ejemplo.com/foto.jpg',
      'https://usuario:clave@scontent.cdninstagram.com/foto.jpg',
      'https://scontent.cdninstagram.com:8443/foto.jpg',
      'https://127.0.0.1/foto.jpg',
      'https://localhost/foto.jpg',
      'file:///C:/Windows/win.ini',
      'no es un link',
      '',
      null,
      undefined,
    ];
    for (const url of rechazados) {
      const fetchFn = fetchSimulado(() => respuesta(original));
      const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'r1', url }, { fetchFn });
      assert.equal(result.ok, false, String(url));
      assert.equal(result.status, 'error', String(url));
      assert.equal(result.network, false, String(url));
      assert.equal(fetchFn.calls.length, 0, `no se pide: ${url}`);
    }
    assert.deepEqual(archivos(), []);
  });

  test('hosts permitidos: subdominios de cdninstagram.com y de fbcdn.net', async () => {
    const original = await makeImage(400, 400);
    const hosts = ['scontent-eze1-1.cdninstagram.com', 'instagram.feze8-1.fna.fbcdn.net', 'scontent.xx.fbcdn.net', 'cdninstagram.com'];
    for (const [i, host] of hosts.entries()) {
      const result = await postImages.savePostImage({ plataforma: 'instagram', id: `h${i}`, url: link(host) }, { fetchFn: fetchSimulado(() => respuesta(original)) });
      assert.equal(result.ok, true, host);
    }
  });

  test('plataforma sin lista de hosts: no baja nada (no hay default)', async () => {
    const original = await makeImage(400, 400);
    for (const plataforma of ['x', 'tiktok', '', undefined]) {
      const fetchFn = fetchSimulado(() => respuesta(original));
      const result = await postImages.savePostImage({ plataforma, id: 'p1', url: link() }, { fetchFn });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'plataforma-sin-imagenes');
      assert.equal(fetchFn.calls.length, 0);
    }
    assert.deepEqual(fs.readdirSync(MEDIA), [], 'no se creó ninguna carpeta');
  });

  test('id que no sirve como nombre de archivo: no baja ni escribe afuera', async () => {
    const original = await makeImage(400, 400);
    for (const id of ['../afuera', 'a/b', 'a\\b', 'con espacio', '', 12345, null]) {
      const fetchFn = fetchSimulado(() => respuesta(original));
      const result = await postImages.savePostImage({ plataforma: 'instagram', id, url: link() }, { fetchFn });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'id-invalido');
      assert.equal(fetchFn.calls.length, 0);
    }
    assert.deepEqual(archivos(), []);
    assert.deepEqual(fs.readdirSync(MEDIA).filter((n) => n !== 'instagram'), []);
  });

  test('una redirección no se sigue', async () => {
    const fetchFn = fetchSimulado(() => new Response(null, { status: 302, headers: { location: 'https://ejemplo.com/otra.jpg' } }));
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'red1', url: link() }, { fetchFn });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'redireccion');
    assert.equal(fetchFn.calls.length, 1, 'un solo pedido: no fue a buscar la otra dirección');
    assert.deepEqual(archivos(), []);
  });

  test('403, 404 y 410 son "vencido"; otro estado es "error"', async () => {
    for (const status of [403, 404, 410]) {
      const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'v1', url: link() }, { fetchFn: fetchSimulado(() => respuesta('URL signature expired', { status, type: 'text/plain' })) });
      assert.deepEqual([result.ok, result.status, result.reason, result.network], [false, 'vencido', `http-${status}`, false]);
      assert.equal(result.sourceUrl, link(), 'el link del intento vuelve para anotarlo');
    }
    const caido = await postImages.savePostImage({ plataforma: 'instagram', id: 'v1', url: link() }, { fetchFn: fetchSimulado(() => respuesta('error', { status: 500, type: 'text/plain' })) });
    assert.deepEqual([caido.status, caido.reason], ['error', 'http-500']);
    assert.deepEqual(archivos(), []);
  });

  test('solo image/*', async () => {
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 't1', url: link() }, { fetchFn: fetchSimulado(() => respuesta('<html>login</html>', { type: 'text/html' })) });
    assert.deepEqual([result.ok, result.status, result.reason], [false, 'error', 'no-es-imagen']);
    assert.deepEqual(archivos(), []);
  });

  test('tope de tamaño: por lo que declara la respuesta y por lo que realmente llega', async () => {
    const original = await makeImage(600, 600);
    assert.ok(original.length > 500);
    // Declarado en content-length.
    const declarado = await postImages.savePostImage(
      { plataforma: 'instagram', id: 'g1', url: link() },
      { fetchFn: fetchSimulado(() => respuesta(original, { headers: { 'content-length': String(original.length) } })), maxBytes: 500 }
    );
    assert.deepEqual([declarado.status, declarado.reason, declarado.network], ['error', 'demasiado-grande', false]);
    // Sin content-length: se corta al pasar el tope mientras baja.
    const enPartes = () =>
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(200));
          controller.close();
        },
      });
    const sinDeclarar = await postImages.savePostImage({ plataforma: 'instagram', id: 'g2', url: link() }, { fetchFn: fetchSimulado(() => respuesta(enPartes())), maxBytes: 500 });
    assert.deepEqual([sinDeclarar.status, sinDeclarar.reason], ['error', 'demasiado-grande']);
    assert.deepEqual(archivos(), []);
  });

  test('tope de tiempo: se corta el pedido y cuenta como fallo de red', async () => {
    let abortado = false;
    const fetchFn = fetchSimulado(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            abortado = true;
            reject(new Error('This operation was aborted'));
          });
        })
    );
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'lento', url: link() }, { fetchFn, timeoutMs: 40 });
    assert.deepEqual([result.ok, result.status, result.reason, result.network], [false, 'error', 'tiempo-agotado', true]);
    assert.equal(abortado, true);
  });

  test('la red no llega: fallo de red', async () => {
    const fetchFn = fetchSimulado(() => {
      throw new TypeError('fetch failed');
    });
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'red2', url: link() }, { fetchFn });
    assert.deepEqual([result.ok, result.status, result.reason, result.network], [false, 'error', 'fallo-de-red', true]);
  });

  test('bytes que no son una imagen, y respuesta vacía', async () => {
    const rota = await postImages.savePostImage({ plataforma: 'instagram', id: 'rota', url: link() }, { fetchFn: fetchSimulado(() => respuesta(Buffer.from('esto no es una imagen'))) });
    assert.deepEqual([rota.status, rota.reason, rota.network], ['error', 'imagen-ilegible', false]);
    const vacia = await postImages.savePostImage({ plataforma: 'instagram', id: 'vacia', url: link() }, { fetchFn: fetchSimulado(() => respuesta(Buffer.alloc(0))) });
    assert.deepEqual([vacia.status, vacia.reason], ['error', 'respuesta-vacia']);
    assert.deepEqual(archivos(), []);
  });

  test('el link firmado nunca va a los logs; el host sí', async () => {
    await postImages.savePostImage({ plataforma: 'instagram', id: 'log1', url: link() }, { fetchFn: fetchSimulado(() => respuesta('x', { status: 500, type: 'text/plain' })) });
    await postImages.savePostImage({ plataforma: 'instagram', id: 'log2', url: `https://ejemplo.com/foto.jpg?${FIRMA}` }, { fetchFn: fetchSimulado(() => respuesta('x')) });
    const texto = logs.join('\n');
    assert.ok(texto.includes('log1') && texto.includes('scontent-eze1-1.cdninstagram.com'), 'el log dice qué posteo y qué host');
    assert.ok(texto.includes('ejemplo.com'), 'el host rechazado queda en el log');
    assert.ok(!texto.includes('FIRMA_SECRETA') && !texto.includes('foto.jpg'), 'ni la firma ni la ruta del link');
  });
});

// --------------------------------------------------------------------------
describe('postImages: un fallo no rompe nada', () => {
  test('un intento fallido no toca las copias que ya estaban, ni deja temporales', async () => {
    const original = await makeImage(1080, 1350);
    const post = { plataforma: 'instagram', id: 'copia1', url: link() };
    assert.equal((await postImages.savePostImage(post, { fetchFn: fetchSimulado(() => respuesta(original)) })).ok, true);
    assert.equal(postImages.hasLocalCopy('instagram', 'copia1'), true);
    const leer = () => ['thumb', 'full'].map((size) => fs.readFileSync(path.join(IG_DIR, `copia1_${size}.jpg`)));
    const antes = leer();

    const fallos = [
      () => respuesta('x', { status: 404, type: 'text/plain' }),
      () => respuesta('x', { status: 500, type: 'text/plain' }),
      () => respuesta(Buffer.from('bytes rotos')),
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const responder of fallos) {
      const result = await postImages.savePostImage(post, { fetchFn: fetchSimulado(responder) });
      assert.equal(result.ok, false);
      const despues = leer();
      assert.ok(antes[0].equals(despues[0]) && antes[1].equals(despues[1]), 'las dos copias quedan iguales');
    }
    assert.deepEqual(archivos(), ['copia1_full.jpg', 'copia1_thumb.jpg'], 'sin archivos temporales');
  });

  test('nunca tira: ni sin argumentos, ni con un fetch que explota', async () => {
    const sinNada = await postImages.savePostImage();
    assert.equal(sinNada.ok, false);
    const fetchRoto = () => {
      throw new Error('explota antes de devolver una promesa');
    };
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'boom', url: link() }, { fetchFn: fetchRoto });
    assert.deepEqual([result.ok, result.status, result.network], [false, 'error', true]);
  });

  test('POST_IMAGES=0: no baja nada y no hay nada que anotar', async () => {
    const original = await makeImage(400, 400);
    process.env.POST_IMAGES = '0';
    assert.equal(postImages.isEnabled(), false);
    const fetchFn = fetchSimulado(() => respuesta(original));
    const result = await postImages.savePostImage({ plataforma: 'instagram', id: 'apagado', url: link() }, { fetchFn });
    assert.deepEqual(result, { ok: false, skipped: true, reason: 'apagado' });
    assert.equal(fetchFn.calls.length, 0);
    delete process.env.POST_IMAGES;
    assert.equal(postImages.isEnabled(), true);
  });

  test('sin sharp: el módulo carga igual y las fotos quedan apagadas', () => {
    // En un proceso aparte, con sharp "desinstalado".
    const script = `
      const Module = require('module');
      const load = Module._load;
      Module._load = function (request, ...rest) {
        if (request === 'sharp') throw new Error('Cannot find module sharp (simulado)');
        return load.call(this, request, ...rest);
      };
      console.error = () => {};
      const postImages = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'postImages.js'))});
      postImages.savePostImage({ plataforma: 'instagram', id: 'a1', url: 'https://scontent.cdninstagram.com/f.jpg' }, { fetchFn: () => { throw new Error('no debería pedirse'); } })
        .then((result) => console.log('__OUT__' + JSON.stringify({ enabled: postImages.isEnabled(), result })));
    `;
    const stdout = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, MONITORING_MEDIA_DIR: MEDIA }, encoding: 'utf8' });
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('__OUT__'));
    assert.ok(line, 'el proceso hijo no devolvió nada');
    assert.deepEqual(JSON.parse(line.slice('__OUT__'.length)), { enabled: false, result: { ok: false, skipped: true, reason: 'sin-sharp' } });
  });
});

// --------------------------------------------------------------------------
describe('postImages: la tanda', () => {
  const posts = (n) => Array.from({ length: n }, (_, i) => ({ plataforma: 'instagram', id: `t${i}`, url: link() }));

  test('pocas a la vez, todas guardadas y en el mismo orden', async () => {
    const original = await makeImage(600, 600);
    let enVuelo = 0;
    let maximo = 0;
    const fetchFn = fetchSimulado(async () => {
      enVuelo += 1;
      maximo = Math.max(maximo, enVuelo);
      await new Promise((resolve) => setTimeout(resolve, 15));
      enVuelo -= 1;
      return respuesta(original);
    });
    const results = await postImages.savePostImages(posts(8), { fetchFn });
    assert.equal(results.length, 8);
    assert.ok(results.every((r) => r.ok && r.status === 'ok'));
    assert.ok(maximo <= postImages.imageLimiter.limit, `en vuelo a la vez: ${maximo}`);
    assert.equal(postImages.imageLimiter.limit, 3);
    assert.equal(archivos().length, 16);
    assert.equal(postImages.imageLimiter.inFlight(), 0);
  });

  test('cinco fallos de red seguidos cortan la tanda', async () => {
    const fetchFn = fetchSimulado(() => {
      throw new TypeError('fetch failed');
    });
    const results = await postImages.savePostImages(posts(12), { fetchFn });
    assert.equal(results.length, 12);
    const intentados = results.filter((r) => !r.skipped);
    const salteados = results.filter((r) => r.skipped);
    assert.ok(intentados.every((r) => r.network && r.status === 'error'));
    // Corta al quinto; a lo sumo terminan los que ya estaban en vuelo.
    assert.ok(intentados.length >= postImages.MAX_NETWORK_FAILURES && intentados.length <= postImages.MAX_NETWORK_FAILURES + 2, `intentados: ${intentados.length}`);
    assert.equal(fetchFn.calls.length, intentados.length);
    assert.ok(salteados.length >= 5 && salteados.every((r) => r.reason === 'corte-por-red'));
    assert.ok(logs.some((l) => l.includes('se corta la tanda')));
  });

  test('un link vencido no es un fallo de red: no corta', async () => {
    const fetchFn = fetchSimulado(() => respuesta('x', { status: 404, type: 'text/plain' }));
    const results = await postImages.savePostImages(posts(9), { fetchFn });
    assert.equal(fetchFn.calls.length, 9);
    assert.ok(results.every((r) => r.status === 'vencido' && !r.skipped));
  });

  test('una descarga que sale bien corta la racha de fallos', async () => {
    const original = await makeImage(300, 300);
    // Falla, falla, anda; así nueve veces: nunca hay cinco fallos seguidos.
    let n = 0;
    const fetchFn = fetchSimulado(() => {
      n += 1;
      if (n % 3 === 0) return respuesta(original);
      throw new TypeError('fetch failed');
    });
    const results = await postImages.savePostImages(posts(27), { fetchFn });
    assert.equal(fetchFn.calls.length, 27);
    assert.ok(results.every((r) => !r.skipped));
    assert.equal(results.filter((r) => r.ok).length, 9);
  });

  test('sin posteos, o con algo que no es una lista: nada', async () => {
    assert.deepEqual(await postImages.savePostImages([]), []);
    assert.deepEqual(await postImages.savePostImages(null), []);
  });
});
