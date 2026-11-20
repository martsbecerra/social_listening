'use strict';

// Completado único de las corridas anteriores a monitoring_run_sources
// (noviembre 2026, openspec/changes/ventana-por-fuente): al cargar db.js
// sobre una base que ya tenía corridas, cada consulta de detección de
// apify_calls pasa a ser una fila, `fallo` si la llamada había fallado. Así
// las corridas viejas con búsquedas caídas dejan de figurar "ok". Se hace
// una sola vez. Base temporal armada a mano antes del require.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fuentes-migracion-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH; // ANTES de cargar db.js

const APIDOJO = 'apidojo~instagram-scraper-api';
const vieja = new DatabaseSync(DB_PATH);
vieja.exec(`
  CREATE TABLE monitoring_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, "trigger" TEXT NOT NULL, plataforma TEXT NOT NULL,
    new_posts INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, results INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
    quota_exceeded INTEGER NOT NULL DEFAULT 0, new_candidates INTEGER
  );
  CREATE TABLE apify_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id INTEGER, phase TEXT NOT NULL, plataforma TEXT NOT NULL,
    target TEXT, results_type TEXT, items INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, error TEXT,
    duration_ms INTEGER, usd REAL NOT NULL DEFAULT 0, actor TEXT, query_type TEXT, usd_real REAL, apify_run_id TEXT, analisis_id INTEGER
  );
`);
const corrida = vieja.prepare('INSERT INTO monitoring_runs (id, started_at, finished_at, "trigger", plataforma, quota_exceeded) VALUES (?, ?, ?, ?, ?, ?)');
const llamada = vieja.prepare(
  'INSERT INTO apify_calls (at, run_id, phase, plataforma, target, items, ok, error, duration_ms, actor, query_type, apify_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
// #54: todo bien. #56: dos de cuatro caídas. #2: cortada por cuota. #10: una corrida vieja con perfiles y hashtags.
corrida.run(54, '2026-11-04T19:00:00.000Z', '2026-11-04T19:05:00.000Z', 'cron', 'instagram', 0);
llamada.run('2026-11-04T19:00:20.000Z', 54, 'busqueda', 'instagram', 'macri', 3, 1, null, 20000, APIDOJO, 'search', 'run-a');
llamada.run('2026-11-04T19:00:30.000Z', 54, 'busqueda', 'instagram', 'GCBA', 0, 1, null, 30000, APIDOJO, 'search', 'run-b');
llamada.run('2026-11-04T19:01:00.000Z', 54, 'busqueda', 'instagram', 'https://www.instagram.com/p/x/', 2, 1, null, 9000, 'apify~instagram-scraper', 'post', null);
llamada.run('2026-11-04T19:02:00.000Z', 54, 'benchmark', 'instagram', 'https://www.instagram.com/medio/', 15, 1, null, 9000, APIDOJO, 'user', 'run-c');
corrida.run(56, '2026-11-16T15:00:00.000Z', '2026-11-16T15:06:00.000Z', 'cron', 'instagram', 0);
llamada.run('2026-11-16T15:00:05.000Z', 56, 'busqueda', 'instagram', 'blacri', 0, 1, null, 5000, APIDOJO, 'search', 'run-d');
llamada.run('2026-11-16T15:00:31.000Z', 56, 'busqueda', 'instagram', 'macri', 0, 0, 'Apify respondió 502: <html>Bad Gateway</html>', 31000, APIDOJO, 'search', null);
llamada.run('2026-11-16T15:05:00.000Z', 56, 'busqueda', 'instagram', 'GCBA', 0, 0, 'TIMEOUT', 300000, APIDOJO, 'search', null);
llamada.run('2026-11-16T15:00:09.000Z', 56, 'busqueda', 'instagram', 'blackri', 1, 1, null, 9000, APIDOJO, 'search', 'run-e');
corrida.run(2, '2026-09-24T11:00:00.000Z', '2026-09-24T11:03:00.000Z', 'cron', 'todas', 1);
llamada.run('2026-09-24T11:00:10.000Z', 2, 'busqueda', 'instagram', 'macri', 0, 0, 'QUOTA_EXCEEDED', 1000, APIDOJO, 'search', null);
corrida.run(10, '2026-09-10T11:00:00.000Z', '2026-09-10T11:03:00.000Z', 'cron', 'instagram', 0);
llamada.run('2026-09-10T11:00:10.000Z', 10, 'monitoreo', 'instagram', 'https://www.instagram.com/gcba/', 10, 1, null, 8000, APIDOJO, 'user', 'run-f');
llamada.run('2026-09-10T11:00:12.000Z', 10, 'monitoreo', 'instagram', 'https://www.instagram.com/explore/tags/JorgeMacri/', 30, 1, null, 9000, APIDOJO, 'hashtag', 'run-g');
// Una llamada de un ciclo que ya no existe y una sin ciclo (validación): no generan filas.
llamada.run('2026-09-01T11:00:10.000Z', 999, 'busqueda', 'instagram', 'macri', 0, 1, null, 1000, APIDOJO, 'search', null);
llamada.run('2026-09-01T11:00:10.000Z', null, 'validacion', 'instagram', 'https://www.instagram.com/x/', 1, 1, null, 1000, APIDOJO, 'user', null);
vieja.close();

const originalLog = console.log;
const logs = [];
console.log = (...args) => logs.push(args.join(' '));
const db = require('../src/db');
console.log = originalLog;
const rs = require('../src/runStatus');

const estadoDe = (id) => {
  const run = db.getMonitoringRun(id);
  return rs.estadoCorrida(run, db.listRunSources({ runId: id, plataforma: 'instagram' }));
};

test('las consultas de detección de las corridas anteriores pasan a ser filas; el detalle y el benchmark no', () => {
  assert.ok(logs.some((l) => /fuentes por corrida: 9 consulta\(s\) de corridas anteriores registradas/.test(l)), logs.join('\n'));
  const de54 = db.listRunSources({ runId: 54, plataforma: 'instagram' });
  assert.deepEqual(de54.map((f) => [f.tipo, f.fuente, f.clave, f.estado, f.items, f.apifyRunId]), [
    ['busqueda', 'macri', 'macri', 'ok', 3, 'run-a'],
    ['busqueda', 'GCBA', 'gcba', 'ok', 0, 'run-b'],
  ]);
  assert.equal(de54[0].startedAt, '2026-11-04T19:00:00.000Z', 'el inicio sale del fin menos la duración');
  assert.equal(de54[0].finishedAt, '2026-11-04T19:00:20.000Z');
  assert.equal(de54[0].duracionMs, 20000);
  assert.equal(db.listRunSources({ runId: 999, plataforma: 'instagram' }).length, 0);
});

test('una corrida vieja con búsquedas caídas deja de figurar ok; la cortada por cuota sigue cortada', () => {
  assert.equal(estadoDe(54), 'ok');
  assert.equal(estadoDe(56), 'incompleta');
  assert.equal(estadoDe(2), 'cortada');
  const de56 = db.listRunSources({ runId: 56, plataforma: 'instagram' });
  assert.deepEqual(de56.filter((f) => f.estado === 'fallo').map((f) => [f.fuente, f.motivo, f.detalle]), [
    ['macri', 'HTTP_502', 'Apify respondió 502: Bad Gateway'],
    ['GCBA', 'TIMEOUT', 'TIMEOUT'],
  ]);
  assert.equal(rs.resumenFallidas(de56).titulo, 'Fallaron 2 de 4 búsquedas');
});

test('las corridas de antes de las búsquedas: perfiles y hashtags de la fase monitoreo', () => {
  const de10 = db.listRunSources({ runId: 10, plataforma: 'instagram' });
  assert.deepEqual(de10.map((f) => [f.tipo, f.fuente, f.clave]), [
    ['cuenta', 'gcba', 'gcba'],
    ['hashtag', 'JorgeMacri', 'jorgemacri'],
  ]);
  assert.equal(estadoDe(10), 'ok');
});

test('se hace una sola vez: volver a cargar db.js no duplica ni vuelve a mirar', () => {
  assert.ok(db.getRefreshState('fuentes_por_corrida_backfill'));
  const raw = new DatabaseSync(DB_PATH);
  const contar = () => raw.prepare('SELECT COUNT(*) AS n FROM monitoring_run_sources').get().n;
  assert.equal(contar(), 9);
  // Una fila nueva de apify_calls de una corrida sin filas: si el completado volviera a correr, la tomaría.
  raw.prepare('INSERT INTO monitoring_runs (id, started_at, finished_at, "trigger", plataforma) VALUES (70, ?, ?, ?, ?)').run('2026-11-17T11:00:00.000Z', '2026-11-17T11:03:00.000Z', 'cron', 'instagram');
  raw.prepare("INSERT INTO apify_calls (at, run_id, phase, plataforma, target, items, ok, actor, query_type) VALUES ('2026-11-17T11:00:10.000Z', 70, 'busqueda', 'instagram', 'macri', 0, 0, ?, 'search')").run(APIDOJO);
  delete require.cache[require.resolve('../src/db')];
  require('../src/db');
  assert.equal(contar(), 9);
  raw.close();
});
