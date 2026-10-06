'use strict';

// Lotes del refresco por URL (src/metricsRefresh.js, REFRESH_MODE=url):
// con más de REFRESH_URLS_PER_RUN (100) posteos pedidos hay más de un run
// por ciclo (hasta 100 URLs cada uno), y una cuota agotada en un lote corta
// los lotes todavía no lanzados. Proceso propio porque REFRESH_MAX_POSTS y
// APIFY_MAX_CONCURRENT se leen al cargar (acá 150 y 1: con un solo cupo los
// lotes salen de a uno y el corte por cuota es determinístico). Fuente
// stubeada, base temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_MAX_CONCURRENT = '1';
delete process.env.REFRESH_MODE;
process.env.REFRESH_MAX_POSTS = '150';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-refresh-url-lotes-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [] } }, null, 2) + '\n');

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 't', sentiment: 'neutral' });

const db = require('../src/db');
const metricsRefresh = require('../src/metricsRefresh');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);

const HOUR_MS = 60 * 60 * 1000;
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

instagram.isConfigured = () => true;
let calls = [];
let responder = async () => [];
instagram.fetchPostDetails = async (urls) => {
  calls.push([...urls]);
  return responder(urls, calls.length);
};

/** N posteos calientes vencidos (refrescados hace 13 h), cada uno con su URL /p/. */
function seedMany(n) {
  for (let i = 0; i < n; i += 1) {
    const id = `lote-${String(i).padStart(3, '0')}`;
    db.saveDetectedPost({
      id, account: 'cuenta', url: `https://www.instagram.com/p/${id}/`, caption: 'obras', matchedReason: 'test',
      likes: 1, comments: 1, postedAt: agoIso(20 * HOUR_MS), title: 't', sentiment: 'neutral', postType: null, followers: null, plataforma: 'instagram',
    });
    // Atraso creciente con i, para que el orden sea predecible.
    raw.prepare('UPDATE detected_posts SET metrics_updated_at = ? WHERE id = ?').run(agoIso((13 + i / 100) * HOUR_MS), id);
  }
}

function reset() {
  raw.prepare('DELETE FROM detected_posts').run();
  raw.prepare('DELETE FROM refresh_state').run();
  calls = [];
  responder = async () => [];
}

describe('refresco por URL: lotes de hasta 100 URLs por run', { concurrency: false }, () => {
  beforeEach(reset);

  test('170 vencidos, tope 150: dos runs (100 y 50), 20 quedan para el próximo ciclo', async () => {
    assert.equal(metricsRefresh.REFRESH_MAX_POSTS, 150);
    assert.equal(metricsRefresh.refreshLimiter.limit, 1);
    seedMany(170);
    responder = async (urls) => urls.map((url) => ({ id: url.split('/p/')[1].replace('/', ''), url, likes: 5, comments: 5 }));

    const result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.length), [100, 50]);
    assert.equal(new Set(calls.flat()).size, 150, 'sin repetidos');
    assert.deepEqual([result.postsRequested, result.postsAnswered, result.runs, result.deferred], [150, 150, 2, 20]);
    const actualizados = raw.prepare('SELECT COUNT(*) AS n FROM detected_posts WHERE likes = 5').get().n;
    assert.equal(actualizados, 150);
  });

  test('cuota agotada en el primer lote: el segundo no se lanza y nadie suma intentos', async () => {
    seedMany(120);
    responder = async () => {
      const err = new Error('cuota agotada');
      err.code = 'QUOTA_EXCEEDED';
      throw err;
    };
    const originalLog = console.log;
    console.log = () => {};
    let result;
    try {
      result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    } finally {
      console.log = originalLog;
    }
    assert.equal(calls.length, 1, 'el segundo lote no llegó a la fuente');
    assert.equal(result.quotaExceeded, true);
    assert.deepEqual([result.runs, result.runsFailed, result.postsMissing], [0, 1, 0]);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM detected_posts WHERE refresh_misses > 0').get().n, 0);
    assert.equal(metricsRefresh.refreshLimiter.inFlight(), 0);
  });
});
