'use strict';

// El id del run nunca se pierde (noviembre 2026, openspec/changes/
// ventana-por-fuente): en el flujo asincrónico de src/apify.js la fila de
// apify_calls se abre apenas Apify devuelve el run; el seguimiento se
// reintenta ante un fallo pasajero; al vencer la espera el error lleva el id
// y el run no se aborta; un run que Apify cortó entrega lo que dejó. Los
// casos salen de las corridas #55 y #56 del piloto (TIMEOUT a los 300 s y
// 502 en el seguimiento, con runs que terminaron bien). fetch simulado; base
// temporal; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-apify-cortada-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_PLAN = 'starter';
process.env.APIFY_RETRY_DELAY_MS = '5';
process.env.APIFY_POLL_RETRY_MS = '5';
delete process.env.APIFY_REAL_COST;
for (const key of Object.keys(process.env)) {
  if (/^(APIFY_RATE_|APIDOJO_)/.test(key)) delete process.env[key];
}

const db = require('../src/db');
const apify = require('../src/apify');
const { runActorSync } = apify;
const { runWithContext } = require('../src/usageContext');
const { DatabaseSync } = require('node:sqlite');

const APIDOJO = 'apidojo~instagram-scraper-api';
const raw = new DatabaseSync(process.env.MONITORING_DB_PATH, { readOnly: true });
const filas = () => raw.prepare('SELECT * FROM apify_calls ORDER BY id').all();
const ultima = () => filas().at(-1);
const respond = (status, body, text = '') => ({ ok: status < 400, status, text: async () => text || JSON.stringify(body ?? ''), json: async () => body });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const INPUT = { keywords: ['macri'], maxItems: 500, until: '2026-11-06' };
const buscar = (opts = {}) => runWithContext({ runId: 56, phase: 'busqueda' }, () => runActorSync(INPUT, { actorId: APIDOJO, plataforma: 'instagram', asincronico: true, recuperable: true, ...opts }));

/**
 * Apify simulado para UN run: `post` y `seguimiento` son listas de
 * respuestas (status o { status, run }) que se van consumiendo; la última se
 * repite. `dataset`: items, o un status de error.
 */
function simular({ post = [200], seguimiento = ['SUCCEEDED'], dataset = [{ id: '1' }, { id: '2' }], demoraMs = 20, alSeguir = null } = {}) {
  const pedidos = [];
  const tomar = (lista) => (lista.length > 1 ? lista.shift() : lista[0]);
  const run = (status) => ({ data: { id: 'run-x', status, defaultDatasetId: 'ds-x', statusMessage: status === 'FAILED' ? 'Actor crashed' : null } });
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    pedidos.push(`${method} ${u.replace(/^https:\/\/api\.apify\.com\/v2/, '').replace(/token=[^&]+/, 'token=***')}`);
    if (method === 'POST' && /\/acts\/[^/]+\/runs\?/.test(u)) {
      const r = tomar(post);
      return r === 200 ? respond(201, run('RUNNING')) : respond(r, null, `error ${r}`);
    }
    if (/\/abort/.test(u)) throw new Error('la app no aborta runs');
    if (/\/actor-runs\/run-x\?/.test(u)) {
      await pausa(demoraMs);
      if (alSeguir) alSeguir();
      const r = tomar(seguimiento);
      if (r === 'RED') throw new TypeError('fetch failed');
      return typeof r === 'number' ? respond(r, null, `error ${r}`) : respond(200, run(r));
    }
    if (/\/datasets\/ds-x\/items\?/.test(u)) {
      const d = Array.isArray(dataset) && typeof dataset[0] === 'number' ? tomar(dataset) : dataset;
      return typeof d === 'number' ? respond(d, null, `error ${d}`) : respond(200, d);
    }
    throw new Error(`pedido inesperado: ${u}`);
  };
  return pedidos;
}

