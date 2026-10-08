'use strict';

// Fotos, paso 5 (openspec/changes/monitoreo-fotos, REQ-FOTO-05): las fotos
// dentro del ciclo de monitoreo. Al guardar un posteo nuevo y en el refresco
// por URL se baja la foto con el link que YA vino en la respuesta: ningún
// pedido extra al adapter, nada si la respuesta no trae imagen, nada si el
// posteo ya tiene sus copias, y un fallo no frena el ciclo. POST_IMAGES=0 lo
// apaga. Logs callados: una línea de resumen por ciclo y detalle solo si
// algo falla.
//
// Los adapters están stubeados (nada llama a Apify) y global.fetch es un
// simulador que solo atiende links de imagen: nada sale a Instagram. Las
// imágenes se generan en memoria. Base, config y carpeta de fotos temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
delete process.env.REFRESH_MODE; // vacío = url
delete process.env.POST_IMAGES;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fotos-ciclo-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.MONITORING_MEDIA_DIR = MEDIA;
fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: ['obras'], searches: ['obras'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');

// Clasificador stubeado ANTES de cargar monitor.js: relevante salvo que el
// texto diga "ajeno".
const classifier = require('../src/classifier');
classifier.clasificarPosteo = async (caption) =>
  String(caption).includes('ajeno') ? { relevant: false } : { relevant: true, title: 'título', sentiment: 'neutral' };

const db = require('../src/db');
const monitor = require('../src/monitor');
const metricsRefresh = require('../src/metricsRefresh');
const scheduler = require('../src/scheduler');
const postImages = require('../src/postImages');
const postImageSync = require('../src/postImageSync');
const progress = require('../src/monitoringProgress');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const raw = new DatabaseSync(DB_PATH);

const IG_DIR = path.join(MEDIA, 'instagram');
const HOUR_MS = 60 * 60 * 1000;
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const urlOf = (code) => `https://www.instagram.com/p/${code}/`;
// Links como los de Instagram, uno por posteo, con una firma que no tiene
// que aparecer en los logs.
const linkDetalle = (code) => `https://scontent-eze1-1.cdninstagram.com/v/t51/${code}_grande.jpg?oh=FIRMA_SECRETA`;
const linkBusqueda = (code) => `https://scontent-eze1-1.cdninstagram.com/v/t51/${code}_chica.jpg?oh=FIRMA_SECRETA`;

// --------------------------------------------------------------------------
// Adapter de Instagram stubeado: cuenta cada llamada.
// --------------------------------------------------------------------------
const adapterCalls = { scrapeSearch: 0, fetchPostDetails: [], scrapeAccount: 0 };
let searchResults = [];
let detailsResponder = async () => [];
instagram.isConfigured = () => true;
instagram.scrapeSearch = async () => {
  adapterCalls.scrapeSearch += 1;
  return searchResults;
};
instagram.fetchPostDetails = async (urls) => {
  adapterCalls.fetchPostDetails.push([...urls]);
  return detailsResponder(urls);
};
instagram.scrapeAccount = async () => {
  adapterCalls.scrapeAccount += 1;
  return [];
};
instagram.scrapeHashtag = async () => [];
instagram.fetchAccountFollowers = async () => null;

/** Resultado de búsqueda recortado (sin caption), ya normalizado. */
function resultado(code, { imageUrl = linkBusqueda(code) } = {}) {
  return { id: code, account: 'cuenta', url: urlOf(code), caption: '', hashtagsText: '', likes: null, comments: null, postedAt: agoIso(HOUR_MS), postType: 'reel', followers: null, imageUrl, sourceType: 'search', sourceQuery: 'obras' };
}

/** Detalle normalizado, como lo devuelve fetchPostDetails. */
function detalle(code, { caption = 'obras en la ciudad', imageUrl = linkDetalle(code), likes = 10, comments = 3 } = {}) {
  return { id: code, account: 'cuenta', url: urlOf(code), caption, hashtagsText: '', likes, comments, postedAt: null, postType: 'reel', followers: null, imageUrl, sourceType: 'search', sourceQuery: null };
}

// --------------------------------------------------------------------------
// Red simulada: solo links de imagen. Cualquier otro pedido hace fallar el test.
// --------------------------------------------------------------------------
let IMAGEN; // JPEG generado
const fetchCalls = [];
let imageResponder = () => new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const originalFetch = global.fetch;
global.fetch = async (url, init) => {
  const href = String(url);
  if (!new URL(href).hostname.endsWith('.cdninstagram.com')) throw new Error(`pedido de red inesperado en el test: ${new URL(href).hostname}`);
  fetchCalls.push(href);
  return imageResponder(href, init);
};

// Los logs se juntan acá.
const logs = [];
const consoleOriginal = { log: console.log, error: console.error, warn: console.warn };
before(async () => {
  IMAGEN = await sharp({ create: { width: 600, height: 750, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
});
after(() => {
  Object.assign(console, consoleOriginal);
  global.fetch = originalFetch;
});

function reset() {
  raw.prepare('DELETE FROM detected_posts').run();
  raw.prepare('DELETE FROM refresh_state').run();
  raw.prepare('DELETE FROM search_seen').run();
  fs.rmSync(MEDIA, { recursive: true, force: true });
  adapterCalls.scrapeSearch = 0;
  adapterCalls.fetchPostDetails = [];
  adapterCalls.scrapeAccount = 0;
  searchResults = [];
  detailsResponder = async () => [];
  imageResponder = () => new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  fetchCalls.length = 0;
  logs.length = 0;
  delete process.env.POST_IMAGES;
  postImageSync.takeCycleSummary();
}

const estado = (code) => ({ ...db.getPostImage(code, 'instagram') });
const archivos = () => (fs.existsSync(IG_DIR) ? fs.readdirSync(IG_DIR).sort() : []);
const SIN_FOTO = { sourceUrl: null, status: null, savedAt: null, width: null, height: null };
const detectar = () => monitor.runMonitoringCycle({ plataformas: ['instagram'] });
const refrescar = () => metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });

/** Posteo ya guardado y vencido para el refresco (tramo caliente, detectado hace 13 h, nunca refrescado). */
function sembrar(code, account = 'cuenta') {
  assert.equal(
    db.saveDetectedPost({ id: code, account, url: urlOf(code), caption: 'obras', matchedReason: 'test', likes: 5, comments: 1, postedAt: agoIso(20 * HOUR_MS), title: 't', sentiment: 'neutral', postType: 'reel', followers: null, plataforma: 'instagram' }),
    true
  );
  raw.prepare('UPDATE detected_posts SET detected_at = ?, metrics_updated_at = NULL WHERE id = ?').run(agoIso(13 * HOUR_MS), code);
}
/** Vuelve a dejar vencido un posteo ya refrescado. */
const vencer = (code) => raw.prepare('UPDATE detected_posts SET metrics_updated_at = ? WHERE id = ?').run(agoIso(13 * HOUR_MS), code);

// --------------------------------------------------------------------------
describe('fotos en la detección: posteos nuevos', { concurrency: false }, () => {
  beforeEach(reset);

  test('un posteo nuevo guarda su foto con el link del detalle, sin pedidos extra al adapter', async () => {
    searchResults = [resultado('NUEVO1'), resultado('NUEVO2')];
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));

    const result = await detectar();
    assert.equal(result.porPlataforma.instagram.newCount, 2);

    // El adapter se usó lo mismo que antes de las fotos: una búsqueda y un detalle.
    assert.equal(adapterCalls.scrapeSearch, 1);
    assert.equal(adapterCalls.fetchPostDetails.length, 1);
    assert.equal(adapterCalls.scrapeAccount, 0);

    // Una descarga por posteo, con el link del detalle (la imagen entera), no el de la búsqueda.
    assert.deepEqual([...fetchCalls].sort(), [linkDetalle('NUEVO1'), linkDetalle('NUEVO2')].sort());
    assert.deepEqual(archivos(), ['NUEVO1_full.jpg', 'NUEVO1_thumb.jpg', 'NUEVO2_full.jpg', 'NUEVO2_thumb.jpg']);
    for (const code of ['NUEVO1', 'NUEVO2']) {
      const image = estado(code);
      assert.equal(image.status, 'ok');
      assert.equal(image.sourceUrl, linkDetalle(code));
      assert.deepEqual([image.width, image.height], [600, 750]);
      assert.ok(!Number.isNaN(Date.parse(image.savedAt)));
    }
  });

  test('si el detalle no trae imagen se usa la del resultado de búsqueda; si ninguno la trae, el posteo queda sin foto y no se pide nada', async () => {
    searchResults = [resultado('SOLOBUSQ'), resultado('SINIMG', { imageUrl: null })];
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', ''), { imageUrl: null }));

    const result = await detectar();
    assert.equal(result.porPlataforma.instagram.newCount, 2);
    assert.deepEqual(fetchCalls, [linkBusqueda('SOLOBUSQ')]);
    assert.equal(estado('SOLOBUSQ').status, 'ok');
    assert.deepEqual(estado('SINIMG'), SIN_FOTO);
    assert.deepEqual(archivos(), ['SOLOBUSQ_full.jpg', 'SOLOBUSQ_thumb.jpg']);
    assert.equal(adapterCalls.fetchPostDetails.length, 1, 'ningún pedido extra para conseguir la imagen');
  });

  test('una foto que falla no frena el ciclo: los posteos se guardan igual y queda anotado cómo salió', async () => {
    searchResults = [resultado('CAIDA'), resultado('VENCIDA'), resultado('SINRED'), resultado('NOIMG'), resultado('BIEN')];
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    imageResponder = (href) => {
      if (href.includes('CAIDA')) return new Response('error', { status: 500, headers: { 'content-type': 'text/plain' } });
      if (href.includes('VENCIDA')) return new Response('expired', { status: 403, headers: { 'content-type': 'text/plain' } });
      if (href.includes('SINRED')) throw new TypeError('fetch failed');
      if (href.includes('NOIMG')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const result = await detectar();
    assert.equal(result.porPlataforma.instagram.newCount, 5, 'los cinco posteos quedaron guardados');
    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 50, plataforma: 'instagram' }).total, 5);

    // Lo pasajero (el servidor de imágenes con un error suyo, la red) queda
    // pendiente para el ciclo siguiente; lo que es del link o de la imagen, no.
    assert.deepEqual([estado('CAIDA').status, estado('CAIDA').savedAt], ['pendiente', null]);
    assert.deepEqual([estado('SINRED').status, estado('SINRED').savedAt], ['pendiente', null]);
    assert.deepEqual([estado('VENCIDA').status, estado('VENCIDA').savedAt], ['vencido', null]);
    assert.deepEqual([estado('NOIMG').status, estado('NOIMG').savedAt], ['error', null]);
    assert.equal(estado('BIEN').status, 'ok');
    for (const code of ['CAIDA', 'SINRED', 'VENCIDA', 'NOIMG']) assert.equal(estado(code).sourceUrl, linkDetalle(code), 'el link del intento queda guardado');
    assert.deepEqual(archivos(), ['BIEN_full.jpg', 'BIEN_thumb.jpg']);
    assert.equal(
      postImageSync.formatCycleSummary(postImageSync.takeCycleSummary()),
      '[imagenes] fotos del ciclo: 1 guardada(s), 0 ya estaban, 1 con el link vencido, 1 con error, 2 pendiente(s) para el próximo ciclo.'
    );
  });

  test('un posteo ya conocido no baja nada en la detección, tenga o no su foto', async () => {
    searchResults = [resultado('CONOCIDO')];
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    // Una respuesta que no es imagen: con ese link no hay nada que reintentar.
    imageResponder = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await detectar();
    assert.equal(estado('CONOCIDO').status, 'error');
    assert.equal(fetchCalls.length, 1);

    // Segundo ciclo: la búsqueda lo vuelve a traer, con su link. Ya está guardado.
    imageResponder = () => new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    const segundo = await detectar();
    assert.equal(segundo.porPlataforma.instagram.newCount, 0);
    assert.equal(fetchCalls.length, 1, 'ninguna descarga nueva');
    assert.equal(estado('CONOCIDO').status, 'error', 'sigue como estaba: lo completa el refresco por URL');
    assert.deepEqual(archivos(), []);
  });

  test('un posteo que el clasificador descarta no se guarda ni baja su foto', async () => {
    searchResults = [resultado('AJENO1')];
    detailsResponder = async () => [detalle('AJENO1', { caption: 'tema ajeno' })];
    const result = await detectar();
    assert.equal(result.porPlataforma.instagram.newCount, 0);
    assert.equal(fetchCalls.length, 0);
    assert.equal(db.getPostImage('AJENO1', 'instagram'), null);
  });

  test('POST_IMAGES=0: el posteo se guarda igual, sin descargas, sin archivos y sin nada anotado', async () => {
    process.env.POST_IMAGES = '0';
    searchResults = [resultado('APAGADO1')];
    detailsResponder = async () => [detalle('APAGADO1')];
    progress.startCycle();
    const result = await detectar();
    const fases = logs.filter((l) => l.startsWith('[fase] arranca'));
    progress.endCycle();

    assert.equal(result.porPlataforma.instagram.newCount, 1);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(archivos(), []);
    assert.deepEqual(estado('APAGADO1'), SIN_FOTO);
    assert.ok(!fases.some((l) => l.includes(postImageSync.PHASE_LABEL)), 'la fase de fotos no se anuncia');
    assert.equal(postImageSync.formatCycleSummary(postImageSync.takeCycleSummary()), null, 'sin línea de resumen');
  });
});

