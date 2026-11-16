'use strict';

// Asentar corridas cortadas (scripts/costo-apify.js --asentar, noviembre
// 2026, openspec/changes/ventana-por-fuente). Antes del cambio, una búsqueda
// que la app cortaba por tiempo dejaba la fila fallida, con usd 0 y sin run,
// aunque la corrida terminara en Apify y se cobrara (ciclos #55 y #56 del
// piloto: once corridas, US$ 1,5775). El asiento anota el run y el costo
// real en esa fila, sin importar publicaciones. También: las corridas del
// actor que están en Apify y la app no registró. Base temporal; fetch
// simulado; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-asentar-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.APIFY_API_TOKEN = 'token-de-test';
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], searches: ['macri'] }, x: { accounts: [], keywords: [] } }) + '\n');

const db = require('../src/db');
const apify = require('../src/apify');
const apifyCost = require('../src/apifyCost');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'costo-apify.js');
const APIDOJO = 'apidojo~instagram-scraper-api';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ≈ ${b}`);

// Un ciclo como el #56: dos búsquedas cortadas (sin run), una que respondió
// y una consulta de perfil del benchmark cortada.
const ciclo = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', startedAt: '2026-11-16T15:00:00.000Z' });
const llamada = (extra) => db.insertApifyCall({ runId: ciclo, at: '2026-11-16T15:05:00.000Z', plataforma: 'instagram', actor: APIDOJO, phase: 'busqueda', queryType: 'search', items: 0, ok: false, error: 'TIMEOUT', usd: 0, ...extra });
const macri = llamada({ target: 'macri' });
const porteno = llamada({ target: 'gobierno porteño', error: 'Apify respondió 502: Bad Gateway' });
const blacri = llamada({ target: 'blacri', ok: true, error: null, usd: 0.015, apifyRunId: 'run-blacri' });
const perfil = llamada({ target: 'https://www.instagram.com/anredaccion/', phase: 'benchmark', queryType: 'user' });
db.finishMonitoringRun(ciclo, { newPosts: 0, finishedAt: '2026-11-16T15:06:00.000Z' });

const ENTRADAS = [
  { ciclo, objetivo: 'Macri', apifyRunId: 'run-macri', usd: 0.2645, items: 500 },
  { ciclo, objetivo: ' gobierno porteño ', apifyRunId: 'run-porteno', usd: 0.265 },
  { ciclo, objetivo: '@anredaccion', apifyRunId: 'run-perfil', usd: 0.0065 },
];

describe('asentar corridas cortadas', { concurrency: false }, () => {
  test('sin aplicar solo informa: qué fila le toca a cada corrida, sin escribir nada', () => {
    const r = apifyCost.settleCutRuns(ENTRADAS);
    assert.deepEqual(r.asentadas.map((a) => [a.callId, a.target]), [[macri, 'macri'], [porteno, 'gobierno porteño'], [perfil, 'https://www.instagram.com/anredaccion/']]);
    near(r.usd, 0.2645 + 0.265 + 0.0065);
    assert.equal(db.getApifyCall(macri).apify_run_id, null);
    assert.equal(db.getApifyCall(macri).usd_real, null);
    near(db.getMonitoringRun(ciclo).usd, 0.015);
  });

  test('aplicando: el run y el costo real quedan en la fila fallida (que sigue fallida, sin resultados) y el total del ciclo se recalcula', () => {
    const r = apifyCost.settleCutRuns(ENTRADAS, { aplicar: true });
    assert.equal(r.asentadas.length, 3);
    const fila = db.getApifyCall(macri);
    assert.equal(fila.apify_run_id, 'run-macri');
    assert.equal(fila.usd_real, 0.2645);
    assert.equal(fila.ok, 0, 'sigue fallida: sus resultados no se usaron');
    assert.equal(fila.items, 0, 'no se importan publicaciones');
    assert.equal(fila.error, 'TIMEOUT');
    assert.equal(db.getApifyCall(perfil).apify_run_id, 'run-perfil');
    assert.equal(db.getApifyCall(blacri).usd_real, null, 'la que respondió no se toca');
    near(db.getMonitoringRun(ciclo).usd, 0.015 + 0.2645 + 0.265 + 0.0065);
  });

  test('una segunda pasada no cambia nada; lo que no tiene fila o viene mal formado se informa aparte', () => {
    const otra = apifyCost.settleCutRuns(
      [
        ...ENTRADAS,
        { ciclo, objetivo: 'no-estaba', apifyRunId: 'run-x', usd: 0.1 },
        { ciclo: ciclo + 999, objetivo: 'macri', apifyRunId: 'run-y', usd: 0.1 },
        { ciclo, objetivo: 'blacri', apifyRunId: 'run-z', usd: 0.1 }, // esa llamada no falló
        { ciclo, objetivo: 'macri', usd: 0.1 }, // sin run
        { ciclo: 'x', objetivo: 'macri', apifyRunId: 'run-w', usd: 0.1 },
        { ciclo, objetivo: 'macri', apifyRunId: 'run-v', usd: -1 },
      ],
      { aplicar: true }
    );
    assert.equal(otra.asentadas.length, 0);
    assert.equal(otra.yaAsentadas.length, 3);
    assert.deepEqual(otra.sinFila.map((e) => e.apifyRunId), ['run-x', 'run-y', 'run-z']);
    assert.equal(otra.invalidas.length, 3);
    near(db.getMonitoringRun(ciclo).usd, 0.015 + 0.2645 + 0.265 + 0.0065);
    assert.equal(apifyCost.settleCutRuns(null).asentadas.length, 0);
  });

  test('dos corridas del mismo término en el mismo ciclo: cada una a su fila, nunca dos a la misma', () => {
    const c = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', startedAt: '2026-11-17T15:00:00.000Z' });
    const a = db.insertApifyCall({ runId: c, plataforma: 'instagram', actor: APIDOJO, phase: 'busqueda', queryType: 'search', target: 'macri', ok: false, error: 'TIMEOUT' });
    const b = db.insertApifyCall({ runId: c, plataforma: 'instagram', actor: APIDOJO, phase: 'busqueda', queryType: 'search', target: 'macri', ok: false, error: 'TIMEOUT' });
    const r = apifyCost.settleCutRuns(
      [
        { ciclo: c, objetivo: 'macri', apifyRunId: 'run-1a', usd: 0.1 },
        { ciclo: c, objetivo: 'macri', apifyRunId: 'run-1b', usd: 0.2 },
        { ciclo: c, objetivo: 'macri', apifyRunId: 'run-1c', usd: 0.3 },
      ],
      { aplicar: true }
    );
    assert.deepEqual(r.asentadas.map((x) => x.callId), [a, b]);
    assert.deepEqual(r.sinFila.map((x) => x.apifyRunId), ['run-1c']);
    assert.equal(db.getApifyCall(a).apify_run_id, 'run-1a');
    assert.equal(db.getApifyCall(b).apify_run_id, 'run-1b');
  });

  test('como proceso: --asentar sin --si informa y no escribe; con --si escribe; un archivo que no existe sale con 1', () => {
    const c = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', startedAt: '2026-11-18T15:00:00.000Z' });
    const id = db.insertApifyCall({ runId: c, plataforma: 'instagram', actor: APIDOJO, phase: 'busqueda', queryType: 'search', target: 'gcba', ok: false, error: 'TIMEOUT' });
    const archivo = path.join(tmp, 'cortadas.json');
    fs.writeFileSync(archivo, JSON.stringify([{ ciclo: c, objetivo: 'GCBA', apifyRunId: 'run-proceso', usd: 0.2075 }]));
    const env = { ...process.env };
    const informe = execFileSync(process.execPath, [SCRIPT, '--asentar', archivo], { env, encoding: 'utf8' });
    assert.match(informe, /Se asentarían: 1 de 1 corridas, US\$ 0\.2075\./);
    assert.match(informe, /No se escribió nada\. Para asentarlas, el mismo comando con --si\./);
    assert.equal(db.getApifyCall(id).apify_run_id, null);

    const hecho = execFileSync(process.execPath, [SCRIPT, '--asentar', archivo, '--si'], { env, encoding: 'utf8' });
    assert.match(hecho, /Asentadas: 1 de 1 corridas, US\$ 0\.2075\./);
    assert.match(hecho, new RegExp(`ciclo #${c} · GCBA · run run-proceso · US\\$ 0\\.2075`));
    assert.equal(db.getApifyCall(id).apify_run_id, 'run-proceso');

    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, '--asentar', path.join(tmp, 'no-existe.json')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (err) => err.status === 1 && /No se pudo leer/.test(String(err.stderr))
    );
  });
});

