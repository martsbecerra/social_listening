'use strict';

// apify_calls con estado (noviembre 2026, openspec/changes/
// ventana-por-fuente): cada fila guarda cómo quedó la llamada, el tope
// pedido y el `until`; una fila se puede abrir cuando Apify devuelve el run
// y cerrar al terminar. Base temporal; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-apify-estado-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.APIFY_PLAN = 'starter';
for (const key of Object.keys(process.env)) {
  if (/^(APIFY_RATE_|APIDOJO_)/.test(key)) delete process.env[key];
}

// Una base anterior: apify_calls sin estado, max_items ni until, con una fila.
const vieja = new DatabaseSync(DB_PATH);
vieja.exec(`
  CREATE TABLE apify_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id INTEGER, phase TEXT NOT NULL, plataforma TEXT NOT NULL,
    target TEXT, results_type TEXT, items INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, error TEXT,
    duration_ms INTEGER, usd REAL NOT NULL DEFAULT 0, actor TEXT, query_type TEXT, usd_real REAL, apify_run_id TEXT, analisis_id INTEGER
  )
`);
vieja.prepare("INSERT INTO apify_calls (at, run_id, phase, plataforma, target, items, ok, error, usd, actor, query_type) VALUES ('2026-11-06T15:00:00.000Z', 55, 'busqueda', 'instagram', 'macri', 0, 0, 'TIMEOUT', 0, 'apidojo~instagram-scraper-api', 'search')").run();
vieja.close();

const db = require('../src/db');
const apifyCost = require('../src/apifyCost');

const APIDOJO = 'apidojo~instagram-scraper-api';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ≈ ${b}`);

describe('apify_calls: estado, tope y until', { concurrency: false }, () => {
  test('una base anterior gana las columnas y sus filas quedan sin estado', () => {
    const fila = db.getApifyCall(1);
    assert.equal(fila.target, 'macri');
    assert.equal(fila.estado, null);
    assert.equal(fila.max_items, null);
    assert.equal(fila.until, null);
    assert.equal(fila.ok, 0);
  });

  test('describeInput: el tope y el until de lo que se le pidió al actor', () => {
    assert.deepEqual(apifyCost.describeInput({ keywords: ['macri'], maxItems: 500, until: '2026-11-06' }), {
      target: 'macri',
      resultsType: null,
      maxItems: 500,
      until: '2026-11-06',
    });
    assert.deepEqual(apifyCost.describeInput({ directUrls: ['https://www.instagram.com/p/x/'], resultsType: 'posts' }), {
      target: 'https://www.instagram.com/p/x/',
      resultsType: 'posts',
      maxItems: null,
      until: null,
    });
    assert.equal(apifyCost.describeInput({ keywords: ['macri'], maxItems: 'muchos' }).maxItems, null);
  });

  test('recordApifyCall: guarda el estado (ok o error si no se dice), el tope y el until', () => {
    const okId = apifyCost.recordApifyCall({ runId: 60, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['macri'], maxItems: 50, until: '2026-11-15' }, items: 12, ok: true });
    const ok = db.getApifyCall(okId);
    assert.equal(ok.estado, 'ok');
    assert.equal(ok.max_items, 50);
    assert.equal(ok.until, '2026-11-15');
    near(ok.usd, 0.015 + 12 * 0.0005);

    const fallo = db.getApifyCall(apifyCost.recordApifyCall({ runId: 60, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['gcba'] }, ok: false, error: 'Apify respondió 502' }));
    assert.equal(fallo.estado, 'error');
    assert.equal(fallo.usd, 0);

    const esperando = db.getApifyCall(apifyCost.recordApifyCall({ runId: 60, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['pdlc'] }, ok: false, error: 'TIMEOUT', estado: 'esperando', apifyRunId: 'run-1' }));
    assert.equal(esperando.estado, 'esperando');
    assert.equal(esperando.apify_run_id, 'run-1');

    // Un run que Apify cortó y dejó algo: falló, pero lo que trajo se cobra.
    const parcial = db.getApifyCall(apifyCost.recordApifyCall({ runId: 60, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['x'] }, items: 30, ok: false, error: 'RUN_FAILED', estado: 'parcial', apifyRunId: 'run-2' }));
    assert.equal(parcial.ok, 0);
    near(parcial.usd, 0.015 + 30 * 0.0005);
  });

  test('openApifyCall deja la fila en curso con su run; closeApifyCall la completa sin tocar el run ni la fase', () => {
    const input = { keywords: ['jorgemacri'], maxItems: 100, until: '2026-11-14' };
    const id = apifyCost.openApifyCall({ runId: 61, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input, apifyRunId: 'run-abierto' });
    let fila = db.getApifyCall(id);
    assert.equal(fila.estado, 'en_curso');
    assert.equal(fila.apify_run_id, 'run-abierto');
    assert.equal(fila.ok, 0);
    assert.equal(fila.items, 0);
    assert.equal(fila.usd, 0);
    assert.equal(fila.max_items, 100);

    // La conciliación ya la ve: tiene run y no tiene costo real.
    const pendientes = db.listApifyCallsPendingRealCost({ olderThanIso: new Date(Date.now() + 1000).toISOString(), newerThanIso: new Date(Date.now() - 60000).toISOString() });
    assert.ok(pendientes.some((p) => p.apifyRunId === 'run-abierto'));

    assert.equal(apifyCost.closeApifyCall(id, { phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input, items: 40, ok: true, durationMs: 1234.6 }), id);
    fila = db.getApifyCall(id);
    assert.equal(fila.estado, 'ok');
    assert.equal(fila.ok, 1);
    assert.equal(fila.items, 40);
    assert.equal(fila.duration_ms, 1235);
    assert.equal(fila.apify_run_id, 'run-abierto');
    assert.equal(fila.run_id, 61);
    near(fila.usd, 0.015 + 40 * 0.0005);
  });

  test('closeApifyCall sin fila abierta (o con un id que no existe) registra una nueva: la llamada no se pierde', () => {
    const call = { runId: 62, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['blacri'] }, items: 0, ok: false, error: 'TIMEOUT', estado: 'esperando', apifyRunId: 'run-3' };
    const nuevo = apifyCost.closeApifyCall(null, call);
    assert.equal(db.getApifyCall(nuevo).estado, 'esperando');
    const otro = apifyCost.closeApifyCall(987654, call);
    assert.notEqual(otro, 987654);
    assert.equal(db.getApifyCall(otro).apify_run_id, 'run-3');
  });
});