// --------------------------------------------------------------------------
describe('fotos en el refresco por URL: completa los posteos ya guardados', { concurrency: false }, () => {
  beforeEach(reset);

  test('posteos guardados sin foto la reciben con el link de la misma respuesta del refresco', async () => {
    for (const code of ['VIEJO1', 'VIEJO2', 'VIEJO3']) sembrar(code);
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', ''), { likes: 99, comments: 9 }));

    const result = await refrescar();
    assert.equal(result.postsAnswered, 3);
    assert.equal(adapterCalls.fetchPostDetails.length, 1, 'un solo run del refresco, como antes de las fotos');
    assert.equal(fetchCalls.length, 3);
    for (const code of ['VIEJO1', 'VIEJO2', 'VIEJO3']) {
      assert.equal(estado(code).status, 'ok');
      assert.equal(raw.prepare('SELECT likes FROM detected_posts WHERE id = ?').get(code).likes, 99, 'las métricas se refrescaron igual');
    }
    assert.equal(archivos().length, 6);
  });

  test('con las copias guardadas no se vuelve a bajar; si se perdió la carpeta, sí', async () => {
    sembrar('CONFOTO');
    detailsResponder = async () => [detalle('CONFOTO')];
    await refrescar();
    assert.equal(fetchCalls.length, 1);
    const guardadaEn = estado('CONFOTO').savedAt;
    const bytes = fs.readFileSync(path.join(IG_DIR, 'CONFOTO_thumb.jpg'));

    // Otro refresco, con un link nuevo (cambian en cada respuesta): no se baja.
    vencer('CONFOTO');
    detailsResponder = async () => [detalle('CONFOTO', { imageUrl: `${linkDetalle('CONFOTO')}&otra=firma` })];
    await refrescar();
    assert.equal(adapterCalls.fetchPostDetails.length, 2);
    assert.equal(fetchCalls.length, 1, 'ninguna descarga nueva');
    assert.equal(estado('CONFOTO').savedAt, guardadaEn);
    assert.equal(estado('CONFOTO').sourceUrl, linkDetalle('CONFOTO'), 'el link guardado es el de las copias');
    assert.ok(bytes.equals(fs.readFileSync(path.join(IG_DIR, 'CONFOTO_thumb.jpg'))));

    // Se restauró la base sin la carpeta de fotos: la base dice que hay copia, el disco no.
    fs.rmSync(MEDIA, { recursive: true, force: true });
    vencer('CONFOTO');
    await refrescar();
    assert.equal(fetchCalls.length, 2, 'se baja de nuevo');
    assert.deepEqual(archivos(), ['CONFOTO_full.jpg', 'CONFOTO_thumb.jpg']);
  });

  test('link vencido: queda anotado sin foto y el refresco siguiente la consigue', async () => {
    sembrar('TARDE');
    detailsResponder = async () => [detalle('TARDE')];
    imageResponder = () => new Response('expired', { status: 404, headers: { 'content-type': 'text/plain' } });
    const result = await refrescar();
    assert.equal(result.postsAnswered, 1, 'el refresco de métricas no se ve afectado');
    assert.deepEqual([estado('TARDE').status, estado('TARDE').savedAt], ['vencido', null]);

    vencer('TARDE');
    imageResponder = () => new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    await refrescar();
    assert.equal(estado('TARDE').status, 'ok');
    assert.ok(estado('TARDE').savedAt);
  });

  test('sin imagen en la respuesta, posteo que no volvió y posteo ignorado: nada', async () => {
    sembrar('SINLINK');
    sembrar('NOVOLVIO');
    sembrar('IGNORADO');
    db.ignorePost('IGNORADO', 'instagram');
    detailsResponder = async () => [detalle('SINLINK', { imageUrl: null }), detalle('IGNORADO')];
    await refrescar();
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(estado('SINLINK'), SIN_FOTO);
    assert.deepEqual(estado('NOVOLVIO'), SIN_FOTO);
    assert.deepEqual(estado('IGNORADO'), SIN_FOTO);
  });

  test('POST_IMAGES=0: el refresco de métricas sigue andando, sin descargas', async () => {
    process.env.POST_IMAGES = '0';
    sembrar('APAGADO2');
    detailsResponder = async () => [detalle('APAGADO2', { likes: 77, comments: 7 })];
    const result = await refrescar();
    assert.equal(result.postsAnswered, 1);
    assert.equal(raw.prepare('SELECT likes FROM detected_posts WHERE id = ?').get('APAGADO2').likes, 77);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(estado('APAGADO2'), SIN_FOTO);
    assert.deepEqual(archivos(), []);

    // Al volver a prenderlo, el refresco siguiente la baja.
    delete process.env.POST_IMAGES;
    vencer('APAGADO2');
    await refrescar();
    assert.equal(estado('APAGADO2').status, 'ok');
  });
});

