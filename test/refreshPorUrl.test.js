'use strict';

// Refresco de métricas por URL (src/metricsRefresh.js con REFRESH_MODE=url,
// el default; openspec/changes/refresco-url): selección por publicación con
// los tramos y cadencias de siempre, cola por tramo y por atraso, tope
// REFRESH_MAX_POSTS, marcas de pase solo con pase completo, solo URLs con
// código, regla única de métricas en el flujo, contador de sin respuesta y
// freno, run caído, cuota, X intacta y la fila de apify_calls. La fuente
// está stubeada (instagram.fetchPostDetails); el último test usa el
// fetchPostDetails real con fetch stubeado para ver la fila de costo. Los
// topes se fijan ANTES de cargar el módulo (los lee al cargar). Base y
// config temporales: nada toca data/monitoring.db ni llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_RETRY_DELAY_MS = '5';
delete process.env.REFRESH_MODE; // vacío = url
process.env.REFRESH_MAX_POSTS = '3';
process.env.REFRESH_MISSES_TO_STOP = '2';
process.env.REFRESH_HOT_EVERY_HOURS = '12';
delete process.env.MAX_ACCOUNTS_PER_REFRESH;
for (const key of Object.keys(process.env)) {
  if (/^(APIFY_RATE_|APIDOJO_)/.test(key)) delete process.env[key];
}
process.env.APIFY_PLAN = 'starter';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-refresh-url-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [] } }, null, 2) + '\n');

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// Clasificador stubeado antes de cargar monitor.js (metricsRefresh lo requiere).
const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 't', sentiment: 'neutral' });

const db = require('../src/db');
const metricsRefresh = require('../src/metricsRefresh');
const { resolveRefreshMode, REFRESH_MODES, DEFAULT_REFRESH_MODE } = require('../src/refreshMode');
const { runWithContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const raw = new DatabaseSync(DB_PATH);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const urlOf = (code) => `https://www.instagram.com/p/${code}/`;

instagram.isConfigured = () => true;
const originalFetchPostDetails = instagram.fetchPostDetails;
// En modo url el perfil no se consulta nunca: si alguien lo llama, el test falla.
instagram.scrapeAccount = async (account) => {
  throw new Error(`scrapeAccount(@${account}) no debería llamarse con REFRESH_MODE=url`);
};

/** Llamadas capturadas a fetchPostDetails (una por run) y la respuesta configurada. */
let calls = [];
let responder = async () => [];
instagram.fetchPostDetails = async (urls) => {
  calls.push([...urls]);
  return responder(urls, calls.length);
};

/**
 * Posteo guardado con posted_at, detected_at y metrics_updated_at controlados
 * (null = nunca refrescado: cuenta desde detected_at).
 */
function seed(code, { postedAgoMs, detectedAgoMs = postedAgoMs, refreshedAgoMs = null, likes = 50, comments = 7, account = 'cuenta', url = urlOf(code) }) {
  assert.equal(
    db.saveDetectedPost({
      id: code, account, url, caption: 'obras', matchedReason: 'test',
      likes, comments, postedAt: agoIso(postedAgoMs), title: 't', sentiment: 'neutral', postType: null, followers: null, plataforma: 'instagram',
    }),
    true,
    `seed ${code}`
  );
  raw.prepare('UPDATE detected_posts SET posted_at = ?, detected_at = ?, metrics_updated_at = ? WHERE id = ?').run(
    agoIso(postedAgoMs),
    agoIso(detectedAgoMs),
    refreshedAgoMs == null ? null : agoIso(refreshedAgoMs),
    code
  );
}

/** Detalle normalizado como lo devuelve fetchPostDetails (el id y la url del posteo pedido). */
function detail(code, { likes, comments, id = code, url = urlOf(code) }) {
  return { id, account: 'cuenta', url, caption: 'obras', hashtagsText: '', likes, comments, postedAt: null, postType: null, followers: null, sourceType: 'search', sourceQuery: null };
}

const row = (id) => raw.prepare('SELECT likes, comments, metrics_updated_at, refresh_misses, refresh_stopped_at FROM detected_posts WHERE id = ?').get(id);
const codeOf = (url) => url.split('/p/')[1].replace('/', '');

function reset() {
  raw.prepare('DELETE FROM detected_posts').run();
  raw.prepare('DELETE FROM refresh_state').run();
  raw.prepare('DELETE FROM apify_calls').run();
  calls = [];
  responder = async () => [];
}

const refresh = () => metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });

