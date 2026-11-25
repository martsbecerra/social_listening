'use strict';

// La clave de Apify va en el encabezado Authorization: Bearer, nunca en la
// dirección (rama rate-limit-y-salud). Se recorren las seis llamadas de
// src/apify.js (el sincrónico, el arranque, el seguimiento y los items del
// asincrónico, fetchRun y listActorRuns) con fetch simulado: ninguna
// dirección lleva token= ni la clave, todas llevan el encabezado. Un error
// de Apify o de red que trajera la clave la muestra tapada, y nada de lo
// que sale por consola la nombra. Y en src/ y scripts/ no queda ninguna
// dirección armada con token= (el link del mail de login es otra cosa).

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-apify-clave-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
const CLAVE = 'apify_api_ClaveDePrueba1234567890';
process.env.APIFY_API_TOKEN = CLAVE;
process.env.APIFY_POLL_RETRY_MS = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const apify = require('../src/apify');

const ROOT = path.join(__dirname, '..');
const pedidos = [];
const consola = [];
const originales = { fetch: global.fetch, log: console.log, warn: console.warn, error: console.error };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function simular(responder) {
  global.fetch = async (url, opts = {}) => {
    pedidos.push({ url: String(url), method: opts.method || 'GET', headers: { ...(opts.headers || {}) } });
    return responder(new URL(String(url)), opts);
  };
}

before(() => {
  for (const nivel of ['log', 'warn', 'error']) {
    console[nivel] = (...args) => consola.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
  }
});

after(() => {
  global.fetch = originales.fetch;
  console.log = originales.log;
  console.warn = originales.warn;
  console.error = originales.error;
});

test('las seis llamadas: la clave en Authorization: Bearer y ninguna dirección con token=', async () => {
  simular((u, opts) => {
    const p = u.pathname;
    if (p.endsWith('/run-sync-get-dataset-items')) return json([{ id: '1' }]);
    if (opts.method === 'POST' && /\/acts\/[^/]+\/runs$/.test(p)) return json({ data: { id: 'run-1', status: 'RUNNING', defaultDatasetId: 'ds-1' } }, 201);
    if (p === '/v2/actor-runs/run-1' && u.searchParams.has('waitForFinish')) return json({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } });
    if (p === '/v2/datasets/ds-1/items') return json([{ id: 'a' }, { id: 'b' }]);
    if (p === '/v2/actor-runs/run-9') return json({ data: { id: 'run-9', status: 'SUCCEEDED', usageTotalUsd: 0.01 } });
    if (/\/acts\/[^/]+\/runs$/.test(p)) return json({ data: { items: [{ id: 'run-9', status: 'SUCCEEDED', startedAt: '2026-11-20T10:00:00Z' }] } });
    throw new Error(`pedido inesperado: ${u}`);
  });

  // 1. Sincrónico (el actor oficial).
  assert.equal((await apify.runActorSync({ directUrls: ['https://www.instagram.com/p/abc/'] }, { plataforma: 'instagram' })).length, 1);
  // 2, 3 y 4. Asincrónico con tope del run: arranque, seguimiento e items.
  const items = await apify.runActorSync(
    { searchQuery: 'macri' },
    { actorId: 'apidojo~instagram-scraper-api', plataforma: 'instagram', asincronico: true, runTimeoutSecs: 3600 }
  );
  assert.equal(items.length, 2);
  // 5. Un run. 6. Las corridas de un actor.
  assert.equal((await apify.fetchRun('run-9')).status, 'SUCCEEDED');
  assert.equal((await apify.listActorRuns('apidojo~instagram-scraper-api', { max: 250 })).length, 1);

  const caminos = pedidos.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`);
  assert.deepEqual(caminos, [
    'POST /v2/acts/apify~instagram-scraper/run-sync-get-dataset-items',
    'POST /v2/acts/apidojo~instagram-scraper-api/runs?timeout=3600',
    `GET /v2/actor-runs/run-1?waitForFinish=${caminos[2].split('waitForFinish=')[1]}`,
    'GET /v2/datasets/ds-1/items',
    'GET /v2/actor-runs/run-9',
    'GET /v2/acts/apidojo~instagram-scraper-api/runs?desc=true&limit=250&offset=0',
  ]);
  for (const r of pedidos) {
    assert.doesNotMatch(r.url, /token=/i, r.url);
    assert.ok(!r.url.includes(CLAVE), r.url);
    assert.equal(r.headers.Authorization, `Bearer ${CLAVE}`, r.url);
  }
  // El Content-Type va solo con cuerpo.
  assert.equal(pedidos[0].headers['Content-Type'], 'application/json');
  assert.equal(pedidos[4].headers['Content-Type'], undefined);
});

test('un error de Apify o de red que trajera la clave la muestra tapada; la consola nunca la nombra', async () => {
  simular(() => json({ error: { type: 'user-or-token-not-found', message: `Token ${CLAVE} inválido` } }, 401));
  await assert.rejects(
    () => apify.fetchRun('run-9'),
    (err) => {
      assert.equal(err.code, 'AUTH_INVALID');
      assert.ok(!err.message.includes(CLAVE), err.message);
      assert.match(err.message, /\*\*\*/);
      return true;
    }
  );

  global.fetch = async () => {
    throw new Error(`connect ECONNREFUSED (Authorization: Bearer ${CLAVE})`);
  };
  await assert.rejects(
    () => apify.fetchRun('run-9'),
    (err) => {
      assert.equal(err.network, true);
      assert.ok(!err.message.includes(CLAVE), err.message);
      return true;
    }
  );

  // Una llamada que pasa por la fila de apify_calls y por el log del limitador.
  simular(() => json({ error: { message: `mala clave ${CLAVE}` } }, 403));
  await assert.rejects(() => apify.runActorSync({ directUrls: ['https://www.instagram.com/p/xyz/'] }, { plataforma: 'instagram' }));

  const conClave = consola.filter((l) => l.includes(CLAVE));
  assert.deepEqual(conClave, []);
  assert.ok(consola.length > 0, 'hubo salida por consola para revisar');
});

test('en src/ y scripts/ ninguna dirección se arma con token= (salvo el link del mail de login)', () => {
  const archivos = [path.join(ROOT, 'server.js')];
  const recorrer = (dir) => {
    for (const nombre of fs.readdirSync(dir)) {
      const full = path.join(dir, nombre);
      if (fs.statSync(full).isDirectory()) recorrer(full);
      else if (nombre.endsWith('.js')) archivos.push(full);
    }
  };
  recorrer(path.join(ROOT, 'src'));
  recorrer(path.join(ROOT, 'scripts'));
  const hallados = [];
  for (const file of archivos) {
    // El link del magic link (/login-verify.html?token=…) no es la clave de Apify.
    if (path.relative(ROOT, file).replace(/\\/g, '/') === 'src/mailer.js') continue;
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/[?&]token=\$\{|APIFY_API_TOKEN[^\n]*\?token|token=\$\{\s*encodeURIComponent/g)) {
      hallados.push(`${path.relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(hallados, []);
});
