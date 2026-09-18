'use strict';

// Medición del gasto en Apify (src/apifyCost.js + tablas apify_calls y
// monitoring_runs en src/db.js + contexto de src/usageContext.js): usd por
// plan del actor oficial y por consulta del actor apidojo, tipo de consulta
// desde el input, registro de cada llamada de runActorSync (exitosa,
// fallida, cuota), el flujo asincrónico con costo real (usd_real y run id),
// totales por ciclo, fase y actor, la línea [costo] con la fase busqueda,
// ventanas del reporte y proyección, y que una falla al registrar nunca
// rompe la llamada. Sin red: fetch stubeado. Base y config temporales.
// IG_ACTOR=apify para el ciclo del scheduler (el stub de fetch simula al
// actor oficial); el actor apidojo se ejercita llamando a runActorSync con
// su id.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-costo-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.IG_ACTOR = 'apify';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_RETRY_DELAY_MS = '5';
// Tarifas y plan por default, sin lo que pueda haber en el entorno.
for (const key of Object.keys(process.env)) {
  if (/^(APIFY_RATE_|APIDOJO_)/.test(key)) delete process.env[key];
}
delete process.env.APIFY_REAL_COST;
process.env.APIFY_PLAN = 'starter';

fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: ['trackeada'], keywords: ['obras'] } }, null, 2) + '\n'
);

const db = require('../src/db');
const apifyCost = require('../src/apifyCost');
const { runActorSync } = require('../src/apify');
const { runWithContext, getContext } = require('../src/usageContext');
const scheduler = require('../src/scheduler');

