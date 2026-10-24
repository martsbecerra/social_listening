'use strict';

// GET /api/inicio (src/inicioRoutes.js): las tarjetas del inicio. Lo que
// importa: que los números de cada red sean los de Estadísticas para los
// últimos 7 días (y "hoy", el de los posteos publicados desde las 00:00 de
// Argentina), que una red fuera del cron no tenga próxima corrida ni alcance
// si no tiene benchmark, y que las corridas de hoy salgan con su estado real
// (una fila sin cerrar está "en curso" solo si es la del ciclo que corre; si
// no, quedó "interrumpida"), sin atribuirle a una red los números de un
// ciclo de varias redes.
// Base temporal; el registro de redes y el scheduler, de mentira.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-inicio-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
for (const name of Object.keys(process.env)) if (name.startsWith('REACH_')) delete process.env[name];

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const db = require('../src/db');
const stats = require('../src/stats');
const inicioRoutes = require('../src/inicioRoutes');

function enArgentina(fecha, hora, minuto = 0) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hora + 3, minuto)).toISOString();
}

const AHORA = Date.parse(enArgentina('2026-10-23', 15));
const PROXIMA = new Date(enArgentina('2026-10-23', 16));
const deps = {
  listPlatformIds: () => ['instagram', 'x'],
  getPlatform: (id) => ({ capabilities: { benchmark: id === 'instagram' } }),
  cronPlatforms: () => ['instagram'],
  nextRunAt: () => PROXIMA,
  runHours: () => [8, 12, 16, 20],
  runIdEnCurso: () => EN_CURSO,
  ahora: AHORA,
};
let EN_CURSO = null; // el id de la fila del ciclo que "corre"

let siguiente = 9000;
function guardar({ plataforma = 'instagram', postedAt, sentiment = null, likes = 10, comments = 2 }) {
  const id = String(siguiente++);
  const url = plataforma === 'x' ? `https://x.com/cuenta/status/${id}` : `https://www.instagram.com/p/C${id}/`;
  assert.equal(
    db.saveDetectedPost({ id, plataforma, url, account: 'cuenta', caption: 'texto', matchedReason: 'Búsqueda: x', sentiment, likes, comments, postedAt }),
    true
  );
}

before(() => {
  guardar({ postedAt: enArgentina('2026-10-23', 9), sentiment: 'positivo' });
  guardar({ postedAt: enArgentina('2026-10-23', 0, 1), sentiment: 'negativo' });
  guardar({ postedAt: enArgentina('2026-10-22', 23, 59), sentiment: null }); // ayer, sin tono: neutral
  guardar({ postedAt: enArgentina('2026-10-17', 12), sentiment: 'positivo' }); // el primer día de los 7
  guardar({ postedAt: enArgentina('2026-10-16', 12), sentiment: 'positivo' }); // fuera de los 7
  guardar({ plataforma: 'x', postedAt: enArgentina('2026-10-23', 8), sentiment: 'negativo' });

  const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);
  const run = raw.prepare(
    'INSERT INTO monitoring_runs (started_at, finished_at, "trigger", plataforma, new_posts, new_candidates, quota_exceeded) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  run.run(enArgentina('2026-10-22', 20), enArgentina('2026-10-22', 20, 6), 'cron', 'instagram', 3, 5, 0); // ayer
  run.run(enArgentina('2026-10-23', 8), enArgentina('2026-10-23', 8, 7), 'cron', 'instagram', 2, 4, 0);
  run.run(enArgentina('2026-10-23', 12), enArgentina('2026-10-23', 12, 3), 'cron', 'todas', 0, 1, 1); // cortada por cuota
  run.run(enArgentina('2026-10-23', 13), null, 'manual', 'x', 0, null, 0); // de X
  run.run(enArgentina('2026-10-23', 10, 30), null, 'manual', 'instagram', 0, null, 0); // se cayó el proceso: sin cerrar
  EN_CURSO = Number(run.run(enArgentina('2026-10-23', 14, 50), null, 'manual', 'instagram', 0, null, 0).lastInsertRowid); // en curso
  raw.close();
});

describe('GET /api/inicio', { concurrency: false }, () => {
  test('cada red trae los números de Estadísticas para los últimos 7 días', () => {
    const r = inicioRoutes.armarInicio(deps);
    assert.equal(r.hoy, '2026-10-23');
    assert.deepEqual(r.runHours, [8, 12, 16, 20]);
    const ig = r.redes.find((x) => x.id === 'instagram');
    const s = stats.armarEstadisticas({ plataforma: 'instagram', desde: '2026-10-17', hasta: '2026-10-23', conAlcance: true, ahora: AHORA });
    assert.equal(ig.hoy, 2); // publicadas desde las 00:00 de hoy
    assert.equal(ig.sieteDias.publicaciones, s.resumen.relevantes);
    assert.equal(ig.sieteDias.publicaciones, 4); // del 17 al 23
    assert.equal(ig.sieteDias.seDespegaron, s.resumen.seDespegaron);
    assert.equal(ig.sieteDias.positivoPct, 50); // 2 de 4: sin tono cuenta como neutral, como en Estadísticas
    assert.equal(ig.sieteDias.negativoPct, 25);
    assert.deepEqual(ig.sieteDias.porDia.map((d) => d.total), s.porDia.map((d) => d.total));
    assert.equal(ig.enCron, true);
    assert.equal(ig.nextRunAt, PROXIMA.toISOString());
    assert.ok(ig.lastRun, 'la última corrida terminada');
    assert.equal(ig.lastRunAt, enArgentina('2026-10-23', 12, 3));
  });

  test('una red fuera del cron no tiene próxima corrida, y sin benchmark no hay alcance', () => {
    const x = inicioRoutes.armarInicio(deps).redes.find((r) => r.id === 'x');
    assert.equal(x.enCron, false);
    assert.equal(x.nextRunAt, null);
    assert.equal(x.hoy, 1);
    assert.equal(x.sieteDias.seDespegaron, null);
  });

  test('las corridas de hoy, con su estado real', () => {
    const ig = inicioRoutes.armarInicio(deps).redes.find((r) => r.id === 'instagram');
    assert.deepEqual(
      ig.corridasHoy.map((c) => [c.startedAt, c.estado, c.nuevas, c.guardadas, c.trigger]),
      [
        [enArgentina('2026-10-23', 8), 'ok', 4, 2, 'cron'],
        [enArgentina('2026-10-23', 10, 30), 'interrumpida', null, null, 'manual'], // sin cerrar y no es la que corre
        // "todas" también es de Instagram, pero sus números son de todo el ciclo
        [enArgentina('2026-10-23', 12), 'cortada', null, null, 'cron'],
        [enArgentina('2026-10-23', 14, 50), 'en curso', null, null, 'manual'],
      ]
    );
  });

  test('sin ningún ciclo corriendo, ninguna fila sin cerrar está "en curso"', () => {
    const ig = inicioRoutes.armarInicio({ ...deps, runIdEnCurso: () => null }).redes.find((r) => r.id === 'instagram');
    assert.deepEqual(
      ig.corridasHoy.filter((c) => !c.finishedAt).map((c) => c.estado),
      ['interrumpida', 'interrumpida']
    );
  });

  test('la ruta responde el mismo JSON', async () => {
    const app = express();
    inicioRoutes.register(app, deps);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/inicio`);
      assert.equal(res.status, 200);
      const r = await res.json();
      assert.deepEqual(r.redes.map((x) => x.id), ['instagram', 'x']);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