// --------------------------------------------------------------------------
describe('fotos en el ciclo: progreso, resumen y logs', { concurrency: false }, () => {
  beforeEach(reset);

  test('una plataforma sin fotos no hace nada; posteos que no están guardados se ignoran', async () => {
    assert.deepEqual(await postImageSync.syncPostImages('x', [{ id: 'x1', url: linkDetalle('x1') }]), { candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, pending: 0 });
    assert.deepEqual(await postImageSync.syncPostImages('instagram', [{ id: 'no-guardado', url: linkDetalle('a') }, null, { id: 'sin-link' }]), { candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, pending: 0 });
    assert.deepEqual(await postImageSync.syncPostImages('instagram', null), { candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, pending: 0 });
    assert.equal(fetchCalls.length, 0);
  });

  test('"Guardando fotos" es una fase más del progreso y termina completa', async () => {
    searchResults = [resultado('PROG1'), resultado('PROG2'), resultado('PROG3')];
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    const vistas = [];
    imageResponder = () => {
      vistas.push(progress.getProgress());
      return new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    progress.startCycle();
    await detectar();
    const alFinal = progress.getProgress();
    progress.endCycle();

    assert.equal(vistas.length, 3);
    assert.ok(vistas.every((p) => p && p.phase === 'Guardando fotos' && p.total === 3));
    assert.deepEqual([alFinal.phase, alFinal.done, alFinal.total], ['Guardando fotos', 3, 3]);
    // La detección ya había terminado (100 %): las fotos no hacen bajar la barra.
    assert.deepEqual(vistas.map((p) => p.percent), [100, 100, 100]);
    assert.equal(alFinal.percent, 100);
    assert.ok(logs.some((l) => l === '[fase] arranca Guardando fotos (total 3)'));
  });

  test('ciclo completo por el scheduler: una sola línea de resumen de fotos, y ni un renglón por foto que sale bien', async () => {
    // En un ciclo real el refresco saltea las cuentas que el benchmark acaba
    // de recalcular: los posteos a refrescar son de otra cuenta, con su
    // benchmark al día.
    db.upsertAccountStats({ account: 'otra', plataforma: 'instagram', postType: null, nPosts: 9, medianLikes: 10, medianComments: 2 });
    sembrar('REFRESCO1', 'otra');
    sembrar('REFRESCO2', 'otra');
    searchResults = [resultado('CICLO1'), resultado('CICLO2')];
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));

    const result = await scheduler.runCycle({ plataforma: 'instagram' });
    assert.equal(result.newCount, 2);
    assert.equal(archivos().length, 8, 'dos nuevos y dos del refresco, dos copias cada uno');

    const deFotos = logs.filter((l) => l.includes('[imagenes]'));
    assert.deepEqual(deFotos, ['[imagenes] fotos del ciclo: 4 guardada(s), 0 ya estaban.']);
    assert.ok(!logs.some((l) => l.includes('[limiter:imagenes]')), 'el limitador de fotos no escribe un renglón por tarea');
    assert.ok(!logs.some((l) => l.includes('FIRMA_SECRETA')), 'el link firmado no va a los logs');
    // El resumen sale después del cierre del ciclo.
    assert.ok(logs.findIndex((l) => l.startsWith('[ciclo] fin')) < logs.indexOf(deFotos[0]));
  });

  test('si algo falla hay detalle: un renglón por foto fallida, con el posteo y el host, y el resumen lo cuenta', async () => {
    sembrar('YAESTA');
    detailsResponder = async () => [detalle('YAESTA')];
    await refrescar();
    postImageSync.takeCycleSummary();
    logs.length = 0;
    fetchCalls.length = 0;

    vencer('YAESTA');
    sembrar('FALLA1');
    sembrar('FALLA2');
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    imageResponder = (href) =>
      href.includes('FALLA1')
        ? new Response('expired', { status: 410, headers: { 'content-type': 'text/plain' } })
        : new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await refrescar();

    const detalleFallos = logs.filter((l) => l.includes('[imagenes]'));
    assert.equal(detalleFallos.length, 2);
    assert.ok(detalleFallos.some((l) => l.includes('FALLA1') && l.includes('http-410') && l.includes('scontent-eze1-1.cdninstagram.com')));
    assert.ok(detalleFallos.some((l) => l.includes('FALLA2') && l.includes('no-es-imagen')));
    assert.ok(!logs.some((l) => l.includes('FIRMA_SECRETA')));
    assert.equal(
      postImageSync.formatCycleSummary(postImageSync.takeCycleSummary()),
      '[imagenes] fotos del ciclo: 0 guardada(s), 1 ya estaban, 1 con el link vencido, 1 con error.'
    );
  });

  test('si la red no llega al servidor de imágenes, la tanda se corta, el ciclo termina y todo queda pendiente con su link', async () => {
    const codes = Array.from({ length: 12 }, (_, i) => `RED${i}`);
    searchResults = codes.map((code) => resultado(code));
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    imageResponder = () => {
      throw new TypeError('fetch failed');
    };
    const result = await detectar();
    assert.equal(result.porPlataforma.instagram.newCount, 12, 'los doce posteos quedaron guardados');
    assert.ok(fetchCalls.length >= postImages.MAX_CONSECUTIVE_FAILURES && fetchCalls.length <= postImages.MAX_CONSECUTIVE_FAILURES + 2, `intentos: ${fetchCalls.length}`);
    // Las que se intentaron y las que no: todas quedan para el ciclo siguiente.
    for (const code of codes) assert.deepEqual([estado(code).status, estado(code).sourceUrl, estado(code).savedAt], ['pendiente', linkDetalle(code), null]);
    const resumen = postImageSync.formatCycleSummary(postImageSync.takeCycleSummary());
    assert.equal(resumen, '[imagenes] fotos del ciclo: 0 guardada(s), 0 ya estaban, 12 pendiente(s) para el próximo ciclo.');
  });

  test('la base se anota foto por foto, no al terminar la tanda', async () => {
    const codes = Array.from({ length: 9 }, (_, i) => `UNA${i}`);
    searchResults = codes.map((code) => resultado(code));
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    // Con cada descarga que arranca, cuántas fotos ya están anotadas en la base.
    const anotadas = [];
    imageResponder = () => {
      anotadas.push(codes.filter((code) => estado(code).status === 'ok').length);
      return new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    await detectar();
    assert.equal(anotadas.length, 9);
    assert.equal(anotadas[0], 0);
    // De a tres a la vez: cuando arranca la última, las primeras ya quedaron
    // marcadas. Si el proceso se cortara ahí, no habría que bajarlas de nuevo.
    assert.ok(anotadas[8] >= 5, `anotadas al arrancar la última: ${anotadas[8]}`);
    assert.ok(codes.every((code) => estado(code).status === 'ok'));
  });

  test('si la base no puede anotar, la tanda se corta a los cinco seguidos y el ciclo termina', async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `BD${i}`);
    searchResults = codes.map((code) => resultado(code));
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    const original = db.markPostImageSaved;
    db.markPostImageSaved = () => {
      throw new Error('database is locked');
    };
    let result;
    try {
      result = await detectar();
    } finally {
      db.markPostImageSaved = original;
    }
    assert.equal(result.porPlataforma.instagram.newCount, 30, 'los posteos quedaron guardados');
    assert.ok(fetchCalls.length >= postImages.MAX_CONSECUTIVE_FAILURES && fetchCalls.length <= 12, `descargas: ${fetchCalls.length}`);
    assert.ok(codes.every((code) => estado(code).savedAt === null), 'ninguna quedó marcada');
    assert.ok(logs.some((l) => l.includes('no se pudo anotar')));
    assert.equal(logs.filter((l) => l.includes('se corta la tanda')).length, 1);
    const stats = postImageSync.takeCycleSummary();
    assert.equal(stats.failed, fetchCalls.length);
    assert.equal(stats.pending, 30 - fetchCalls.length);
  });

  test('la línea de resumen: null si ninguna respuesta trajo link', () => {
    assert.equal(postImageSync.formatCycleSummary({ candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, pending: 0 }), null);
    assert.equal(postImageSync.formatCycleSummary(null), null);
    assert.equal(
      postImageSync.formatCycleSummary({ candidates: 150, alreadySaved: 150, saved: 0, expired: 0, failed: 0, pending: 0 }),
      '[imagenes] fotos del ciclo: 0 guardada(s), 150 ya estaban.'
    );
  });
});

