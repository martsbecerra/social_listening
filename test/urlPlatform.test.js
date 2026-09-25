'use strict';

// Separación por plataforma, cambio 1: platformForUrl (src/platforms/
// urlPlatform.js) y el guard de db.saveDetectedPost — una publicación de X
// nunca se guarda etiquetada como Instagram, ni al revés — más el ciclo de
// monitoreo, que descarta ese posteo y sigue con el resto. Sin red: adapter
// y clasificador stubeados, base y config en tempfiles.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-url-plataforma-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: ['cuentaig'], keywords: ['obras'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
classifier.classifyPost = async (caption) => ({ title: `t: ${String(caption).slice(0, 10)}`, sentiment: 'neutral' });
classifier.classifyRelevance = async () => ({ relevant: false });

const { platformForUrl, hostnameOf } = require('../src/platforms/urlPlatform');
const platforms = require('../src/platforms');
const db = require('../src/db');
const monitor = require('../src/monitor');

const instagram = platforms.getPlatform('instagram');
const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);
const base = {
  caption: 'obras en la ciudad',
  matchedReason: 'test',
  likes: 1,
  comments: 1,
  postedAt: new Date().toISOString(),
  title: 't',
  sentiment: 'neutral',
  postType: null,
  followers: null,
};

describe('separación por plataforma: la url manda', { concurrency: false }, () => {
  test('platformForUrl decide por el dominio (subdominios incluidos); null si no es una url o no es de una red conocida', () => {
    assert.equal(platformForUrl('https://www.instagram.com/p/AAA/'), 'instagram');
    assert.equal(platformForUrl('https://instagram.com/reel/BBB/'), 'instagram');
    assert.equal(platformForUrl('https://x.com/usuario/status/123'), 'x');
    assert.equal(platformForUrl('https://twitter.com/usuario/status/123'), 'x');
    assert.equal(platformForUrl('https://mobile.twitter.com/usuario/status/123'), 'x');
    assert.equal(platformForUrl('https://ejemplo.com/1'), null);
    assert.equal(platformForUrl('https://notinstagram.com/p/AAA/'), null, 'el sufijo no alcanza: tiene que ser el dominio o un subdominio');
    assert.equal(platformForUrl('no es una url'), null);
    assert.equal(platformForUrl(''), null);
    assert.equal(platformForUrl(undefined), null);
    assert.equal(hostnameOf('HTTPS://WWW.Instagram.com/p/AAA/'), 'www.instagram.com');
    assert.equal(platforms.platformForUrl, platformForUrl, 'el registro la reexporta');
  });

  test('saveDetectedPost rechaza una url de otra red (code PLATAFORMA_INCONSISTENTE) y no escribe nada', () => {
    assert.equal(db.saveDetectedPost({ ...base, id: '1', account: 'a', url: 'https://www.instagram.com/p/AAA/', plataforma: 'instagram' }), true);
    assert.equal(db.saveDetectedPost({ ...base, id: 'x:2', account: 'b', url: 'https://x.com/b/status/2', plataforma: 'x' }), true);
    assert.equal(
      db.saveDetectedPost({ ...base, id: 'tk3', account: 'c', url: 'https://ejemplo.com/3', plataforma: 'tiktok' }),
      true,
      'dominio desconocido: no hay nada que contradecir, se guarda'
    );

    assert.throws(
      () => db.saveDetectedPost({ ...base, id: 'x:4', account: 'd', url: 'https://x.com/d/status/4', plataforma: 'instagram' }),
      (err) => {
        assert.equal(err.code, 'PLATAFORMA_INCONSISTENTE');
        assert.match(err.message, /url de x/);
        assert.match(err.message, /"instagram"/);
        return true;
      }
    );
    assert.throws(
      () => db.saveDetectedPost({ ...base, id: '5', account: 'e', url: 'https://www.instagram.com/p/BBB/', plataforma: 'x' }),
      (err) => err.code === 'PLATAFORMA_INCONSISTENTE'
    );

    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM detected_posts').get().n, 3, 'los rechazados no se insertaron');
    assert.equal(db.findExistingPostId('x:4', 'https://x.com/d/status/4'), null);
    assert.equal(db.findExistingPostId('5', 'https://www.instagram.com/p/BBB/'), null);
  });

  test('el ciclo descarta el posteo inconsistente (lo loguea) y guarda el resto', async () => {
    instagram.isConfigured = () => true;
    const now = new Date().toISOString();
    const post = (id, url) => ({
      id,
      account: 'cuentaig',
      url,
      caption: 'obras en la comuna',
      hashtagsText: '',
      likes: 1,
      comments: 0,
      postedAt: now,
      postType: null,
      followers: null,
      sourceType: 'account',
      sourceQuery: null,
    });
    instagram.scrapeAccount = async () => [
      post('10', 'https://www.instagram.com/p/CCC/'),
      post('x:11', 'https://x.com/cuentaig/status/11'), // un adapter de Instagram nunca debería devolver esto
      post('12', 'https://www.instagram.com/p/DDD/'),
    ];
    instagram.scrapeHashtag = async () => [];

    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    let result;
    try {
      result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(result.newPosts.map((p) => p.id).sort(), ['10', '12'], 'los dos válidos entraron');
    assert.ok(
      logged.some((l) => l.includes('[monitor] (instagram) descartado') && l.includes('x:11')),
      `se logueó el descarte: ${logged.join(' | ')}`
    );
    assert.equal(db.findExistingPostId('x:11', 'https://x.com/cuentaig/status/11'), null, 'el inconsistente no se guardó');
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM detected_posts WHERE plataforma = 'instagram'").get().n, 3);
  });
});
