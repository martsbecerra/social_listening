'use strict';

// Interruptor IG_ACTOR (src/platforms/igActor.js) y el proveedor
// apify/instagram-scraper (src/platforms/instagramApify.js) detrás de la
// fachada src/platforms/instagram.js: con IG_ACTOR=apify todo funciona
// exactamente como antes del cambio de actor (input con directUrls /
// onlyPostsNewerThan / skipPinnedPosts, seguidores por consulta "details",
// centinela -1, sin búsqueda por palabra clave). Proceso propio: el env se
// fija ANTES del require porque la fachada lo lee al cargar. Sin red: fetch
// stubeado. Base y config temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apify';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_RETRY_DELAY_MS = '5';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-igactor-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: ['trackeada'], keywords: ['obras'] } }, null, 2) + '\n');

const classifier = require('../src/classifier');
classifier.classifyPost = async (caption) => ({ title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' });
classifier.classifyRelevance = async () => ({ relevant: false });

const { resolveIgActor, IG_ACTORS, DEFAULT_IG_ACTOR } = require('../src/platforms/igActor');
const db = require('../src/db');
const monitor = require('../src/monitor');
const accountStats = require('../src/accountStats');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const respond = (items) => ({ ok: true, status: 200, text: async () => '', json: async () => items });

function stubFetch(reply) {
  const calls = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return respond(await reply(body));
  };
  return calls;
}

describe('IG_ACTOR=apify: el proveedor oficial detrás de la fachada', { concurrency: false }, () => {
  test('resolveIgActor: vacío es apidojo, acepta mayúsculas y espacios, un valor desconocido tira con mensaje claro', () => {
    assert.deepEqual(IG_ACTORS, ['apidojo', 'apify']);
    assert.equal(DEFAULT_IG_ACTOR, 'apidojo');
    assert.equal(resolveIgActor(''), 'apidojo');
    // Sin argumento (o undefined) lee el entorno: ver la última aserción.
    assert.equal(resolveIgActor(null), 'apidojo');
    assert.equal(resolveIgActor(' Apify '), 'apify');
    assert.equal(resolveIgActor('APIDOJO'), 'apidojo');
    assert.throws(() => resolveIgActor('tiktok'), (err) => {
      assert.match(err.message, /IG_ACTOR="tiktok" no es válido/);
      assert.match(err.userMessage, /"apidojo" o "apify"/);
      return true;
    });
    assert.equal(resolveIgActor(), 'apify', 'el del entorno de este test');
  });

  test('la fachada expone el actor oficial y no ofrece búsqueda por palabra clave', () => {
    assert.equal(instagram.provider, 'apify');
    assert.equal(instagram.actorId, 'apify~instagram-scraper');
    assert.equal(typeof instagram.scrapeSearch, 'undefined');
    assert.equal(typeof instagram.scrapeKeyword, 'undefined');
    assert.deepEqual(instagram.capabilities, { benchmark: true, followers: true, metricsRefresh: true });
  });

  test('normalizePost del actor oficial: id/url como siempre, centinela -1 a null, tipo desde type/productType, sin seguidores', () => {
    const post = instagram.normalizePost(
      { id: '3988446205819984513', shortCode: 'DdZzrFHp5qB', ownerUsername: 'descalzo.nico', caption: 'hola #obras', hashtags: ['obras'], likesCount: -1, commentsCount: 4, timestamp: '2026-09-17T21:25:36.000Z', type: 'Sidecar' },
      { account: 'otro', sourceType: 'account' }
    );
    assert.equal(post.id, '3988446205819984513');
    assert.equal(post.url, 'https://www.instagram.com/p/DdZzrFHp5qB/');
    assert.equal(post.account, 'descalzo.nico');
    assert.equal(post.likes, null);
    assert.equal(post.comments, 4);
    assert.equal(post.postType, 'carrusel');
    assert.equal(post.followers, null);
    assert.equal(post.hashtagsText, 'obras');
    assert.equal(post.sourceType, 'account');
    assert.equal(instagram.normalizePost({ shortCode: 'abc', productType: 'clips' }, { account: 'x', sourceType: 'hashtag' }).postType, 'reel');
  });

  test('scrapeAccount / scrapeHashtag / fetchAccountFollowers mandan el input de siempre al actor oficial', async () => {
    const originalFetch = global.fetch;
    try {
      const calls = stubFetch((body) =>
        body.resultsType === 'details'
          ? [{ username: 'trackeada', followersCount: 9876 }]
          : [{ id: '1', shortCode: 'a', ownerUsername: 'trackeada', caption: 'obras', likesCount: 3, commentsCount: 1, timestamp: '2026-09-17T10:00:00.000Z', type: 'Image' }, { error: 'no_items' }]
      );
      const posts = await instagram.scrapeAccount('trackeada', { resultsLimit: 15, lookback: '1 day' });
      assert.match(calls[0].url, /\/acts\/apify~instagram-scraper\/run-sync-get-dataset-items\?token=/);
      assert.deepEqual(calls[0].body, {
        directUrls: ['https://www.instagram.com/trackeada/'],
        resultsType: 'posts',
        resultsLimit: 15,
        onlyPostsNewerThan: '1 day',
        skipPinnedPosts: true,
      });
      assert.equal(posts.length, 1, 'el item de error se descarta');
      assert.equal(posts[0].postType, 'imagen');

      await instagram.scrapeHashtag('JorgeMacri', { resultsLimit: 15, lookback: '1 day' });
      assert.deepEqual(calls[1].body, { directUrls: ['https://www.instagram.com/explore/tags/JorgeMacri/'], resultsType: 'posts', resultsLimit: 15 });

      assert.equal(await instagram.fetchAccountFollowers('trackeada'), 9876);
      assert.deepEqual(calls[2].body, { directUrls: ['https://www.instagram.com/trackeada/'], resultsType: 'details', resultsLimit: 1 });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('computeAccountStats con el actor oficial: los posteos no traen seguidores, así que se consulta aparte (como siempre)', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, fetchAccountFollowers: instagram.fetchAccountFollowers };
    try {
      instagram.scrapeAccount = async () =>
        Array.from({ length: 6 }, (_, i) =>
          instagram.normalizePost(
            { id: `t${i}`, shortCode: `T${i}`, ownerUsername: 'trackeada', caption: 'x', likesCount: 10 + i, commentsCount: i, timestamp: new Date(Date.now() - (i + 1) * 86400000).toISOString(), type: 'Image' },
            { account: 'trackeada', sourceType: 'account' }
          )
        );
      instagram.fetchAccountFollowers = async () => 999;
      const result = await accountStats.computeAccountStats('trackeada', 'instagram');
      assert.equal(result.followersChecked, 1);
      assert.equal(result.followersFound, true);
      assert.equal(result.groupsSaved, 2, 'imagen + fila global');
      assert.equal(db.getAccountFollowers('trackeada', 'instagram'), 999);
    } finally {
      instagram.scrapeAccount = originals.scrapeAccount;
      instagram.fetchAccountFollowers = originals.fetchAccountFollowers;
    }
  });

  test('búsquedas por palabra clave con el actor oficial: un término configurado se ignora con aviso y agregar uno se rechaza', async () => {
    fs.writeFileSync(
      process.env.MONITORING_CONFIG_PATH,
      JSON.stringify({ instagram: { accounts: [], keywords: ['obras'], searches: ['jorge macri'] } }, null, 2) + '\n'
    );
    const originalConfigured = instagram.isConfigured;
    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    instagram.isConfigured = () => true;
    try {
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(result.checked, 0, 'sin cuentas ni hashtags y sin búsqueda, no se consulta nada');
      assert.ok(
        warned.some((w) => /1 búsqueda\(s\) por palabra clave configuradas/.test(w) && /IG_ACTOR=apidojo/.test(w)),
        warned.join('\n')
      );
      assert.throws(() => monitor.addSearch('otra', 'instagram'), (err) => {
        assert.match(err.userMessage, /IG_ACTOR=apidojo/);
        return true;
      });
      assert.deepEqual(monitor.loadConfig('instagram').searches, ['jorge macri'], 'lo configurado se conserva');
    } finally {
      console.warn = originalWarn;
      instagram.isConfigured = originalConfigured;
    }
  });
});
