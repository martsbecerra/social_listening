'use strict';

// Pipeline del Monitoreo (diseño v4, fase B): el resumen de la última
// corrida terminada de una plataforma (src/lastRun.js, `lastRun` de
// /api/monitoring/status). monitoring_runs guarda los nuevos de la corrida
// (new_candidates, anulable); "traídas" son los resultados de las consultas
// de detección de ESA red en esa corrida (no el detalle ni el benchmark);
// "destacados", los posteos guardados en la ventana de la corrida con
// top.level 'alto' según la misma regla del listado. Base temporal; nunca
// toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-resumen-corrida-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
// La regla del alcance con sus valores por defecto (colchón 300 y piso 150
// en comentarios, alto desde 1,5), aunque el entorno traiga otros.
for (const name of Object.keys(process.env)) if (name.startsWith('REACH_')) delete process.env[name];
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [] } }, null, 2) + '\n');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Clasificador stubeado antes de cargar accountStats (que carga monitor.js).
const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 't', sentiment: 'neutral' });

const db = require('../src/db');
const { buildLastRun } = require('../src/lastRun');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

let postSeq = 0;
function guardar(account, comments, { ignorar = false } = {}) {
  postSeq += 1;
  const id = String(9000 + postSeq);
  db.saveDetectedPost({
    id,
    account,
    url: `https://www.instagram.com/p/codigo${postSeq}/`,
    caption: 'Jorge Macri en la Ciudad',
    likes: 10,
    comments,
    postType: 'imagen',
    plataforma: 'instagram',
  });
  if (ignorar) db.ignorePost(id, 'instagram');
  return id;
}

function llamada(runId, { phase, plataforma = 'instagram', queryType, items, usd = 0.015 }) {
  db.insertApifyCall({ runId, phase, plataforma, queryType, items, ok: true, usd, actor: 'apidojo~instagram-scraper-api', target: 't' });
}

// Una cuenta con mediana de 10 comentarios: 500 es alto ((500 + 300) /
// (10 + 300) = 2,58 y pasa el piso de 150); 12 no se despega.
db.upsertAccountStats({ account: 'medio', plataforma: 'instagram', postType: null, nPosts: 12, medianLikes: 10, medianComments: 10 });

describe('monitoring_runs.new_candidates', { concurrency: false }, () => {
  test('finishMonitoringRun lo guarda y getMonitoringRun lo devuelve; sin el dato queda null', () => {
    const conDato = db.startMonitoringRun({ trigger: 'manual', plataforma: 'x', startedAt: '2026-10-01T10:00:00.000Z' });
    db.finishMonitoringRun(conDato, { newPosts: 2, newCandidates: 9, finishedAt: '2026-10-01T10:01:00.000Z' });
    assert.equal(db.getMonitoringRun(conDato).newCandidates, 9);
    assert.equal(db.getMonitoringRun(conDato).newPosts, 2);

    const sinDato = db.startMonitoringRun({ trigger: 'manual', plataforma: 'x', startedAt: '2026-10-01T11:00:00.000Z' });
    db.finishMonitoringRun(sinDato, { newPosts: 0, finishedAt: '2026-10-01T11:01:00.000Z' });
    assert.equal(db.getMonitoringRun(sinDato).newCandidates, null, 'null es "sin dato", no 0');

    const cero = db.startMonitoringRun({ trigger: 'manual', plataforma: 'x', startedAt: '2026-10-01T12:00:00.000Z' });
    db.finishMonitoringRun(cero, { newPosts: 0, newCandidates: 0, finishedAt: '2026-10-01T12:01:00.000Z' });
    assert.equal(db.getMonitoringRun(cero).newCandidates, 0, 'un 0 de verdad se guarda como 0');
  });
});

describe('lastRun: resumen de la última corrida', { concurrency: false }, () => {
  test('una plataforma que nunca terminó una corrida: null', () => {
    assert.equal(db.getLastFinishedRun('instagram'), null);
    assert.equal(buildLastRun('instagram', { hasBenchmark: true }), null);
  });

  test('traídas, nuevas, guardadas, destacadas, duración y costo de la última corrida de esa red', async () => {
    guardar('medio', 900); // alto, pero guardado ANTES de la corrida: no es de ella
    await wait(10);
    const startedAt = new Date().toISOString();
    await wait(10);
    const runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram,x', startedAt });

    llamada(runId, { phase: 'busqueda', queryType: 'search', items: 50 });
    llamada(runId, { phase: 'busqueda', queryType: 'search', items: 30 });
    llamada(runId, { phase: 'busqueda', queryType: 'post', items: 10, usd: 0.023 }); // detalle: no es detección
    llamada(runId, { phase: 'benchmark', queryType: 'user', items: 15, usd: 0.005 }); // benchmark: tampoco
    llamada(runId, { phase: 'monitoreo', plataforma: 'x', queryType: 'search', items: 99 }); // otra red

    guardar('medio', 500); // alto
    guardar('medio', 12); // no se despega
    guardar('medio', 700, { ignorar: true }); // alto pero ignorado
    guardar('nadie', 5000); // sin mediana de la cuenta: sin referencia

    const finishedAt = new Date(Date.parse(startedAt) + 125000).toISOString();
    const cierre = db.finishMonitoringRun(runId, { newPosts: 4, newCandidates: 7, finishedAt });

    const lastRun = buildLastRun('instagram', { hasBenchmark: true });
    assert.equal(lastRun.finishedAt, finishedAt);
    assert.equal(lastRun.durationSec, 125);
    assert.equal(lastRun.fetched, 80, 'solo las búsquedas de Instagram de esta corrida');
    assert.equal(lastRun.newCandidates, 7);
    assert.equal(lastRun.saved, 4);
    assert.equal(lastRun.highlighted, 1, 'el alto de la corrida; ni el de antes ni el ignorado');
    near(lastRun.usd, cierre.usd, 'el costo de la fila del ciclo');

    assert.equal(buildLastRun('instagram').highlighted, null, 'sin benchmark en la red no hay destacados');
    assert.equal(buildLastRun('x').fetched, 99, 'la misma corrida vista desde X trae lo de X');
  });

  test('una corrida sin consultas de detección y sin new_candidates: "—" en la pantalla (null)', () => {
    const runId = db.startMonitoringRun({ trigger: 'manual', plataforma: 'instagram', startedAt: '2030-01-01T10:00:00.000Z' });
    db.finishMonitoringRun(runId, { newPosts: 0, finishedAt: '2030-01-01T10:00:30.000Z' });
    const lastRun = buildLastRun('instagram', { hasBenchmark: true });
    assert.equal(lastRun.fetched, null);
    assert.equal(lastRun.newCandidates, null);
    assert.equal(lastRun.saved, 0);
    assert.equal(lastRun.highlighted, 0);
    assert.equal(lastRun.durationSec, 30);
  });

  test('una corrida en curso no cuenta: vale la última terminada', () => {
    db.startMonitoringRun({ trigger: 'manual', plataforma: 'instagram', startedAt: '2030-01-02T10:00:00.000Z' });
    assert.equal(buildLastRun('instagram').finishedAt, '2030-01-01T10:00:30.000Z');
  });

  test('sin plataforma tira, como toda función por plataforma', () => {
    assert.throws(() => db.getLastFinishedRun(), /falta plataforma/);
    assert.throws(() => db.listPostsDetectedBetween('', 'a', 'b'), /falta plataforma/);
  });
});