describe('flujo asincrónico: el id del run nunca se pierde', { concurrency: false }, () => {
  let originalFetch;
  let originalWarn;
  let originalError;
  let originalLog;
  beforeEach(() => {
    originalFetch = global.fetch;
    ({ warn: originalWarn, error: originalError, log: originalLog } = console);
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
  });
  afterEach(() => {
    global.fetch = originalFetch;
    Object.assign(console, { warn: originalWarn, error: originalError, log: originalLog });
  });

  test('la fila se abre apenas Apify devuelve el run (en curso, con su id) y se cierra al terminar; el arranque va sin espera y con el tope del run', async () => {
    let enCurso = null;
    const avisos = [];
    const pedidos = simular({ seguimiento: ['RUNNING', 'SUCCEEDED'], alSeguir: () => (enCurso = enCurso || ultima()) });
    const antes = filas().length;
    const items = await buscar({ runTimeoutSecs: 3600, onRunStarted: (run) => avisos.push(run) });
    assert.equal(items.length, 2);
    assert.deepEqual(avisos, [{ id: 'run-x', datasetId: 'ds-x' }]);
    assert.equal(pedidos[0], 'POST /acts/apidojo~instagram-scraper-api/runs?token=***&timeout=3600');
    assert.match(pedidos[1], /^GET \/actor-runs\/run-x\?token=\*\*\*&waitForFinish=60$/);
    assert.equal(pedidos.at(-1), 'GET /datasets/ds-x/items?token=***');

    assert.equal(enCurso.estado, 'en_curso', 'mientras el run corre la fila ya existe');
    assert.equal(enCurso.apify_run_id, 'run-x');
    assert.equal(enCurso.run_id, 56);
    assert.equal(enCurso.max_items, 500);
    assert.equal(enCurso.until, '2026-11-06');

    assert.equal(filas().length, antes + 1, 'una sola fila por llamada');
    const fila = ultima();
    assert.equal(fila.id, enCurso.id);
    assert.equal(fila.estado, 'ok');
    assert.equal(fila.ok, 1);
    assert.equal(fila.items, 2);
  });

  test('un 502 (o un corte de red) en el seguimiento se reintenta: el run terminó bien y la llamada devuelve sus resultados', async () => {
    const pedidos = simular({ seguimiento: [502, 'RED', 'RUNNING', 'SUCCEEDED'] });
    const antes = filas().length;
    const items = await buscar();
    assert.equal(items.length, 2);
    assert.equal(pedidos.filter((p) => p.startsWith('POST')).length, 1, 'el arranque no se repite');
    assert.equal(pedidos.filter((p) => p.includes('/actor-runs/')).length, 4);
    assert.equal(filas().length, antes + 1);
    assert.equal(ultima().estado, 'ok');
  });

  test('vence la espera con el run corriendo: TIMEOUT con el id, sin abortar; la fila queda esperando (o error si nadie lo va a levantar)', async () => {
    simular({ seguimiento: ['RUNNING'], demoraMs: 150 });
    await assert.rejects(buscar({ timeoutMs: 1300 }), (err) => {
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.runPending, true);
      assert.equal(err.apifyRunId, 'run-x');
      assert.equal(err.datasetId, 'ds-x');
      return true;
    });
    let fila = ultima();
    assert.equal(fila.estado, 'esperando');
    assert.equal(fila.ok, 0);
    assert.equal(fila.error, 'TIMEOUT');
    assert.equal(fila.apify_run_id, 'run-x');
    assert.equal(fila.usd, 0);

    simular({ seguimiento: ['RUNNING'], demoraMs: 150 });
    await assert.rejects(buscar({ timeoutMs: 1300, recuperable: false }), { code: 'TIMEOUT' });
    fila = ultima();
    assert.equal(fila.estado, 'error');
    assert.equal(fila.apify_run_id, 'run-x', 'el id queda igual: el costo se concilia');
  });

  test('502 repetido hasta vencer la espera: queda esperando con su id (el run puede haber terminado bien)', async () => {
    process.env.APIFY_POLL_RETRY_MS = '200';
    try {
      simular({ seguimiento: [502] });
      await assert.rejects(buscar({ timeoutMs: 1300 }), (err) => {
        assert.equal(err.code, 'TIMEOUT');
        assert.equal(err.runPending, true);
        assert.match(err.message, /última lectura: Apify respondió 502/);
        return true;
      });
      assert.equal(ultima().estado, 'esperando');
      assert.equal(ultima().apify_run_id, 'run-x');
    } finally {
      process.env.APIFY_POLL_RETRY_MS = '5';
    }
  });

  test('un 401 en el seguimiento no se reintenta: error con el id del run', async () => {
    const pedidos = simular({ seguimiento: [401] });
    await assert.rejects(buscar(), (err) => {
      assert.equal(err.code, 'AUTH_INVALID');
      assert.equal(err.apifyRunId, 'run-x');
      assert.equal(err.runPending, undefined);
      return true;
    });
    assert.equal(pedidos.filter((p) => p.includes('/actor-runs/')).length, 1);
    assert.equal(ultima().estado, 'error');
    assert.equal(ultima().apify_run_id, 'run-x');
  });

  test('el arranque falla con 502: un solo POST (reintentarlo podría crear otro run pago) y una fila fallida sin run', async () => {
    const pedidos = simular({ post: [502] });
    const antes = filas().length;
    await assert.rejects(buscar(), /Apify respondió 502/);
    assert.deepEqual(pedidos.map((p) => p.split(' ')[0]), ['POST']);
    assert.equal(filas().length, antes + 1);
    assert.equal(ultima().estado, 'error');
    assert.equal(ultima().apify_run_id, null);
  });

  test('Apify cortó el run (FAILED) y dejó algo: lo entrega en el error y la fila queda parcial con esos resultados', async () => {
    simular({ seguimiento: ['FAILED'], dataset: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    await assert.rejects(buscar(), (err) => {
      assert.equal(err.runStatus, 'FAILED');
      assert.equal(err.apifyRunId, 'run-x');
      assert.deepEqual(err.partialItems, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      return true;
    });
    const fila = ultima();
    assert.equal(fila.estado, 'parcial');
    assert.equal(fila.ok, 0);
    assert.equal(fila.items, 3);
    assert.ok(Math.abs(fila.usd - (0.015 + 3 * 0.0005)) < 1e-9);
  });

  test('el run terminó bien pero el dataset no se pudo bajar: queda esperando, se levanta después', async () => {
    const pedidos = simular({ dataset: [503] });
    await assert.rejects(buscar(), (err) => {
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.runPending, true);
      assert.equal(err.apifyRunId, 'run-x');
      return true;
    });
    assert.equal(pedidos.filter((p) => p.includes('/datasets/')).length, 5, 'la bajada se reintenta');
    assert.equal(ultima().estado, 'esperando');
  });

  test('un aviso onRunStarted que tira no frena la llamada', async () => {
    simular();
    const items = await buscar({
      onRunStarted: () => {
        throw new Error('aviso roto');
      },
    });
    assert.equal(items.length, 2);
    assert.equal(ultima().estado, 'ok');
  });

  test('asincronico: va por el flujo con run aunque APIFY_REAL_COST=0; sin él, apidojo vuelve al sincrónico', async () => {
    process.env.APIFY_REAL_COST = '0';
    try {
      const pedidos = simular();
      await buscar();
      assert.match(pedidos[0], /^POST \/acts\/apidojo~instagram-scraper-api\/runs\?token=\*\*\*$/);
      assert.equal(ultima().apify_run_id, 'run-x');

      const sync = [];
      global.fetch = async (url) => {
        sync.push(String(url));
        return respond(200, [{ id: 1 }]);
      };
      await buscar({ asincronico: false });
      assert.match(sync[0], /run-sync-get-dataset-items/);
      assert.equal(ultima().apify_run_id, null);
    } finally {
      delete process.env.APIFY_REAL_COST;
    }
  });

  test('deadlineAt: se espera hasta ese instante; si ya pasó no se le pide nada a Apify ni queda fila', async () => {
    let pedidos = simular({ seguimiento: ['RUNNING'], demoraMs: 150 });
    await assert.rejects(buscar({ deadlineAt: Date.now() + 1300 }), { code: 'TIMEOUT', runPending: true });
    assert.ok(pedidos.length >= 2);

    pedidos = simular();
    const antes = filas().length;
    await assert.rejects(buscar({ deadlineAt: Date.now() - 1 }), (err) => {
      assert.equal(err.code, 'NO_LANZADA');
      assert.match(err.userMessage, /venció la espera/);
      return true;
    });
    assert.deepEqual(pedidos, []);
    assert.equal(filas().length, antes);
  });

  test('la conciliación del costo real toma una fila cortada: tiene run y no tiene costo', async () => {
    simular({ seguimiento: ['RUNNING'], demoraMs: 150 });
    await assert.rejects(buscar({ timeoutMs: 1300 }), { code: 'TIMEOUT' });
    const fila = ultima();
    const apifyCost = require('../src/apifyCost');
    const totals = await apifyCost.reconcileRealCosts({
      minAgeMs: -1000,
      fetchRunCost: async (runId) => ({ id: runId, status: 'SUCCEEDED', usdReal: 0.2645, chargedEventCounts: { item: 499 } }),
    });
    assert.ok(totals.updated >= 1);
    assert.equal(db.getApifyCall(fila.id).usd_real, 0.2645);
  });

  test('fetchRun y fetchDatasetItems: lecturas sin cola ni fila; un 404 se distingue; el dataset se reintenta', async () => {
    const antes = filas().length;
    global.fetch = async (url) => {
      if (/actor-runs\/no-existe/.test(url)) return respond(404, null, 'not found');
      return respond(200, { data: { id: 'run-9', status: 'SUCCEEDED', defaultDatasetId: 'ds-9', startedAt: '2026-11-16T15:00:00.000Z', finishedAt: '2026-11-16T15:07:19.000Z', usageTotalUsd: 0.2645 } });
    };
    assert.deepEqual(await apify.fetchRun('run-9'), {
      id: 'run-9', status: 'SUCCEEDED', datasetId: 'ds-9', statusMessage: null,
      startedAt: '2026-11-16T15:00:00.000Z', finishedAt: '2026-11-16T15:07:19.000Z', usdReal: 0.2645, chargedEventCounts: null,
    });
    await assert.rejects(apify.fetchRun('no-existe'), (err) => err.status === 404);
    assert.deepEqual(await apify.fetchRunCost('run-9'), { id: 'run-9', status: 'SUCCEEDED', usdReal: 0.2645, chargedEventCounts: null, finishedAt: '2026-11-16T15:07:19.000Z' });

    let intentos = 0;
    global.fetch = async () => {
      intentos += 1;
      return intentos < 3 ? respond(502, null, 'bad gateway') : respond(200, [{ id: 'z' }]);
    };
    assert.deepEqual(await apify.fetchDatasetItems('ds-9'), [{ id: 'z' }]);
    assert.equal(intentos, 3);
    assert.equal(filas().length, antes);
  });
});
