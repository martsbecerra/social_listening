'use strict';

// Separación por plataforma, cambio 4: ninguna función por plataforma tiene
// default a 'instagram'. Un llamador que la olvide recibe un error claro
// ("falta plataforma"), no una etiqueta equivocada en silencio — que era la
// única vía realista para que un dato de X terminara como Instagram. Sin
// red: base y config en tempfiles, fetch stubeado.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-plataforma-obligatoria-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: [] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const db = require('../src/db');
const monitor = require('../src/monitor');
const accountStats = require('../src/accountStats');
const { runActorSync } = require('../src/apify');

const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);
const FALTA = /falta plataforma/;

describe('plataforma obligatoria: sin default a instagram', { concurrency: false }, () => {
  test('db.js: sin plataforma tiran y no escriben nada', () => {
    assert.throws(
      () => db.saveDetectedPost({ id: '1', account: 'a', url: 'https://www.instagram.com/p/A/', caption: 'x', matchedReason: 't' }),
      FALTA
    );
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM detected_posts').get().n, 0);
    assert.throws(() => db.listDistinctPostAccounts(), FALTA);
    assert.throws(() => db.updateFollowersForAccount('a', 1), FALTA);
    assert.throws(() => db.listAccountsDueForRefresh({ sinceIso: '2026-01-01', untilIso: '2026-12-31' }), FALTA);
    assert.throws(() => db.getSearchSeen('p'), FALTA);
    assert.throws(() => db.isSearchSeen('p'), FALTA);
    assert.throws(() => db.markSearchSeen({ postId: 'p', outcome: 'guardado' }), FALTA);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM search_seen').get().n, 0);
    assert.throws(() => db.ignorePost('1'), FALTA);
    assert.throws(() => db.updateSentiment('1', 'positivo'), FALTA);

    // Con plataforma, todo sigue funcionando igual.
    assert.equal(
      db.saveDetectedPost({ id: '1', account: 'a', url: 'https://www.instagram.com/p/A/', caption: 'x', matchedReason: 't', plataforma: 'instagram' }),
      true
    );
    assert.deepEqual(db.listDistinctPostAccounts('instagram'), ['a']);
    assert.deepEqual(db.listDistinctPostAccounts('x'), []);
  });

  test('monitor.js: la config por plataforma no tiene default y nunca escribe una sección "undefined"', async () => {
    assert.throws(() => monitor.loadConfig(), FALTA);
    await assert.rejects(monitor.addAccount('alguien'), FALTA);
    await assert.rejects(monitor.addKeyword('obras'), FALTA);
    assert.throws(() => monitor.removeAccount('alguien'), FALTA);
    assert.throws(() => monitor.removeKeyword('obras'), FALTA);
    assert.throws(() => monitor.addSearch('macri'), FALTA);
    assert.throws(() => monitor.removeSearch('macri'), FALTA);
    await assert.rejects(monitor.backfillClassification(), FALTA);

    const onDisk = JSON.parse(fs.readFileSync(process.env.MONITORING_CONFIG_PATH, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['instagram', 'x'], 'ninguna sección fantasma en el archivo');
    assert.deepEqual(monitor.loadConfig('instagram').accounts, []);
  });

  test('accountStats.js: benchmark y clasificación exigen la plataforma', async () => {
    await assert.rejects(accountStats.computeAccountStats('a'), FALTA);
    assert.throws(() => accountStats.classifyPostAgainstBenchmark({ account: 'a', likes: 1, comments: 1 }), FALTA);
    assert.throws(() => accountStats.buildAccountUniverse(), FALTA);
    assert.deepEqual(accountStats.buildAccountUniverse('instagram'), ['a']);
  });

  test('runActorSync sin plataforma rechaza antes de tocar la red ni la cola', async () => {
    const originalFetch = global.fetch;
    let llamadas = 0;
    global.fetch = async () => {
      llamadas += 1;
      throw new Error('no debía llamar a la red');
    };
    try {
      await assert.rejects(runActorSync({ directUrls: ['https://www.instagram.com/p/A/'] }, { actorId: 'apify~instagram-scraper' }), FALTA);
      await assert.rejects(runActorSync({ directUrls: ['https://www.instagram.com/p/A/'] }), FALTA);
      assert.equal(llamadas, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
