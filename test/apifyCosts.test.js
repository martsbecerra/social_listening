'use strict';

// Medición del gasto en Apify (src/apifyCost.js + tablas apify_calls y
// monitoring_runs en src/db.js + contexto de src/usageContext.js): usd por
// plan, registro de cada llamada de runActorSync (exitosa, fallida, cuota),
// totales por ciclo y por fase, ventanas del reporte y proyección, y que
// una falla al registrar nunca rompe la llamada. Sin red: fetch stubeado.
// Base y config temporales.

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
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_RETRY_DELAY_MS = '5';
// Tarifas y plan por default, sin lo que pueda haber en el entorno.
delete process.env.APIFY_RATE_FREE;
delete process.env.APIFY_RATE_STARTER;
delete process.env.APIFY_RATE_SCALE;
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

const raw = new DatabaseSync(DB_PATH, { readOnly: true });
const allCalls = () => raw.prepare('SELECT * FROM apify_calls ORDER BY id').all();
const lastCall = () => allCalls().at(-1);
const respond = (status, text = '', items = []) => ({ ok: status < 400, status, text: async () => text, json: async () => items });
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe('costo de Apify', { concurrency: false }, () => {
  test('usdForItems: tarifa por plan desde el .env o los defaults; plan desconocido cae a starter', () => {
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

  test('runActorSync registra cada llamada: items (con los de error), fase y ciclo del contexto, fallos y cuota', async () => {
    const originalFetch = global.fetch;
    try {
      // Exitosa dentro de un ciclo: 3 items, uno de error (se cobra igual).
      global.fetch = async () => respond(200, '', [{ id: 1 }, { id: 2 }, { error: 'no_items' }]);
      const items = await runWithContext({ runId: 42, phase: 'monitoreo' }, () =>
        runActorSync({ directUrls: ['https://www.instagram.com/gcba/'], resultsType: 'posts', resultsLimit: 15 }, { actorId: 'apify~instagram-scraper', plataforma: 'instagram' })
      );
      assert.equal(items.length, 3);
      let row = lastCall();
      assert.equal(row.run_id, 42);
      assert.equal(row.phase, 'monitoreo');
      assert.equal(row.plataforma, 'instagram');
      assert.equal(row.target, 'https://www.instagram.com/gcba/');
      assert.equal(row.results_type, 'posts');
      assert.equal(row.items, 3);
      assert.equal(row.ok, 1);
      assert.equal(row.error, null);
      assert.ok(row.duration_ms >= 0);
      near(row.usd, (3 * 2.3) / 1000);
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

      // Cuota agotada: error = 'QUOTA_EXCEEDED', con la fase del caller.
      global.fetch = async () => respond(403, '{"error":{"type":"actor-disabled","message":"Monthly usage hard limit exceeded"}}');
      await assert.rejects(runWithContext({ phase: 'validacion' }, () => runActorSync({ directUrls: ['https://www.instagram.com/y/'], resultsType: 'posts' })));
      row = lastCall();
      assert.equal(row.error, 'QUOTA_EXCEEDED');
      assert.equal(row.phase, 'validacion');
      assert.equal(row.run_id, null);
      assert.equal(allCalls().length, 3);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('monitoring_runs: los totales suman las apify_calls del ciclo por fase y marcan la cuota; la línea [costo] va en resultados', () => {
    const runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'todas' });
    assert.ok(runId > 0);
    const call = (phase, items, extra = {}) =>
      apifyCost.recordApifyCall({ runId, phase, plataforma: 'instagram', input: { directUrls: ['u'], resultsType: 'posts' }, items, ok: true, ...extra });
    call('monitoreo', 15);
    call('monitoreo', 15);
    call('benchmark', 15);
    call('refresco', 0, { ok: false, error: 'QUOTA_EXCEEDED' });
    apifyCost.recordApifyCall({ runId: runId + 1000, phase: 'monitoreo', items: 99, ok: true }); // otro ciclo: no cuenta

    const run = db.finishMonitoringRun(runId, { newPosts: 4 });
    assert.equal(run.calls, 4);
    assert.equal(run.results, 45);
    near(run.usd, (45 * 2.3) / 1000);
    assert.equal(run.quotaExceeded, true);
    assert.deepEqual(Object.keys(run.porFase).sort(), ['benchmark', 'monitoreo', 'refresco']);
    assert.equal(run.porFase.monitoreo.results, 30);
    assert.equal(run.porFase.benchmark.results, 15);
    assert.equal(run.porFase.refresco.calls, 1);

    const saved = db.getMonitoringRun(runId);
    assert.equal(saved.trigger, 'cron');
    assert.equal(saved.plataforma, 'todas');
    assert.equal(saved.newPosts, 4);
    assert.equal(saved.calls, 4);
    assert.equal(saved.results, 45);
    assert.equal(saved.quotaExceeded, true);
    assert.ok(saved.finishedAt >= saved.startedAt);

    assert.equal(
      apifyCost.formatCycleCostLine(run),
      `[costo] ciclo #${runId}: 4 llamadas, 45 resultados ≈ US$ 0.10 (monitoreo 30 · benchmark 15 · refresco 0)`
    );
    // Un ciclo sin llamadas también cierra bien.
    const empty = db.finishMonitoringRun(db.startMonitoringRun({ trigger: 'manual', plataforma: 'x' }), { newPosts: 0 });
    assert.equal(empty.calls, 0);
    assert.match(apifyCost.formatCycleCostLine(empty), /0 llamadas, 0 resultados ≈ US\$ 0\.00 \(monitoreo 0 · benchmark 0 · refresco 0\)/);
  });

  test('summarizeCosts: ventanas hoy / 7 / N días por fase, usd en las tres tarifas y proyección mensual', () => {
    const now = Date.now();
    const call = (daysAgo, phase, items, ok = true) =>
      apifyCost.recordApifyCall({ at: new Date(now - daysAgo * DAY_MS).toISOString(), phase, plataforma: 'instagram', items, ok, error: ok ? null : 'x' });
    // Lo registrado por los tests anteriores queda con `at` = ahora; acá se
    // agregan filas a distancias conocidas y se mide por diferencias.
    const before = apifyCost.summarizeCosts({ days: 30, now });
    call(0.1, 'analisis', 100); // hoy (2.4 h atrás) -- puede caer en "ayer" si el test corre justo después de medianoche: se tolera abajo
    call(3, 'monitoreo', 700);
    call(10, 'benchmark', 1000, false);
    call(40, 'refresco', 5000);

    const after = apifyCost.summarizeCosts({ days: 30, now });
    assert.equal(after.plan, 'starter');
    assert.deepEqual(after.rates, { free: 2.7, starter: 2.3, scale: 1.9 });
    assert.equal(after.ultimos7.results - before.ultimos7.results, 800);
    assert.equal(after.ultimos7.calls - before.ultimos7.calls, 2);
    assert.equal(after.ventana.days, 30);
    assert.equal(after.ventana.results - before.ventana.results, 1800, 'la de 40 días queda afuera de 30');
    assert.equal(after.ventana.failed - before.ventana.failed, 1);
    assert.equal(after.ventana.porFase.benchmark.results - (before.ventana.porFase.benchmark || { results: 0 }).results, 1000);
    const benchResults = after.ventana.porFase.benchmark.results;
    near(after.ventana.porFase.benchmark.usd.free, (benchResults * 2.7) / 1000);
    near(after.ventana.porFase.benchmark.usd.starter, (benchResults * 2.3) / 1000);
    near(after.ventana.porFase.benchmark.usd.scale, (benchResults * 1.9) / 1000);
    near(after.ventana.usd.starter, (after.ventana.results * 2.3) / 1000);
    near(after.ventana.usd.free, (after.ventana.results * 2.7) / 1000);
    near(after.ventana.usd.scale, (after.ventana.results * 1.9) / 1000);
    const wide = apifyCost.summarizeCosts({ days: 60, now });
    assert.equal(wide.ventana.results - after.ventana.results, 5000, 'con 60 días entra la de 40');
    assert.equal(wide.ventana.label, 'últimos 60 días');
    // "hoy" nunca incluye lo de hace 3 días ni más.
    assert.ok(after.hoy.results <= after.ultimos7.results - 700);
    // Proyección: promedio diario de los últimos 7 × 30.
    near(after.proyeccionMensual.results, Math.round((after.ultimos7.results / 7) * 30));
    near(after.proyeccionMensual.usd.starter, ((after.ultimos7.results / 7) * 30 * 2.3) / 1000);
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

  test('ciclo completo (scheduler): la llamada del monitoreo queda con run_id y fase, y la fila del ciclo se cierra con trigger y totales', async () => {
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
    assert.ok(calls[0].run_id > 0);
    assert.equal(calls[0].items, 0);
    const run = db.getMonitoringRun(calls[0].run_id);
    assert.equal(run.trigger, 'cron');
    assert.equal(run.plataforma, 'instagram');
    assert.ok(run.finishedAt);
    assert.equal(run.calls, 1);
    assert.equal(run.results, 0);
    assert.equal(run.quotaExceeded, false);
    assert.ok(lines.some((l) => l === `[costo] ciclo #${run.id}: 1 llamadas, 0 resultados ≈ US$ 0.00 (monitoreo 0 · benchmark 0 · refresco 0)`), lines.join('\n'));
  });
});
