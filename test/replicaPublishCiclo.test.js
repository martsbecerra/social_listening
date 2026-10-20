'use strict';

// Réplicas (REQ-REP-02, REQ-REP-03): el ciclo de monitoreo publica el
// snapshot al cerrar, con su número de ciclo, aunque una fuente falle.
// replicaPublish.publishFromEnv está stubeado (nada toca git) y el
// adapter de Instagram no trae nada (nada llama a Apify). Base y config
// temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
process.env.POST_IMAGES = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-ciclo-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.MONITORING_MEDIA_DIR = path.join(tmp, 'media');
fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: [], searches: ['obras'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 't', sentiment: 'neutral' });

const replicaPublish = require('../src/replicaPublish');
const scheduler = require('../src/scheduler');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

instagram.isConfigured = () => true;
let searchImpl = async () => [];
instagram.scrapeSearch = (...args) => searchImpl(...args);
instagram.fetchPostDetails = async () => [];
instagram.scrapeAccount = async () => [];
instagram.scrapeHashtag = async () => [];

const publicaciones = [];
replicaPublish.publishFromEnv = async (options) => {
  publicaciones.push(options);
  return { skipped: true };
};

const consoleOriginal = { log: console.log, error: console.error, warn: console.warn };
before(() => {
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
});
after(() => Object.assign(console, consoleOriginal));

test('al cerrar el ciclo publica una vez, con el número de ciclo', async () => {
  publicaciones.length = 0;
  await scheduler.runCycle({ plataforma: 'instagram' });
  assert.equal(publicaciones.length, 1);
  assert.equal(typeof publicaciones[0].runId, 'number');
});

test('una búsqueda que falla no impide publicar', async () => {
  publicaciones.length = 0;
  searchImpl = async () => {
    throw new Error('Apify caído');
  };
  await scheduler.runCycle({ plataforma: 'instagram' }).catch(() => {});
  assert.equal(publicaciones.length, 1);
});