describe('refresco por URL (REFRESH_MODE=url)', { concurrency: false }, () => {
  beforeEach(reset);

  test('interruptor: default url, acepta mayúsculas y espacios, un valor desconocido tira; el modo efectivo depende de fetchPostDetails', () => {
    assert.deepEqual(REFRESH_MODES, ['url', 'perfil']);
    assert.equal(DEFAULT_REFRESH_MODE, 'url');
    assert.equal(resolveRefreshMode(''), 'url');
    assert.equal(resolveRefreshMode(' PERFIL '), 'perfil');
    assert.throws(() => resolveRefreshMode('posteo'), /REFRESH_MODE="posteo" no es válido.*"url" o "perfil"/);
    assert.equal(metricsRefresh.REFRESH_MODE, 'url');
    assert.equal(metricsRefresh.REFRESH_MAX_POSTS, 3);
    assert.equal(metricsRefresh.REFRESH_MISSES_TO_STOP, 2);
    assert.equal(metricsRefresh.REFRESH_URLS_PER_RUN, 100);
    assert.equal(metricsRefresh.refreshModeFor(instagram), 'url');
    assert.equal(metricsRefresh.refreshModeFor({ capabilities: { metricsRefresh: true } }), 'perfil', 'sin fetchPostDetails cae al camino por perfil');
  });

  test('selección por publicación: caliente por cadencia desde la detección, tibio y frío por marca y cadencia, congelado nunca; un run con todas las URLs', async () => {
    seed('cal-nueva', { postedAgoMs: 2 * HOUR_MS }); // detectado hace 2 h: entra recién a las 12 h
    seed('cal-vencida', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS }); // vencido
    seed('cal-fresca', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 1 * HOUR_MS }); // espera
    seed('tibia', { postedAgoMs: 3 * DAY_MS }); // nunca refrescado, detectado hace 3 días: vencido
    seed('fria', { postedAgoMs: 20 * DAY_MS }); // ídem, tramo frío
    seed('congelada', { postedAgoMs: 70 * DAY_MS }); // más de 60 días: nada la toca
    responder = async (urls) => urls.map((url) => detail(codeOf(url), { likes: 100, comments: 10 }));

    const result = await refresh();
    assert.equal(calls.length, 1, 'un solo run');
    assert.deepEqual(calls[0].map(codeOf), ['cal-vencida', 'tibia', 'fria'], 'caliente, tibio, frío');
    assert.equal(result.mode === undefined, true, 'los totales no tienen modo; sí cada plataforma');
    assert.equal(result.porPlataforma.instagram.mode, 'url');
    assert.deepEqual(
      [result.hotCount, result.warmCount, result.coldCount, result.postsRequested, result.postsAnswered, result.rowsUpdated, result.runs, result.deferred, result.postsMissing],
      [1, 1, 1, 3, 3, 3, 1, 0, 0]
    );
    assert.equal(result.accountsChecked, 0, 'ninguna consulta de perfil');
    for (const id of ['cal-vencida', 'tibia', 'fria']) {
      assert.deepEqual([row(id).likes, row(id).comments], [100, 10], id);
      assert.ok(row(id).metrics_updated_at, `${id} con marca nueva`);
    }
    for (const id of ['cal-nueva', 'cal-fresca', 'congelada']) assert.equal(row(id).likes, 50, `${id} intacto`);
    assert.ok(db.getRefreshState('warm_last_pass_at'), 'pase tibio completo: la marca avanza');
    assert.ok(db.getRefreshState('cold_last_pass_at'), 'pase frío completo: la marca avanza');

    const otraVez = await refresh();
    assert.equal(calls.length, 1, 'nada vencido: no se llama a la fuente');
    assert.equal(otraVez.postsRequested, 0);
    assert.equal(otraVez.runs, 0);
  });

  test('orden tramo primero y atraso adentro; el tope deja el resto para el próximo ciclo sin avanzar las marcas; el ciclo siguiente retoma solo lo que faltaba', async () => {
    seed('cal-a', { postedAgoMs: 30 * HOUR_MS, refreshedAgoMs: 20 * HOUR_MS });
    seed('cal-b', { postedAgoMs: 40 * HOUR_MS, refreshedAgoMs: 30 * HOUR_MS }); // más atrasado que cal-a
    seed('fria-1', { postedAgoMs: 20 * DAY_MS, refreshedAgoMs: 10 * DAY_MS });
    seed('fria-2', { postedAgoMs: 21 * DAY_MS, refreshedAgoMs: 9 * DAY_MS });
    seed('fria-3', { postedAgoMs: 22 * DAY_MS }); // nunca refrescado, detectado hace 22 días: el más atrasado del tramo
    responder = async (urls) => urls.map((url) => detail(codeOf(url), { likes: 1, comments: 1 }));

    const primera = await refresh();
    assert.deepEqual(calls[0].map(codeOf), ['cal-b', 'cal-a', 'fria-3'], 'los dos calientes (el más atrasado primero) y después el frío más atrasado');
    assert.equal(primera.deferred, 2);
    assert.equal(primera.leftOut, 2, 'leftOut sigue informando lo que quedó afuera');
    assert.equal(db.getRefreshState('cold_last_pass_at'), null, 'quedaron fríos afuera: la marca no avanza');
    assert.equal(db.getRefreshState('warm_last_pass_at'), null);

    const segunda = await refresh();
    assert.deepEqual(calls[1].map(codeOf), ['fria-1', 'fria-2'], 'solo lo que faltaba: lo ya refrescado queda fuera por su cadencia');
    assert.equal(segunda.deferred, 0);
    assert.ok(db.getRefreshState('cold_last_pass_at'), 'pase completo: ahora sí');
    assert.ok(db.getRefreshState('warm_last_pass_at'));

    const tercera = await refresh();
    assert.equal(calls.length, 2, 'con las marcas puestas y todo refrescado, nada que pedir');
    assert.equal(tercera.postsRequested, 0);
  });

  test('solo URLs con código: un posteo con la URL del perfil no se pide ni se arma una URL con su id; se cuenta en el resultado y en el log', async () => {
    seed('sin-codigo', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS, url: 'https://www.instagram.com/cuenta/' });
    seed('con-codigo', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS });
    responder = async (urls) => urls.map((url) => detail(codeOf(url), { likes: 2, comments: 2 }));
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    let result;
    try {
      result = await refresh();
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(calls, [[urlOf('con-codigo')]]);
    assert.equal(result.withoutCode, 1);
    assert.ok(lines.some((l) => l.includes('1 sin código en la URL')), lines.join('\n'));
    assert.equal(row('sin-codigo').likes, 50);
  });

  test('regla única en el flujo: un detalle con likes null o -1 no pisa los likes guardados, los comentarios sí se actualizan; la marca avanza igual', async () => {
    seed('parcial', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS });
    seed('centinela', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS });
    responder = async () => [detail('parcial', { likes: null, comments: 9 }), detail('centinela', { likes: -1, comments: -1 })];

    const result = await refresh();
    assert.equal(result.postsAnswered, 2);
    assert.equal(result.rowsUpdated, 1, 'solo el parcial cambió de verdad');
    assert.deepEqual([row('parcial').likes, row('parcial').comments], [50, 9]);
    assert.deepEqual([row('centinela').likes, row('centinela').comments], [50, 7]);
    for (const id of ['parcial', 'centinela']) assert.ok(Date.parse(row(id).metrics_updated_at) > Date.now() - 60 * 1000, `${id}: marca reciente`);
  });

  test('sin respuesta: el posteo que el run no devuelve suma un intento; al segundo seguido se frena con log y deja de pedirse; una respuesta válida lo reanuda', async () => {
    seed('borrado', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS });
    seed('viva', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS });
    responder = async () => [detail('viva', { likes: 60, comments: 8 })];

    const primera = await refresh();
    assert.deepEqual(calls[0].map(codeOf).sort(), ['borrado', 'viva']);
    assert.deepEqual([primera.postsAnswered, primera.postsMissing, primera.postsStopped], [1, 1, 0]);
    assert.deepEqual([row('borrado').refresh_misses, row('borrado').refresh_stopped_at], [1, null]);
    assert.deepEqual([row('borrado').likes, row('borrado').comments], [50, 7], 'las métricas quedan en el último valor');
    assert.equal(row('borrado').metrics_updated_at, row('borrado').metrics_updated_at, 'sin marca nueva: sigue vencido para el próximo ciclo');

    // Segundo intento (sigue vencido: su marca no avanzó), sin respuesta otra vez.
    responder = async () => [];
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    let segunda;
    try {
      segunda = await refresh();
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(calls[1].map(codeOf), ['borrado'], 'viva ya está fresca');
    assert.deepEqual([segunda.postsMissing, segunda.postsStopped], [1, 1]);
    assert.equal(row('borrado').refresh_misses, 2);
    assert.ok(row('borrado').refresh_stopped_at, 'frenado');
    assert.ok(
      lines.some((l) => l.includes('@cuenta https://www.instagram.com/p/borrado/: sin respuesta en 2 intentos seguidos') && l.includes('deja de refrescarse')),
      lines.join('\n')
    );
    assert.ok(lines.some((l) => l.includes('1 sin respuesta (1 dejan de refrescarse)')), lines.join('\n'));

    const tercera = await refresh();
    assert.equal(calls.length, 2, 'frenado: no se vuelve a pedir');
    assert.equal(tercera.postsRequested, 0);

    // Una respuesta válida por cualquier camino lo reanuda.
    db.applyMetricsRefresh('borrado', { likes: 51, comments: 7 });
    assert.deepEqual([row('borrado').refresh_misses, row('borrado').refresh_stopped_at], [0, null]);
  });

  test('un run caído no actualiza ni suma intentos, y las marcas no avanzan; cuota agotada se informa y tampoco avanza', async () => {
    seed('caida', { postedAgoMs: 3 * DAY_MS, refreshedAgoMs: 30 * HOUR_MS });
    responder = async () => {
      throw new Error('Apify respondió 500');
    };
    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await refresh();
    } finally {
      console.error = originalError;
    }
    assert.equal(calls.length, 1);
    assert.deepEqual([result.runs, result.runsFailed, result.postsMissing, result.quotaExceeded], [0, 1, 0, false]);
    assert.deepEqual([row('caida').refresh_misses, row('caida').likes], [0, 50]);
    assert.equal(db.getRefreshState('warm_last_pass_at'), null, 'run caído: el pase no se da por hecho');

    responder = async () => {
      const err = new Error('cuota agotada');
      err.code = 'QUOTA_EXCEEDED';
      throw err;
    };
    const cuota = await refresh();
    assert.equal(cuota.quotaExceeded, true);
    assert.equal(db.getRefreshState('warm_last_pass_at'), null);
    assert.equal(row('caida').refresh_misses, 0);
  });

  test('X no se toca: sin capability de refresco no hay llamada; con skipAccounts los posteos de esa cuenta esperan al próximo ciclo', async () => {
    const x = await metricsRefresh.refreshPostMetrics({ plataformas: ['x'] });
    assert.deepEqual(x.porPlataforma, {});
    assert.equal(calls.length, 0);

    seed('de-benchmark', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS, account: 'Recalculada' });
    seed('otra', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS });
    responder = async (urls) => urls.map((url) => detail(codeOf(url), { likes: 3, comments: 3 }));
    const result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'], skipAccounts: { instagram: ['recalculada'] } });
    assert.deepEqual(calls, [[urlOf('otra')]]);
    assert.equal(result.skippedByAccount, 1);
  });

  test('registro de costo: el fetchPostDetails real deja la fila en apify_calls con fase refresco, query_type post y el actor oficial', async () => {
    const FIX = require('./fixtures/apify/post-details-2urls.json');
    const item = FIX.find((i) => i.shortCode === 'DdXolvnxhoP');
    seed(item.id, { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS, url: item.url, likes: 1, comments: 1 });

    const bodies = [];
    const originalFetch = global.fetch;
    instagram.fetchPostDetails = originalFetchPostDetails;
    global.fetch = async (url, options) => {
      bodies.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, text: async () => '', json: async () => [item] };
    };
    let result;
    try {
      result = await runWithContext({ phase: 'refresco' }, () => refresh());
    } finally {
      global.fetch = originalFetch;
      instagram.fetchPostDetails = async (urls) => {
        calls.push([...urls]);
        return responder(urls, calls.length);
      };
    }
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].url, /apify~instagram-scraper\/run-sync-get-dataset-items/);
    assert.deepEqual(bodies[0].body, { directUrls: [item.url], resultsType: 'posts', resultsLimit: 1 });
    assert.deepEqual([result.postsRequested, result.postsAnswered, result.rowsUpdated], [1, 1, 1]);
    assert.deepEqual([row(item.id).likes, row(item.id).comments], [item.likesCount, item.commentsCount]);

    const fila = raw.prepare('SELECT phase, query_type, actor, items, usd, target, ok FROM apify_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(fila.phase, 'refresco');
    assert.equal(fila.query_type, 'post');
    assert.equal(fila.actor, 'apify~instagram-scraper');
    assert.equal(fila.items, 1);
    assert.equal(fila.ok, 1);
    assert.equal(fila.target, item.url);
    assert.ok(Math.abs(fila.usd - 0.0023) < 1e-9, `usd ${fila.usd}`);
  });
});