describe('corridas del actor que la app no registró', { concurrency: false }, () => {
  test('listOrphanRuns: las que están en Apify y no figuran en ninguna llamada', async () => {
    const now = Date.parse('2026-11-18T12:00:00.000Z');
    const pedido = [];
    const huerfanas = await apifyCost.listOrphanRuns({
      now,
      listActorRuns: async (actorId, { sinceMs }) => {
        pedido.push([actorId, new Date(sinceMs).toISOString()]);
        return [
          { id: 'run-macri', status: 'SUCCEEDED', startedAt: '2026-11-16T15:00:02.000Z', usdReal: 0.2645 }, // asentada
          { id: 'run-blacri', status: 'SUCCEEDED', startedAt: '2026-11-16T15:00:03.000Z', usdReal: 0.015 }, // registrada
          { id: 'run-suelta', status: 'SUCCEEDED', startedAt: '2026-11-17T09:00:00.000Z', usdReal: 0.04 },
        ];
      },
    });
    assert.deepEqual(pedido, [[APIDOJO, '2026-11-11T12:00:00.000Z']]);
    assert.deepEqual(huerfanas.map((h) => h.id), ['run-suelta']);
  });

  test('apify.listActorRuns: pagina de la más nueva a la más vieja y corta en la fecha pedida, sin cola ni fila', async () => {
    const originalFetch = global.fetch;
    const urls = [];
    const corrida = (i) => ({ id: `r${i}`, status: 'SUCCEEDED', startedAt: new Date(Date.parse('2026-11-18T00:00:00.000Z') - i * 60 * 60 * 1000).toISOString(), usageTotalUsd: 0.015 });
    global.fetch = async (url) => {
      urls.push(String(url).replace(/token=[^&]+/, 'token=***').replace('https://api.apify.com/v2', ''));
      const offset = Number(new URL(url).searchParams.get('offset'));
      const items = Array.from({ length: 250 }, (_, k) => corrida(offset + k));
      return { ok: true, status: 200, text: async () => '', json: async () => ({ data: { items } }) };
    };
    try {
      const antes = db.listApifyRunIdsSince('2020-01-01T00:00:00.000Z').size;
      const runs = await apify.listActorRuns(APIDOJO, { sinceMs: Date.parse('2026-11-18T00:00:00.000Z') - 300.5 * 60 * 60 * 1000 });
      assert.equal(runs.length, 301);
      assert.deepEqual(runs[0], { id: 'r0', status: 'SUCCEEDED', startedAt: '2026-11-18T00:00:00.000Z', finishedAt: null, usdReal: 0.015 });
      assert.deepEqual(urls, [
        '/acts/apidojo~instagram-scraper-api/runs?token=***&desc=true&limit=250&offset=0',
        '/acts/apidojo~instagram-scraper-api/runs?token=***&desc=true&limit=250&offset=250',
      ]);
      assert.equal(db.listApifyRunIdsSince('2020-01-01T00:00:00.000Z').size, antes, 'no registra ninguna llamada');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