// --------------------------------------------------------------------------
describe('fotos pendientes: se reintentan al empezar el ciclo siguiente, sin pedirle nada al adapter', { concurrency: false }, () => {
  beforeEach(reset);

  const bien = () => new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const reintentar = () => postImageSync.retryPendingPostImages({ plataformas: ['instagram'] });
  /** Posteo guardado hace poco (no le toca refresco) con la foto pendiente. */
  function pendiente(code) {
    sembrar(code);
    raw.prepare('UPDATE detected_posts SET detected_at = ? WHERE id = ?').run(agoIso(HOUR_MS), code);
    assert.equal(db.markPostImagePending(code, 'instagram', { sourceUrl: linkDetalle(code) }), true);
  }

  test('la tanda cortada de un ciclo se completa al empezar el siguiente, con los links ya guardados', async () => {
    const codes = Array.from({ length: 12 }, (_, i) => `SIG${i}`);
    searchResults = codes.map((code) => resultado(code));
    detailsResponder = async (urls) => urls.map((url) => detalle(url.split('/p/')[1].replace('/', '')));
    imageResponder = () => {
      throw new TypeError('fetch failed');
    };
    await scheduler.runCycle({ plataforma: 'instagram' });
    assert.ok(codes.every((code) => estado(code).status === 'pendiente'));
    assert.deepEqual(archivos(), []);

    // Ciclo siguiente: la red volvió y la búsqueda no trae nada nuevo.
    searchResults = [];
    imageResponder = bien;
    adapterCalls.fetchPostDetails = [];
    fetchCalls.length = 0;
    logs.length = 0;
    await scheduler.runCycle({ plataforma: 'instagram' });

    assert.ok(codes.every((code) => estado(code).status === 'ok' && estado(code).savedAt));
    assert.equal(archivos().length, 24);
    assert.deepEqual([...fetchCalls].sort(), codes.map(linkDetalle).sort(), 'una descarga por pendiente, con el link guardado');
    assert.equal(adapterCalls.fetchPostDetails.length, 0, 'ningún pedido de detalle ni de refresco para conseguir el link');

    // Va primero: lo que falle en este ciclo se reintenta recién en el próximo.
    const fases = logs.filter((l) => l.startsWith('[fase] arranca'));
    assert.equal(fases[0], '[fase] arranca Guardando fotos pendientes (total 12)');
    assert.ok(logs.includes('[imagenes] fotos del ciclo: 12 guardada(s), 0 ya estaban.'));
  });

  test('un link vencido o una imagen rechazada no se reintentan con el mismo link', async () => {
    sembrar('VENC');
    sembrar('RECH');
    db.markPostImageFailed('VENC', 'instagram', { sourceUrl: linkDetalle('VENC'), status: 'vencido' });
    db.markPostImageFailed('RECH', 'instagram', { sourceUrl: linkDetalle('RECH'), status: 'error' });
    assert.deepEqual(await reintentar(), { candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, pending: 0 });
    assert.equal(fetchCalls.length, 0);
    assert.equal(postImageSync.formatCycleSummary(postImageSync.takeCycleSummary()), null);
  });

  test('en el reintento los links vencidos no cortan la tanda: quedan "vencido" y dejan de reintentarse', async () => {
    const codes = Array.from({ length: 9 }, (_, i) => `VIEJO${i}`);
    for (const code of codes) pendiente(code);
    imageResponder = () => new Response('URL signature expired', { status: 403, headers: { 'content-type': 'text/plain' } });
    const stats = await reintentar();
    assert.equal(fetchCalls.length, 9, 'se le pregunta por todos');
    assert.deepEqual([stats.expired, stats.pending], [9, 0]);
    assert.ok(codes.every((code) => estado(code).status === 'vencido'));
    assert.ok(!logs.some((l) => l.includes('se corta la tanda')));

    fetchCalls.length = 0;
    await reintentar();
    assert.equal(fetchCalls.length, 0);
  });

  test('si la red sigue sin llegar, la tanda se corta a los cinco y todo sigue pendiente', async () => {
    const codes = Array.from({ length: 12 }, (_, i) => `SINRED${i}`);
    for (const code of codes) pendiente(code);
    imageResponder = () => {
      throw new TypeError('fetch failed');
    };
    const stats = await reintentar();
    assert.ok(fetchCalls.length >= postImages.MAX_CONSECUTIVE_FAILURES && fetchCalls.length <= postImages.MAX_CONSECUTIVE_FAILURES + 2, `intentos: ${fetchCalls.length}`);
    assert.deepEqual([stats.saved, stats.pending], [0, 12]);
    assert.ok(codes.every((code) => estado(code).status === 'pendiente' && estado(code).sourceUrl === linkDetalle(code)));
    assert.equal(logs.filter((l) => l.includes('se corta la tanda')).length, 1);
  });

  test('ignorado, fotos apagadas y otra plataforma: no se reintenta nada', async () => {
    pendiente('IGN');
    db.ignorePost('IGN', 'instagram');
    pendiente('APAG');

    process.env.POST_IMAGES = '0';
    await reintentar();
    assert.equal(fetchCalls.length, 0);
    assert.equal(estado('APAG').status, 'pendiente', 'apagado no toca nada');

    delete process.env.POST_IMAGES;
    await postImageSync.retryPendingPostImages({ plataformas: ['x'] });
    assert.equal(fetchCalls.length, 0, 'el ciclo de otra plataforma no reintenta las de Instagram');

    await reintentar();
    assert.deepEqual(fetchCalls, [linkDetalle('APAG')], 'el ignorado no se baja');
    assert.equal(estado('APAG').status, 'ok');
    assert.equal(estado('IGN').status, 'pendiente');
  });

  test('una pendiente cuyas copias ya están en disco vuelve a quedar al día sin bajar nada', async () => {
    sembrar('ESTABA');
    detailsResponder = async () => [detalle('ESTABA')];
    await refrescar();
    const guardada = estado('ESTABA');
    assert.equal(guardada.status, 'ok');
    db.markPostImagePending('ESTABA', 'instagram', { sourceUrl: `${linkDetalle('ESTABA')}&otro=link` });
    fetchCalls.length = 0;

    const stats = await reintentar();
    assert.equal(fetchCalls.length, 0);
    assert.equal(stats.alreadySaved, 1);
    assert.deepEqual([estado('ESTABA').status, estado('ESTABA').savedAt], ['ok', guardada.savedAt]);
    assert.deepEqual(db.listPostsWithPendingImage('instagram'), []);
  });
});
