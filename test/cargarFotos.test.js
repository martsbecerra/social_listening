'use strict';

// Carga única de fotos (scripts/cargar-fotos.js): el modo que solo informa no
// llama a nada ni escribe nada, y la carga pide por URL los posteos sin foto,
// en lotes y de a uno, baja las fotos con el código de la app, no toca las
// métricas y frena si algo anda mal.
//
// Nada llama a Apify ni a Instagram: el adapter está stubeado y global.fetch
// es un simulador que solo atiende links de imagen. Las imágenes se generan
// en memoria. Base, config y carpeta de fotos temporales. El .env real no se
// carga (main recibe loadEnv).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
for (const key of ['POST_IMAGES', 'APIFY_PLAN', 'APIFY_RATE_FREE', 'APIFY_RATE_STARTER', 'APIFY_RATE_SCALE', 'REFRESH_MODE']) delete process.env[key];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-carga-fotos-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.MONITORING_MEDIA_DIR = MEDIA;
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], searches: [] }, x: { accounts: [], keywords: [] } }) + '\n');

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');

const db = require('../src/db');
const monitor = require('../src/monitor');
const apifyCost = require('../src/apifyCost');
const postImages = require('../src/postImages');
const { getContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const carga = require('../scripts/cargar-fotos');

const instagram = getPlatform('instagram');
const raw = new DatabaseSync(DB_PATH);
const IG_DIR = path.join(MEDIA, 'instagram');
const DAY_MS = 24 * 60 * 60 * 1000;
const urlOf = (code) => `https://www.instagram.com/p/${code}/`;
const link = (code) => `https://scontent-eze1-1.cdninstagram.com/v/t51/${code}.jpg?oh=FIRMA_SECRETA`;
const codeOf = (url) => url.split('/p/')[1].replace('/', '');

// --------------------------------------------------------------------------
// Adapter stubeado: anota cada pedido y en qué contexto llegó.
// --------------------------------------------------------------------------
const pedidos = [];
let responder = async (urls) => urls.map((url) => detalle(codeOf(url)));
instagram.isConfigured = () => true;
instagram.fetchPostDetails = async (urls) => {
  pedidos.push({ urls: [...urls], contexto: getContext() });
  return responder(urls);
};
for (const name of ['scrapeSearch', 'scrapeAccount', 'scrapeHashtag']) {
  instagram[name] = async () => {
    throw new Error(`la carga de fotos no tiene que llamar a ${name}`);
  };
}

/** Detalle normalizado, como lo devuelve fetchPostDetails. Trae métricas distintas a las guardadas. */
function detalle(code, { id = code, imageUrl = link(code) } = {}) {
  return { id, account: 'cuenta', url: urlOf(code), caption: 'texto', hashtagsText: '', likes: 999, comments: 99, postedAt: null, postType: 'reel', followers: null, imageUrl, sourceType: 'search', sourceQuery: null };
}

// --------------------------------------------------------------------------
// Red simulada: solo links de imagen. Cualquier otro pedido hace fallar el test.
// --------------------------------------------------------------------------
let IMAGEN;
const fetchCalls = [];
let imageResponder;
const originalFetch = global.fetch;
global.fetch = async (url, init) => {
  const href = String(url);
  if (!new URL(href).hostname.endsWith('.cdninstagram.com')) throw new Error(`pedido de red inesperado en el test: ${new URL(href).hostname}`);
  fetchCalls.push(href);
  return imageResponder(href, init);
};

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
  fs.rmSync(MEDIA, { recursive: true, force: true });
  pedidos.length = 0;
  fetchCalls.length = 0;
  logs.length = 0;
  responder = async (urls) => urls.map((url) => detalle(codeOf(url)));
  imageResponder = () => new Response(IMAGEN, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  delete process.env.POST_IMAGES;
  delete process.env.APIFY_PLAN;
}

/** Posteo guardado, publicado hace `dias` días. */
function sembrar(code, dias, { plataforma = 'instagram', url = urlOf(code) } = {}) {
  assert.equal(
    db.saveDetectedPost({ id: code, account: 'cuenta', url, caption: 'texto', matchedReason: 'test', likes: 5, comments: 1, postedAt: new Date(Date.now() - dias * DAY_MS).toISOString(), title: 't', sentiment: 'neutral', postType: 'reel', followers: null, plataforma }),
    true
  );
}
const fila = (code) => ({ ...raw.prepare('SELECT likes, comments, metrics_updated_at, refresh_misses, refresh_stopped_at FROM detected_posts WHERE id = ?').get(code) });
const estado = (code) => ({ ...db.getPostImage(code, 'instagram') });
const archivos = () => (fs.existsSync(IG_DIR) ? fs.readdirSync(IG_DIR).sort() : []);
const hashDe = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Corre la carga juntando lo que escribe. */
async function cargar(options = {}) {
  const lineas = [];
  const result = await carga.runLoad({ out: (l) => lineas.push(l), ...options });
  return { ...result, lineas };
}

// --------------------------------------------------------------------------
describe('cargar-fotos: opciones y cuentas', () => {
  test('parseArgs', () => {
    assert.deepEqual(carga.parseArgs(['node', 'x']), { si: false, max: null, lot: 50, help: false, error: null });
    assert.deepEqual(carga.parseArgs(['node', 'x', '--si', '--max', '5']), { si: true, max: 5, lot: 50, help: false, error: null });
    assert.deepEqual(carga.parseArgs(['node', 'x', '--max=12', '--lote=25', '--si']), { si: true, max: 12, lot: 25, help: false, error: null });
    assert.equal(carga.parseArgs(['node', 'x', '--ayuda']).help, true);
    assert.match(carga.parseArgs(['node', 'x', '--lote', '101']).error, /no puede pasar de 100/);
    assert.match(carga.parseArgs(['node', 'x', '--max', 'cinco']).error, /número entero/);
    assert.match(carga.parseArgs(['node', 'x', '--max']).error, /número entero/);
    assert.match(carga.parseArgs(['node', 'x', '--todo']).error, /Opción desconocida: --todo/);
    assert.equal(carga.parseArgs(['node', 'x', '--todo', '--si']).si, false, 'con una opción mal escrita no queda en modo ejecución');
  });

  test('el código del posteo se saca igual que en el monitoreo', () => {
    for (const url of ['https://www.instagram.com/p/ABC123/', 'https://www.instagram.com/reel/DEF_456/?igsh=x', 'https://www.instagram.com/reels/G-7/', 'https://www.instagram.com/tv/H8', 'https://www.instagram.com/cuenta/', 'https://www.instagram.com/p/', '', null, undefined]) {
      assert.equal(carga.postCode(url), monitor.postCodeOf(url), String(url));
    }
  });

  test('la tarifa es la misma que usa el registro de gastos', () => {
    assert.deepEqual(carga.OFFICIAL_RATES, apifyCost.DEFAULT_RATES);
    for (const plan of ['free', 'starter', 'scale', 'cualquiera', '']) {
      const env = { APIFY_PLAN: plan };
      process.env.APIFY_PLAN = plan;
      assert.equal(carga.officialRate(env).perPost, apifyCost.usdForItems(1), `plan "${plan}"`);
    }
    delete process.env.APIFY_PLAN;
    assert.deepEqual(carga.officialRate({}), { plan: 'starter', perPost: 0.0023 });
    assert.equal(carga.officialRate({ APIFY_PLAN: 'starter', APIFY_RATE_STARTER: '3' }).perPost, 0.003);
  });
});

// --------------------------------------------------------------------------
describe('cargar-fotos: el modo que solo informa', { concurrency: false }, () => {
  beforeEach(reset);

  test('sobre una base anterior a las fotos: cuenta todo como sin foto y no toca el archivo', () => {
    const vieja = path.join(tmp, 'vieja.db');
    fs.rmSync(vieja, { force: true });
    const old = new DatabaseSync(vieja);
    old.exec('CREATE TABLE detected_posts (id TEXT PRIMARY KEY, url TEXT, posted_at TEXT, detected_at TEXT, plataforma TEXT, ignored INTEGER NOT NULL DEFAULT 0)');
    const insert = old.prepare('INSERT INTO detected_posts (id, url, posted_at, detected_at, plataforma, ignored) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('a', urlOf('A'), '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z', 'instagram', 0);
    insert.run('b', urlOf('B'), '2026-07-29T10:00:00.000Z', '2026-07-29T11:00:00.000Z', 'instagram', 0);
    insert.run('c', urlOf('C'), '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 'instagram', 1);
    insert.run('d', 'https://x.com/c/status/1', '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z', 'x', 0);
    old.close();
    const antes = hashDe(vieja);

    const plan = carga.planLoad({ dbPath: vieja, env: {} });
    assert.equal(plan.migrated, false);
    assert.deepEqual([plan.total, plan.withPhoto, plan.withoutCode, plan.pending, plan.selected, plan.lots], [2, 0, 0, 2, 2, 1]);
    assert.deepEqual([plan.newest, plan.oldest], ['2026-10-01T10:00:00.000Z', '2026-07-29T10:00:00.000Z']);
    assert.ok(Math.abs(plan.maxUsd - 0.0046) < 1e-9);

    assert.equal(hashDe(vieja), antes, 'el archivo de la base queda byte por byte igual');
    assert.deepEqual(new DatabaseSync(vieja, { readOnly: true }).prepare('PRAGMA table_info(detected_posts)').all().map((c) => c.name).filter((n) => n.startsWith('image_')), [], 'no se agregó ninguna columna');
    assert.equal(pedidos.length, 0);
    assert.equal(fetchCalls.length, 0);

    const texto = carga.formatPlan(plan);
    assert.match(texto, /SOLO INFORMA \(no llama a Apify, no baja nada, no escribe nada\)/);
    assert.match(texto, /Todavía no tiene las columnas de fotos/);
    assert.match(texto, /hasta US\$ 0,0046 \(2 × 0,0023 usd, plan starter/);
  });

  test('cuenta los que ya tienen foto, los que no se pueden pedir y respeta --max y --lote', async () => {
    sembrar('NUEVO', 1);
    sembrar('MEDIO', 30);
    sembrar('VIEJO', 70); // más de 60 días: el refresco no lo toca, la carga sí
    sembrar('CONFOTO', 10);
    sembrar('SINARCHIVO', 20); // la base dice que hay foto, el disco no
    sembrar('SINCODIGO', 5, { url: 'https://www.instagram.com/cuenta/' });
    sembrar('IGNORADO', 2);
    db.ignorePost('IGNORADO', 'instagram');
    sembrar('x1', 1, { plataforma: 'x', url: 'https://x.com/c/status/1' });
    const guardada = await postImages.savePostImage({ plataforma: 'instagram', id: 'CONFOTO', url: link('CONFOTO') }, {});
    assert.equal(guardada.ok, true);
    db.markPostImageSaved('CONFOTO', 'instagram', { sourceUrl: link('CONFOTO'), width: 600, height: 750 });
    db.markPostImageSaved('SINARCHIVO', 'instagram', { sourceUrl: link('SINARCHIVO'), width: 600, height: 750 });
    fetchCalls.length = 0;
    const antes = raw.prepare('SELECT id, image_status, image_saved_at, likes FROM detected_posts ORDER BY id').all().map((r) => ({ ...r }));

    const plan = carga.planLoad({ env: { APIFY_PLAN: 'free' } });
    assert.equal(plan.migrated, true);
    assert.deepEqual([plan.total, plan.withPhoto, plan.withoutCode, plan.pending, plan.selected, plan.lots], [6, 1, 1, 4, 4, 1]);
    assert.deepEqual([plan.plan, plan.perPost], ['free', 0.0027]);
    assert.ok(Math.abs(plan.maxUsd - 4 * 0.0027) < 1e-9);

    const conTope = carga.planLoad({ max: 3, lot: 2, env: {} });
    assert.deepEqual([conTope.pending, conTope.selected, conTope.lots, conTope.lotSize], [4, 3, 2, 2]);
    assert.match(carga.formatPlan(conTope), /en esta corrida \(--max\) \.+\s+3/);

    assert.deepEqual(raw.prepare('SELECT id, image_status, image_saved_at, likes FROM detected_posts ORDER BY id').all().map((r) => ({ ...r })), antes, 'la base queda igual');
    assert.equal(pedidos.length, 0);
    assert.equal(fetchCalls.length, 0);
  });

  test('main sin --si: escribe el plan, sale con 0 y no pide ni baja nada', async () => {
    sembrar('P1', 1);
    sembrar('P2', 2);
    const lineas = [];
    const code = await carga.main(['node', 'cargar-fotos.js'], { out: (l) => lineas.push(l), loadEnv: () => {}, appRunning: async () => { throw new Error('en modo informe no hace falta mirar si la app está prendida'); } });
    assert.equal(code, 0);
    const texto = lineas.join('\n');
    assert.match(texto, /SOLO INFORMA/);
    assert.match(texto, /Posteos a pedir: 2/);
    assert.match(texto, /node scripts\/cargar-fotos\.js --si --max 5/);
    assert.equal(pedidos.length, 0);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(archivos(), []);
    assert.equal(estado('P1').status, null);
  });

  test('main con una opción mal escrita: no hace nada y sale con 1', async () => {
    sembrar('P1', 1);
    const lineas = [];
    const code = await carga.main(['node', 'cargar-fotos.js', '--si', '--mx', '5'], { out: (l) => lineas.push(l), loadEnv: () => {}, appRunning: async () => false });
    assert.equal(code, 1);
    assert.match(lineas.join('\n'), /Opción desconocida: --mx/);
    assert.equal(pedidos.length, 0);
  });
});

// --------------------------------------------------------------------------
describe('cargar-fotos: la carga', { concurrency: false }, () => {
  beforeEach(reset);

  test('pide los posteos sin foto por su URL, en lotes y de a uno, y guarda las fotos sin tocar las métricas', async () => {
    const codes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    codes.forEach((code, i) => sembrar(code, i + 1)); // A es el más reciente
    sembrar('VIEJO', 80);
    sembrar('IGNORADO', 2);
    db.ignorePost('IGNORADO', 'instagram');
    sembrar('x1', 1, { plataforma: 'x', url: 'https://x.com/c/status/1' });
    const antes = Object.fromEntries([...codes, 'VIEJO'].map((code) => [code, fila(code)]));

    // Un pedido a la vez: el siguiente lote no arranca hasta que el anterior terminó de bajar sus fotos.
    let enCurso = 0;
    let maximo = 0;
    responder = async (urls) => {
      enCurso += 1;
      maximo = Math.max(maximo, enCurso);
      await new Promise((resolve) => setTimeout(resolve, 20));
      enCurso -= 1;
      return urls.map((url) => detalle(codeOf(url))).reverse();
    };

    const result = await cargar({ lot: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.stopped, null);
    assert.deepEqual(pedidos.map((p) => p.urls), [['A', 'B', 'C'].map(urlOf), ['D', 'E', 'F'].map(urlOf), ['G', 'VIEJO'].map(urlOf)], 'los más recientes primero; el ignorado y el de X no se piden');
    assert.equal(maximo, 1);
    // Cada llamada queda identificada con su fase para el registro de gastos.
    assert.ok(pedidos.every((p) => p.contexto && p.contexto.phase === 'fotos' && p.contexto.runId === null));

    assert.deepEqual({ ...result.totals }, { requested: 8, answered: 8, missing: 0, withoutLink: 0, saved: 8, alreadySaved: 0, expired: 0, failed: 0, pending: 0, lots: 3 });
    assert.equal(archivos().length, 16);
    assert.deepEqual([...fetchCalls].sort(), [...codes, 'VIEJO'].map(link).sort(), 'una descarga por posteo, con el link de la respuesta');
    for (const code of [...codes, 'VIEJO']) {
      assert.deepEqual([estado(code).status, estado(code).sourceUrl], ['ok', link(code)]);
      // La respuesta traía likes 999 y comentarios 99: no se usan.
      assert.deepEqual(fila(code), antes[code], `${code}: métricas y refresco como estaban`);
    }
    assert.equal(db.getPostImage('IGNORADO', 'instagram').status, null);
    assert.match(result.lineas[0], /^lote 1\/3: 3 pedidos, 3 respondieron → 3 fotos guardadas\.$/);
    assert.ok(!logs.some((l) => l.includes('FIRMA_SECRETA')), 'el link firmado no va a los logs');
  });

  test('--max pide solo esa cantidad; volver a correr saltea los que ya tienen foto', async () => {
    ['A', 'B', 'C', 'D'].forEach((code, i) => sembrar(code, i + 1));
    const prueba = await cargar({ max: 2 });
    assert.equal(prueba.ok, true);
    assert.deepEqual(pedidos.map((p) => p.urls), [['A', 'B'].map(urlOf)]);
    assert.deepEqual([estado('A').status, estado('B').status, estado('C').status], ['ok', 'ok', null]);

    pedidos.length = 0;
    const resto = await cargar();
    assert.deepEqual(pedidos.map((p) => p.urls), [['C', 'D'].map(urlOf)], 'A y B ya tienen sus copias');
    assert.equal(resto.totals.saved, 2);

    pedidos.length = 0;
    fetchCalls.length = 0;
    const nada = await cargar();
    assert.equal(nada.ok, true);
    assert.equal(pedidos.length, 0, 'sin posteos sin foto no se le pide nada a Apify');
    assert.equal(fetchCalls.length, 0);
    assert.match(nada.lineas.join('\n'), /No hay posteos sin foto/);
  });

  test('cruza la respuesta por id y por el código de la URL; lo que no vuelve o no trae imagen queda sin foto', async () => {
    ['PORID', 'PORCODIGO', 'NOVOLVIO', 'SINLINK'].forEach((code, i) => sembrar(code, i + 1));
    const misses = fila('NOVOLVIO');
    responder = async () => [detalle('PORID'), detalle('PORCODIGO', { id: 'otro-id-123' }), detalle('SINLINK', { imageUrl: null })];

    const result = await cargar();
    assert.equal(result.ok, true);
    assert.deepEqual([result.totals.answered, result.totals.missing, result.totals.withoutLink, result.totals.saved], [3, 1, 1, 2]);
    assert.deepEqual([estado('PORID').status, estado('PORCODIGO').status], ['ok', 'ok']);
    assert.equal(estado('NOVOLVIO').status, null);
    assert.equal(estado('SINLINK').status, null);
    assert.deepEqual(fila('NOVOLVIO'), misses, 'no cuenta como falta para el refresco');
    assert.match(result.lineas[0], /4 pedidos, 3 respondieron → 2 fotos guardadas \(1 sin respuesta, 1 sin link de imagen\)/);
  });

  test('si un pedido a Apify falla, frena ahí: lo anterior queda guardado y no se pide más', async () => {
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach((code, i) => sembrar(code, i + 1));
    responder = async (urls) => {
      if (pedidos.length === 2) throw new Error('Apify respondió 502');
      return urls.map((url) => detalle(codeOf(url)));
    };
    const result = await cargar({ lot: 2 });
    assert.equal(result.ok, false);
    assert.match(result.stopped, /lote 2\/3: falló el pedido a Apify \(Apify respondió 502\)/);
    assert.equal(pedidos.length, 2, 'el tercer lote no se pidió');
    assert.deepEqual(['A', 'B', 'C', 'E'].map((code) => estado(code).status), ['ok', 'ok', null, null]);
    assert.deepEqual([result.totals.lots, result.totals.requested, result.totals.saved], [1, 2, 2]);

    // Cuota agotada: lo dice con ese nombre.
    reset();
    sembrar('A', 1);
    responder = async () => {
      const err = new Error('Monthly usage hard limit exceeded');
      err.code = 'QUOTA_EXCEEDED';
      throw err;
    };
    const sinCuota = await cargar();
    assert.equal(sinCuota.ok, false);
    assert.match(sinCuota.stopped, /se agotó la cuota de Apify/);
  });

  test('si las fotos del lote no se pueden bajar, frena para no seguir gastando; quedan pendientes con su link', async () => {
    const codes = Array.from({ length: 12 }, (_, i) => `R${String(i).padStart(2, '0')}`);
    codes.forEach((code, i) => sembrar(code, i + 1));
    imageResponder = () => {
      throw new TypeError('fetch failed');
    };
    const result = await cargar({ lot: 6 });
    assert.equal(result.ok, false);
    assert.match(result.stopped, /lote 1\/2: no se pudo guardar ninguna foto del lote/);
    assert.equal(pedidos.length, 1, 'el segundo lote no se pidió');
    const delLote = codes.slice(0, 6);
    assert.ok(delLote.every((code) => estado(code).status === 'pendiente' && estado(code).sourceUrl === link(code)), 'la app las reintenta sola en su próximo ciclo');
    assert.ok(codes.slice(6).every((code) => estado(code).status === null));
    assert.equal(result.totals.pending, 6);
    assert.match(carga.formatSummary(result, { perPost: 0.0023 }), /Carga FRENADA[\s\S]*las reintenta la app sola[\s\S]*Se puede volver a correr/);
  });

  test('si el actor no devuelve ninguno de los posteos pedidos, frena', async () => {
    ['A', 'B', 'C', 'D'].forEach((code, i) => sembrar(code, i + 1));
    responder = async () => [];
    const result = await cargar({ lot: 2 });
    assert.equal(result.ok, false);
    assert.match(result.stopped, /el actor no devolvió ninguno de los posteos pedidos/);
    assert.equal(pedidos.length, 1);
    assert.equal(fetchCalls.length, 0);
  });

  test('con las fotos apagadas, o en una plataforma sin fotos, no pide nada', async () => {
    sembrar('A', 1);
    process.env.POST_IMAGES = '0';
    const apagado = await cargar();
    assert.equal(apagado.ok, false);
    assert.match(apagado.stopped, /fotos están apagadas/);
    delete process.env.POST_IMAGES;
    const equis = await cargar({ plataforma: 'x' });
    assert.equal(equis.ok, false);
    assert.match(equis.stopped, /no tiene fotos/);
    assert.equal(pedidos.length, 0);
    assert.equal(fetchCalls.length, 0);
  });
});

// --------------------------------------------------------------------------
describe('cargar-fotos: main con --si', { concurrency: false }, () => {
  beforeEach(reset);

  test('con la app prendida no arranca', async () => {
    sembrar('A', 1);
    const lineas = [];
    const code = await carga.main(['node', 'cargar-fotos.js', '--si'], { out: (l) => lineas.push(l), loadEnv: () => {}, appRunning: async () => true });
    assert.equal(code, 1);
    assert.match(lineas.join('\n'), /La app está corriendo[\s\S]*no se pidió nada/);
    assert.equal(pedidos.length, 0);
    assert.equal(fetchCalls.length, 0);
  });

  test('con la app apagada corre la prueba de 5 y escribe el resumen con el gasto', async () => {
    Array.from({ length: 8 }, (_, i) => `M${i}`).forEach((code, i) => sembrar(code, i + 1));
    const lineas = [];
    const code = await carga.main(['node', 'cargar-fotos.js', '--si', '--max', '5'], { out: (l) => lineas.push(l), loadEnv: () => {}, appRunning: async () => false });
    assert.equal(code, 0);
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].urls.length, 5);
    assert.equal(archivos().length, 10);
    const texto = lineas.join('\n');
    assert.match(texto, /EJECUCIÓN/);
    assert.match(texto, /en esta corrida \(--max\) \.+\s+5/);
    assert.match(texto, /Carga terminada\./);
    assert.match(texto, /Fotos: 5 guardadas, 0 ya estaban/);
    assert.match(texto, /Gasto estimado: hasta US\$ 0,0115 \(5 × 0,0023 usd\)/);
  });

  test('si la carga se frena, sale con 1', async () => {
    sembrar('A', 1);
    responder = async () => {
      throw new Error('sin red');
    };
    const lineas = [];
    const code = await carga.main(['node', 'cargar-fotos.js', '--si'], { out: (l) => lineas.push(l), loadEnv: () => {}, appRunning: async () => false });
    assert.equal(code, 1);
    assert.match(lineas.join('\n'), /Carga FRENADA: lote 1\/1: falló el pedido a Apify \(sin red\)/);
  });
});
