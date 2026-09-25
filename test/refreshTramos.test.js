'use strict';

// Tramos del refresco de métricas (src/metricsRefresh.js) con la fuente
// stubeada (sin Apify): el tope por corrida deja cuentas afuera SIN avanzar
// las marcas de pase (se retoman en el próximo ciclo, y la cadencia por
// posteo evita pagar dos veces lo ya refrescado); el tramo frío también
// tiene cadencia por posteo. Los topes y cadencias se fijan ANTES de cargar
// el módulo (los lee al cargar).

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.MAX_ACCOUNTS_PER_REFRESH = '2';
process.env.REFRESH_HOT_EVERY_HOURS = '12';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-refresh-tramos-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
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
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

instagram.isConfigured = () => true;
let consultadas = [];
instagram.scrapeAccount = async (account) => {
  consultadas.push(account);
  return [{ id: `${account}-p`, account, likes: 5, comments: 5, postType: null }];
};

/** Un posteo guardado con posted_at y metrics_updated_at controlados (null = nunca refrescado). */
function seed(account, { postedAgoMs, refreshedAgoMs = null }) {
  const id = `${account}-p`;
  assert.equal(
    db.saveDetectedPost({
      id, account, url: `https://www.instagram.com/p/${id}/`, caption: 'obras', matchedReason: 'test',
      likes: 1, comments: 1, postedAt: agoIso(postedAgoMs), title: 't', sentiment: 'neutral', postType: null, followers: null, plataforma: 'instagram',
    }),
    true
  );
  raw.prepare('UPDATE detected_posts SET posted_at = ?, metrics_updated_at = ? WHERE id = ?').run(
    agoIso(postedAgoMs),
    refreshedAgoMs == null ? null : agoIso(refreshedAgoMs),
    id
  );
}

function reset() {
  raw.prepare('DELETE FROM detected_posts').run();
  raw.prepare('DELETE FROM refresh_state').run();
  consultadas = [];
}

describe('refresco: tope por corrida y marcas de pase', { concurrency: false }, () => {
  beforeEach(reset);

  test('tramo caliente: cadencia por posteo (REFRESH_HOT_EVERY_HOURS), ya no en cada ciclo', async () => {
    seed('cal-nunca', { postedAgoMs: 2 * HOUR_MS }); // recién detectado: entra
    seed('cal-vencida', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 13 * HOUR_MS }); // hace más de 12 h: entra
    seed('cal-fresca', { postedAgoMs: 20 * HOUR_MS, refreshedAgoMs: 1 * HOUR_MS }); // refrescada hace 1 h: espera

    const result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.deepEqual(consultadas.sort(), ['cal-nunca', 'cal-vencida']);
    assert.equal(result.hotCount, 2, 'la fresca no cuenta como pendiente');
    assert.equal(result.leftOut, 0);
    assert.equal(metricsRefresh.REFRESH_HOT_EVERY_HOURS, 12);

    consultadas = [];
    const otraVez = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.deepEqual(consultadas, [], 'recién refrescadas: ningún posteo caliente vence hasta dentro de 12 h');
    assert.equal(otraVez.accountsChecked, 0);
  });

  test('el tope deja cuentas afuera: la marca del pase tibio no avanza y el próximo ciclo retoma solo lo que faltaba', async () => {
    // Tres cuentas en tramo tibio (posteos de hace 3 días), nunca refrescadas; tope 2.
    for (const account of ['tibia1', 'tibia2', 'tibia3']) seed(account, { postedAgoMs: 3 * DAY_MS });

    const primera = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.equal(primera.accountsChecked, 2);
    assert.equal(primera.leftOut, 1);
    assert.equal(db.getRefreshState('warm_last_pass_at'), null, 'quedó una afuera: la marca no avanza');

    const segunda = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.equal(segunda.accountsChecked, 1, 'solo la que faltaba: las dos refrescadas quedan fuera por su cadencia');
    assert.equal(segunda.leftOut, 0);
    assert.deepEqual([...new Set(consultadas)].sort(), ['tibia1', 'tibia2', 'tibia3'], 'las tres se consultaron una sola vez');
    assert.equal(consultadas.length, 3);
    assert.ok(db.getRefreshState('warm_last_pass_at'), 'pase completo: ahora sí avanza la marca');

    const tercera = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.equal(tercera.accountsChecked, 0, 'con la marca puesta, el tramo tibio no se vuelve a evaluar hasta REFRESH_WARM_EVERY_HOURS');
  });

  test('tramo frío: cadencia por posteo (lo refrescado hace poco no se vuelve a pagar) y marca solo con pase completo', async () => {
    seed('fria-nunca', { postedAgoMs: 20 * DAY_MS });
    seed('fria-reciente', { postedAgoMs: 20 * DAY_MS, refreshedAgoMs: 1 * DAY_MS });

    const result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.deepEqual(consultadas, ['fria-nunca'], 'la refrescada hace 1 día queda fuera de la cadencia semanal');
    assert.equal(result.coldCount, 1);
    assert.equal(result.leftOut, 0);
    assert.ok(db.getRefreshState('cold_last_pass_at'), 'nadie quedó afuera: la marca del pase frío avanza');
  });
});