const OFICIAL = 'apify~instagram-scraper';
const APIDOJO = 'apidojo~instagram-scraper-api';
const raw = new DatabaseSync(DB_PATH, { readOnly: true });
const allCalls = () => raw.prepare('SELECT * FROM apify_calls ORDER BY id').all();
const lastCall = () => allCalls().at(-1);
const respond = (status, text = '', body = []) => ({ ok: status < 400, status, text: async () => text, json: async () => body });
const DAY_MS = 24 * 60 * 60 * 1000;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ≈ ${b}`);

describe('costo de Apify', { concurrency: false }, () => {
  test('actor oficial: tarifa por plan desde el .env o los defaults; plan desconocido cae a starter', () => {
    assert.deepEqual(apifyCost.getRates(), { free: 2.7, starter: 2.3, scale: 1.9 });
    assert.equal(apifyCost.getActivePlan(), 'starter');
    near(apifyCost.usdForItems(1000), 2.3);
    near(apifyCost.usdForItems(1000, 'free'), 2.7);
    near(apifyCost.usdForItems(1000, 'scale'), 1.9);
    near(apifyCost.usdForItems(15), 0.0345);
    assert.equal(apifyCost.usdForItems(0), 0);
    assert.equal(apifyCost.usdForItems(null), 0);
    assert.deepEqual(apifyCost.usdByPlan(2000), { free: 5.4, starter: 4.6, scale: 3.8 });

    process.env.APIFY_RATE_STARTER = '1.00';
    process.env.APIFY_PLAN = 'free';
    near(apifyCost.usdForItems(1000, 'starter'), 1);
    assert.equal(apifyCost.getActivePlan(), 'free');
    near(apifyCost.usdForItems(1000), 2.7);
    process.env.APIFY_PLAN = 'enterprise';
    assert.equal(apifyCost.getActivePlan(), 'starter');
    process.env.APIFY_RATE_STARTER = 'no-es-numero';
    near(apifyCost.usdForItems(1000, 'starter'), 2.3);
    delete process.env.APIFY_RATE_STARTER;
    process.env.APIFY_PLAN = 'starter';
  });

  test('actor apidojo: tipo de consulta desde el input y usd = tarifa de la consulta + posteos por encima de los incluidos', () => {
    const q = apifyCost.queryTypeFor;
    assert.equal(q(APIDOJO, { startUrls: ['https://www.instagram.com/clavescom/'], maxItems: 10 }), 'user');
    assert.equal(q(APIDOJO, { startUrls: ['https://www.instagram.com/explore/tags/JorgeMacri/'] }), 'hashtag');
    assert.equal(q(APIDOJO, { startUrls: ['https://www.instagram.com/explore/search/keyword/?q=macri'] }), 'search');
    assert.equal(q(APIDOJO, { keywords: ['jorge macri'] }), 'search');
    assert.equal(q(APIDOJO, { startUrls: ['https://www.instagram.com/p/DdZ-cSNNpZu/'] }), 'post');
    assert.equal(q(APIDOJO, { startUrls: ['https://www.instagram.com/reel/DdZ-cSNNpZu/'] }), 'post');
    assert.equal(q(APIDOJO, {}), null);
    assert.equal(q(OFICIAL, { directUrls: ['https://www.instagram.com/clavescom/'], resultsType: 'details' }), 'details');
    assert.equal(q(OFICIAL, { directUrls: ['https://www.instagram.com/clavescom/'], resultsType: 'posts' }), 'user');
    assert.equal(q(OFICIAL, { directUrls: ['https://www.instagram.com/p/abc/'], resultsType: 'comments' }), 'post');
    assert.equal(q(null, { directUrls: [{ url: 'https://www.instagram.com/explore/tags/caba/' }] }), 'hashtag');

    const rates = apifyCost.getApidojoRates();
    assert.deepEqual(rates, { user: 0.005, hashtag: 0.015, search: 0.015, post: 0.005, item: 0.0005, included: { user: 10, hashtag: 30, search: 20 } });
    near(apifyCost.usdForApidojo('user', 10), 0.005);
    near(apifyCost.usdForApidojo('user', 0), 0.005, 'sin posteos igual se paga la consulta');
    near(apifyCost.usdForApidojo('user', 15), 0.0075);
    near(apifyCost.usdForApidojo('hashtag', 30), 0.015);
    near(apifyCost.usdForApidojo('hashtag', 45), 0.0225);
    near(apifyCost.usdForApidojo('search', 50), 0.03);
    near(apifyCost.usdForApidojo('search', 2), 0.015);
    near(apifyCost.usdForApidojo('post', 1), 0.005);
    near(apifyCost.usdForApidojo('post', 40), 0.005, 'posteo suelto: tarifa plana');
    near(apifyCost.usdForApidojo('cualquiera', 12), 0.006, 'tipo desconocido se valúa como perfil');
    near(apifyCost.usdForCall({ actor: APIDOJO, queryType: 'hashtag', items: 31 }), 0.0155);
    near(apifyCost.usdForCall({ actor: OFICIAL, queryType: 'hashtag', items: 31 }), (31 * 2.3) / 1000, 'el oficial sigue por resultados');
    near(apifyCost.usdForCall({ actor: null, queryType: 'user', items: 10 }), (10 * 2.3) / 1000, 'sin actor = oficial (filas viejas)');

    process.env.APIDOJO_RATE_USER = '0.004';
    process.env.APIDOJO_INCLUDED_USER = '20';
    process.env.APIDOJO_RATE_ITEM = 'nada';
    near(apifyCost.usdForApidojo('user', 25), 0.004 + 5 * 0.0005);
    delete process.env.APIDOJO_RATE_USER;
    delete process.env.APIDOJO_INCLUDED_USER;
    delete process.env.APIDOJO_RATE_ITEM;
    assert.equal(apifyCost.isOfficialActor(OFICIAL), true);
    assert.equal(apifyCost.isOfficialActor(undefined), true);
    assert.equal(apifyCost.isOfficialActor(APIDOJO), false);
    assert.equal(apifyCost.actorLabel(APIDOJO), 'apidojo/instagram-scraper-api');
  });

  test('usageContext: null afuera, se hereda y se combina, sobrevive a los await', async () => {
    assert.equal(getContext(), null);
    await runWithContext({ runId: 3, phase: 'monitoreo' }, async () => {
      await new Promise((r) => setTimeout(r, 2));
      assert.deepEqual(getContext(), { runId: 3, phase: 'monitoreo' });
      await runWithContext({ phase: 'benchmark' }, async () => {
        assert.deepEqual(getContext(), { runId: 3, phase: 'benchmark' });
      });
      assert.deepEqual(getContext(), { runId: 3, phase: 'monitoreo' });
    });
    assert.equal(getContext(), null);
  });

  test('runActorSync (oficial, sincrónico) registra cada llamada: items (con los de error), actor, tipo, fase y ciclo del contexto, fallos y cuota', async () => {
    const originalFetch = global.fetch;
    try {
      // Exitosa dentro de un ciclo: 3 items, uno de error (se cobra igual).
      global.fetch = async () => respond(200, '', [{ id: 1 }, { id: 2 }, { error: 'no_items' }]);
      const items = await runWithContext({ runId: 42, phase: 'monitoreo' }, () =>
        runActorSync({ directUrls: ['https://www.instagram.com/gcba/'], resultsType: 'posts', resultsLimit: 15 }, { actorId: OFICIAL, plataforma: 'instagram' })
      );
      assert.equal(items.length, 3);
      let row = lastCall();
      assert.equal(row.run_id, 42);
      assert.equal(row.phase, 'monitoreo');
      assert.equal(row.plataforma, 'instagram');
      assert.equal(row.actor, OFICIAL);
      assert.equal(row.query_type, 'user');
      assert.equal(row.target, 'https://www.instagram.com/gcba/');
      assert.equal(row.results_type, 'posts');
      assert.equal(row.items, 3);
      assert.equal(row.ok, 1);
      assert.equal(row.error, null);
      assert.ok(row.duration_ms >= 0);
      near(row.usd, (3 * 2.3) / 1000);
      assert.equal(row.usd_real, null, 'el oficial va por el sincrónico: sin costo real');
      assert.equal(row.apify_run_id, null);
      assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);

      // Fallida (500): fila con ok 0, items 0, usd 0 y el mensaje.
      global.fetch = async () => respond(500, 'boom');
      await assert.rejects(runActorSync({ directUrls: ['https://www.instagram.com/x/'], resultsType: 'posts' }));
      row = lastCall();
      assert.equal(row.ok, 0);
      assert.equal(row.items, 0);
      assert.equal(row.usd, 0);
      assert.match(row.error, /Apify respondió 500/);
      assert.equal(row.run_id, null, 'fuera de un ciclo no hay run_id');
      assert.equal(row.phase, 'desconocida', 'sin contexto ni fase');
      assert.equal(row.actor, OFICIAL, 'sin actorId es el oficial');

      // Cuota agotada: error = 'QUOTA_EXCEEDED', con la fase del caller.
      global.fetch = async () => respond(403, '{"error":{"type":"actor-disabled","message":"Monthly usage hard limit exceeded"}}');
      await assert.rejects(runWithContext({ phase: 'validacion' }, () => runActorSync({ directUrls: ['https://www.instagram.com/y/'], resultsType: 'details' })));
      row = lastCall();
      assert.equal(row.error, 'QUOTA_EXCEEDED');
      assert.equal(row.phase, 'validacion');
      assert.equal(row.query_type, 'details');
      assert.equal(row.run_id, null);
      assert.equal(allCalls().length, 3);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('runActorSync (apidojo, flujo asincrónico): arranca el run, espera, lee el run final y los items; la fila queda con usd estimado, usd_real y run id', async () => {
    const originalFetch = global.fetch;
    const requests = [];
    let runStatusAfterWait = 'SUCCEEDED';
    let finalStatus = 'SUCCEEDED';
    let firstPostStatus = 200;
    const runObject = (status, extra = {}) => ({ data: { id: 'run-1', status, defaultDatasetId: 'ds-1', ...extra } });
    global.fetch = async (url, options = {}) => {
      requests.push({ method: options.method || 'GET', url });
      if (/\/acts\/apidojo~instagram-scraper-api\/runs\?token=token-de-test&waitForFinish=60$/.test(url)) {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { startUrls: ['https://www.instagram.com/clavescom/'], maxItems: 15 });
        if (firstPostStatus === 402) {
          firstPostStatus = 200;
          return respond(402, JSON.stringify({ error: { type: 'concurrent-runs-limit-exceeded', message: 'too many' } }));
        }
        return respond(200, '', runObject('RUNNING'));
      }
      if (/\/actor-runs\/run-1\?token=token-de-test&waitForFinish=60$/.test(url)) return respond(200, '', runObject(runStatusAfterWait));
      if (/\/actor-runs\/run-1\?token=token-de-test$/.test(url)) {
        return respond(200, '', runObject(finalStatus, { usageTotalUsd: 0.0071, chargedEventCounts: { 'user-query': 1, 'dataset-item': 2 }, statusMessage: finalStatus === 'FAILED' ? 'Actor crashed' : null }));
      }
      if (/\/datasets\/ds-1\/items\?token=token-de-test$/.test(url)) return respond(200, '', Array.from({ length: 12 }, (_, i) => ({ id: String(i) })));
      throw new Error(`request inesperada: ${url}`);
    };
    try {
      const input = { startUrls: ['https://www.instagram.com/clavescom/'], maxItems: 15 };
      const items = await runWithContext({ runId: 7, phase: 'benchmark' }, () => runActorSync(input, { actorId: APIDOJO, plataforma: 'instagram' }));
      assert.equal(items.length, 12);
      assert.deepEqual(
        requests.map((r) => `${r.method} ${r.url.replace(/token=[^&]+/, 'token=***')}`),
        [
          'POST https://api.apify.com/v2/acts/apidojo~instagram-scraper-api/runs?token=***&waitForFinish=60',
          'GET https://api.apify.com/v2/actor-runs/run-1?token=***&waitForFinish=60',
          'GET https://api.apify.com/v2/actor-runs/run-1?token=***',
          'GET https://api.apify.com/v2/datasets/ds-1/items?token=***',
        ]
      );
      let row = lastCall();
      assert.equal(row.run_id, 7);
      assert.equal(row.phase, 'benchmark');
      assert.equal(row.actor, APIDOJO);
      assert.equal(row.query_type, 'user');
      assert.equal(row.target, 'https://www.instagram.com/clavescom/');
      assert.equal(row.results_type, null);
      assert.equal(row.items, 12);
      assert.equal(row.ok, 1);
      near(row.usd, 0.005 + 2 * 0.0005, 'estimado: consulta de perfil + 2 posteos extra');
      near(row.usd_real, 0.0071);
      assert.equal(row.apify_run_id, 'run-1');

      // El run termina en FAILED: rechaza con el estado y el mensaje de Apify; la fila queda fallida con el run id.
      requests.length = 0;
      finalStatus = 'FAILED';
      await assert.rejects(runActorSync(input, { actorId: APIDOJO }), (err) => {
        assert.match(err.message, /run run-1 de Apify terminó en FAILED: Actor crashed/);
        assert.match(err.userMessage, /terminó en FAILED/);
        return true;
      });
      row = lastCall();
      assert.equal(row.ok, 0);
      assert.equal(row.usd, 0);
      assert.equal(row.usd_real, null);
      assert.equal(row.apify_run_id, 'run-1');
      assert.equal(requests.length, 3, 'sin lectura de items');
      finalStatus = 'SUCCEEDED';

      // 402 por runs simultáneos al arrancar el run: mismo reintento único que el sincrónico.
      requests.length = 0;
      firstPostStatus = 402;
      assert.equal((await runActorSync(input, { actorId: APIDOJO })).length, 12);
      assert.equal(requests.filter((r) => r.method === 'POST').length, 2, 'dos POST: el rechazado y el reintento');
      assert.equal(lastCall().ok, 1);

      // Sin espera intermedia (el POST ya devuelve terminado): igual se hace la lectura final.
      requests.length = 0;
      runStatusAfterWait = 'SUCCEEDED';
      await runActorSync(input, { actorId: APIDOJO });
      assert.equal(requests.length, 4);

      // APIFY_REAL_COST=0: vuelve al endpoint sincrónico, sin costo real.
      process.env.APIFY_REAL_COST = '0';
      global.fetch = async (url) => {
        requests.push({ method: 'POST', url });
        assert.match(url, /run-sync-get-dataset-items\?token=token-de-test$/);
        return respond(200, '', [{ id: 1 }]);
      };
      requests.length = 0;
      assert.deepEqual(await runActorSync(input, { actorId: APIDOJO }), [{ id: 1 }]);
      assert.equal(requests.length, 1);
      row = lastCall();
      assert.equal(row.actor, APIDOJO);
      near(row.usd, 0.005);
      assert.equal(row.usd_real, null);
      assert.equal(row.apify_run_id, null);
    } finally {
      delete process.env.APIFY_REAL_COST;
      global.fetch = originalFetch;
    }
  });

  test('monitoring_runs: los totales suman las apify_calls del ciclo por fase y actor, prefieren el costo real y marcan la cuota; la línea [costo] incluye busqueda', () => {
    const runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'todas' });
    assert.ok(runId > 0);
    const call = (phase, actor, input, items, extra = {}) =>
      apifyCost.recordApifyCall({ runId, phase, plataforma: 'instagram', actor, input, items, ok: true, ...extra });
    const perfil = { startUrls: ['https://www.instagram.com/a/'], maxItems: 10 };
    call('monitoreo', OFICIAL, { directUrls: ['u'], resultsType: 'posts' }, 15);
    call('monitoreo', OFICIAL, { directUrls: ['u'], resultsType: 'posts' }, 15);
    call('busqueda', APIDOJO, { keywords: ['jorge macri'], maxItems: 50 }, 20);
    call('benchmark', APIDOJO, { ...perfil, maxItems: 15 }, 15, { usdReal: 0.008, apifyRunId: 'r-9' });
    call('refresco', APIDOJO, perfil, 0, { ok: false, error: 'QUOTA_EXCEEDED' });
    apifyCost.recordApifyCall({ runId: runId + 1000, phase: 'monitoreo', items: 99, ok: true }); // otro ciclo: no cuenta

    const run = db.finishMonitoringRun(runId, { newPosts: 4 });
    assert.equal(run.calls, 5);
    assert.equal(run.results, 65);
    // oficial 30 res × 2.3/1000 = 0.069; búsqueda 0.015 (20 incluidos); benchmark: real 0.008 en vez del estimado 0.0075; refresco fallido 0.
    near(run.usd, 0.069 + 0.015 + 0.008);
    assert.equal(run.quotaExceeded, true);
    assert.deepEqual(Object.keys(run.porFase).sort(), ['benchmark', 'busqueda', 'monitoreo', 'refresco']);
    assert.equal(run.porFase.monitoreo.results, 30);
    near(run.porFase.monitoreo.usd, 0.069);
    assert.equal(run.porFase.busqueda.results, 20);
    assert.equal(run.porFase.benchmark.results, 15);
    near(run.porFase.benchmark.usd, 0.008);
    near(run.porFase.benchmark.porActor[APIDOJO].usd, 0.0075, 'el estimado queda aparte');
    near(run.porFase.benchmark.porActor[APIDOJO].usdReal, 0.008);
    assert.equal(run.porFase.benchmark.porActor[APIDOJO].withReal, 1);
    assert.equal(run.porFase.refresco.calls, 1);
    assert.equal(run.porFase.monitoreo.porActor[OFICIAL].calls, 2);

    const saved = db.getMonitoringRun(runId);
    assert.equal(saved.trigger, 'cron');
    assert.equal(saved.plataforma, 'todas');
    assert.equal(saved.newPosts, 4);
    assert.equal(saved.calls, 5);
    assert.equal(saved.results, 65);
    near(saved.usd, 0.092);
    assert.equal(saved.quotaExceeded, true);
    assert.ok(saved.finishedAt >= saved.startedAt);

    assert.equal(
      apifyCost.formatCycleCostLine(run),
      `[costo] ciclo #${runId}: 5 llamadas, 65 resultados ≈ US$ 0.09 (monitoreo 30 · busqueda 20 · benchmark 15 · refresco 0)`
    );
    // Un ciclo sin llamadas también cierra bien.
    const empty = db.finishMonitoringRun(db.startMonitoringRun({ trigger: 'manual', plataforma: 'x' }), { newPosts: 0 });
    assert.equal(empty.calls, 0);
    assert.match(apifyCost.formatCycleCostLine(empty), /0 llamadas, 0 resultados ≈ US\$ 0\.00 \(monitoreo 0 · busqueda 0 · benchmark 0 · refresco 0\)/);
  });

  test('summarizeCosts: ventanas hoy / 7 / N días por fase y por actor, oficial en las tres tarifas, apidojo real o estimado, total por plan y proyección', () => {
    const now = Date.now();
    const call = (daysAgo, phase, actor, input, items, extra = {}) =>
      apifyCost.recordApifyCall({ at: new Date(now - daysAgo * DAY_MS).toISOString(), phase, plataforma: 'instagram', actor, input, items, ok: true, ...extra });
    // Lo registrado por los tests anteriores queda con `at` = ahora; acá se
    // agregan filas a distancias conocidas y se mide por diferencias.
    const before = apifyCost.summarizeCosts({ days: 30, now });
    call(0.1, 'analisis', OFICIAL, { directUrls: ['https://www.instagram.com/p/x/'], resultsType: 'comments' }, 100);
    call(3, 'monitoreo', OFICIAL, { directUrls: ['u'], resultsType: 'posts' }, 700);
    call(3, 'busqueda', APIDOJO, { keywords: ['jorge macri'] }, 20, { usdReal: 0.014 });
    call(3, 'busqueda', APIDOJO, { keywords: ['larreta'] }, 40); // sin real: estimado 0.015 + 20×0.0005 = 0.025
    call(10, 'benchmark', OFICIAL, { directUrls: ['u'], resultsType: 'posts' }, 1000, { ok: false, error: 'x' });
    call(40, 'refresco', APIDOJO, { startUrls: ['https://www.instagram.com/a/'] }, 15, { usdReal: 0.0075 });

    const after = apifyCost.summarizeCosts({ days: 30, now });
    assert.equal(after.plan, 'starter');
    assert.deepEqual(after.rates, { free: 2.7, starter: 2.3, scale: 1.9 });
    assert.deepEqual(after.apidojoRates.included, { user: 10, hashtag: 30, search: 20 });
    assert.deepEqual(after.actores, { oficial: 'apify/instagram-scraper', apidojo: 'apidojo/instagram-scraper-api' });

    const d = (key, sel) => sel(after[key]) - sel(before[key]);
    assert.equal(d('ultimos7', (w) => w.results), 860);
    assert.equal(d('ultimos7', (w) => w.calls), 4);
    assert.equal(d('ultimos7', (w) => w.oficial.results), 800);
    assert.equal(d('ultimos7', (w) => w.apidojo.results), 60);
    assert.equal(d('ultimos7', (w) => w.apidojo.calls), 2);
    near(d('ultimos7', (w) => w.apidojo.usdEstimado), 0.015 + 0.025);
    near(d('ultimos7', (w) => w.apidojo.usdReal || 0), 0.014);
    assert.equal(d('ultimos7', (w) => w.apidojo.callsConReal), 1);
    near(d('ultimos7', (w) => w.apidojo.usd), 0.014 + 0.025, 'real donde existe, si no estimado');
    near(d('ultimos7', (w) => w.usd.starter), (800 * 2.3) / 1000 + 0.039, 'total por plan = oficial por plan + apidojo');
    near(d('ultimos7', (w) => w.usd.free), (800 * 2.7) / 1000 + 0.039);

    assert.equal(after.ventana.days, 30);
    assert.equal(d('ventana', (w) => w.results), 1860, 'la de 40 días queda afuera de 30');
    assert.equal(d('ventana', (w) => w.failed), 1);
    assert.equal(d('ventana', (w) => w.oficial.failed), 1);
    const bench = after.ventana.porFase.benchmark;
    assert.equal(bench.results - (before.ventana.porFase.benchmark || { results: 0 }).results, 1000);
    near(bench.oficial.usd.free, (bench.oficial.results * 2.7) / 1000);
    near(bench.oficial.usd.starter, (bench.oficial.results * 2.3) / 1000);
    near(bench.oficial.usd.scale, (bench.oficial.results * 1.9) / 1000);
    near(bench.usd.starter, bench.oficial.usd.starter + bench.apidojo.usd);
    const busq = after.ventana.porFase.busqueda;
    assert.equal(busq.calls - (before.ventana.porFase.busqueda || { calls: 0 }).calls, 2);
    near(busq.usd.starter - (before.ventana.porFase.busqueda || { usd: { starter: 0 } }).usd.starter, 0.039);
    near(after.ventana.usd.starter, after.ventana.oficial.usd.starter + after.ventana.apidojo.usd);

    const wide = apifyCost.summarizeCosts({ days: 60, now });
    assert.equal(wide.ventana.results - after.ventana.results, 15, 'con 60 días entra la de 40');
    assert.equal(wide.ventana.label, 'últimos 60 días');
    // "hoy" nunca incluye lo de hace 3 días ni más.
    assert.ok(after.hoy.results <= after.ultimos7.results - 760);
    // Proyección: promedio diario de los últimos 7 × 30, con el mismo desglose.
    assert.equal(after.proyeccionMensual.results, Math.round((after.ultimos7.results / 7) * 30));
    near(after.proyeccionMensual.usd.starter, (after.ultimos7.usd.starter / 7) * 30);
    near(after.proyeccionMensual.apidojo.usd, (after.ultimos7.apidojo.usd / 7) * 30);
    assert.equal(apifyCost.summarizeCosts({ days: 0, now }).ventana.days, 30, 'days inválido cae a 30');
  });

  test('una falla al registrar no rompe la llamada a Apify', async () => {
    const originalFetch = global.fetch;
    const originalInsert = db.insertApifyCall;
    const originalError = console.error;
    const logged = [];
    try {
      global.fetch = async () => respond(200, '', [{ id: 1 }]);
      db.insertApifyCall = () => {
        throw new Error('base bloqueada');
      };
      console.error = (...args) => logged.push(args.join(' '));
      assert.deepEqual(await runActorSync({ directUrls: ['u'], resultsType: 'posts' }), [{ id: 1 }]);
      assert.ok(logged.some((l) => l.includes('No se pudo registrar') && l.includes('base bloqueada')));
    } finally {
      global.fetch = originalFetch;
      db.insertApifyCall = originalInsert;
      console.error = originalError;
    }
  });

  test('ciclo completo (scheduler, IG_ACTOR=apify): la llamada del monitoreo queda con run_id, fase y actor, y la fila del ciclo se cierra con trigger y totales', async () => {
    const originalFetch = global.fetch;
    const originalLog = console.log;
    const lines = [];
    const callsBefore = allCalls().length;
    try {
      global.fetch = async () => respond(200, '', []); // la cuenta trackeada no trae nada
      console.log = (...args) => lines.push(args.join(' '));
      const result = await scheduler.runCycle({ plataforma: 'instagram', trigger: 'cron' });
      assert.equal(result.newCount, 0);
    } finally {
      global.fetch = originalFetch;
      console.log = originalLog;
    }
    const calls = allCalls().slice(callsBefore);
    assert.equal(calls.length, 1, 'una sola llamada: el scrape de la trackeada (sin posteos no hay benchmark ni refresco)');
    assert.equal(calls[0].phase, 'monitoreo');
    assert.equal(calls[0].actor, OFICIAL);
    assert.equal(calls[0].query_type, 'user');
    assert.ok(calls[0].run_id > 0);
    assert.equal(calls[0].items, 0);
    const run = db.getMonitoringRun(calls[0].run_id);
    assert.equal(run.trigger, 'cron');
    assert.equal(run.plataforma, 'instagram');
    assert.ok(run.finishedAt);
    assert.equal(run.calls, 1);
    assert.equal(run.results, 0);
    assert.equal(run.quotaExceeded, false);
    assert.ok(
      lines.some((l) => l === `[costo] ciclo #${run.id}: 1 llamadas, 0 resultados ≈ US$ 0.00 (monitoreo 0 · busqueda 0 · benchmark 0 · refresco 0)`),
      lines.join('\n')
    );
  });
});
