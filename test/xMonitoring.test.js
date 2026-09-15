'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-xmon-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

const db = require('../src/db');
const xMonitor = require('../src/x/monitor');

const IG_CONFIG_PATH = path.join(__dirname, '..', 'config', 'monitoring.json');

function samplePost(overrides = {}) {
  return {
    id: 'ig:aaa',
    account: 'gcba',
    url: 'https://www.instagram.com/p/AAA/',
    caption: 'hola',
    matchedReason: 'test',
    likes: 10,
    comments: 2,
    postedAt: new Date().toISOString(),
    title: 'titulo',
    sentiment: 'neutral',
    postType: 'imagen',
    followers: 100,
    plataforma: 'instagram',
    ...overrides,
  };
}

describe('x-ig-style monitoreo X', { concurrency: false }, () => {
  test('normalizeXMonitorPost arma id x:{tweetId} y mapea replies a comments', () => {
    const post = xMonitor.normalizeXMonitorPost(
      {
        id: '1234567890',
        url: 'https://x.com/vecino/status/1234567890',
        authorHandle: '@Vecino',
        text: 'bache en salta',
        likes: 4,
        retweets: 1,
        replies: 7,
        views: 90,
        createdAt: '2026-08-28T12:00:00.000Z',
      },
      { account: 'vecino', sourceType: 'account' }
    );
    assert.equal(post.id, 'x:1234567890');
    assert.equal(post.account, 'Vecino');
    assert.equal(post.comments, 7);
    assert.equal(post.retweets, 1);
    assert.equal(post.views, 90);
    assert.equal(post.plataforma, 'x');
    assert.match(post.url, /x\.com\/Vecino\/status\/1234567890/i);
  });

  test('normalizeXMonitorPost descarta sin tweet id', () => {
    assert.equal(xMonitor.normalizeXMonitorPost({ text: 'sin url' }, { sourceType: 'keyword' }), null);
  });

  test('config X no lee ni escribe monitoring.json', () => {
    const igBefore = fs.readFileSync(IG_CONFIG_PATH, 'utf8');
    const cfg = xMonitor.addAccount('@JorgeMacri');
    assert.ok(cfg.accounts.includes('JorgeMacri'));
    assert.equal(fs.readFileSync(IG_CONFIG_PATH, 'utf8'), igBefore);
    const onDisk = JSON.parse(fs.readFileSync(process.env.MONITORING_X_CONFIG_PATH, 'utf8'));
    assert.deepEqual(onDisk.accounts, ['JorgeMacri']);
    xMonitor.addKeyword('#CABA');
    assert.equal(fs.readFileSync(IG_CONFIG_PATH, 'utf8'), igBefore);
    xMonitor.removeAccount('JorgeMacri');
    xMonitor.removeKeyword('#CABA');
    assert.equal(fs.readFileSync(IG_CONFIG_PATH, 'utf8'), igBefore);
  });

  test('handle inválido no se guarda', () => {
    assert.throws(() => xMonitor.addAccount('no vale!!'), /inválido/i);
    assert.deepEqual(xMonitor.loadConfig().accounts, []);
  });

  test('listDetectedPosts por plataforma no mezcla IG y X', () => {
    assert.equal(db.saveDetectedPost(samplePost()), true);
    assert.equal(
      db.saveDetectedPost(
        samplePost({
          id: 'x:99',
          account: 'vecino',
          url: 'https://x.com/vecino/status/99',
          plataforma: 'x',
          retweets: 3,
          views: 40,
          followers: null,
          postType: null,
        })
      ),
      true
    );

    const all = db.listDetectedPosts({ page: 1, pageSize: 20 });
    assert.equal(all.total, 2);

    const onlyX = db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'x' });
    assert.equal(onlyX.total, 1);
    assert.equal(onlyX.posts[0].id, 'x:99');
    assert.equal(onlyX.posts[0].retweets, 3);

    const onlyIg = db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'instagram' });
    assert.equal(onlyIg.total, 1);
    assert.equal(onlyIg.posts[0].id, 'ig:aaa');
  });

  test('counts.instagram y counts.x van separados (REQ-MON dashboard)', () => {
    assert.equal(db.countRecentPosts(7, 'instagram'), 1);
    assert.equal(db.countRecentPosts(7, 'x'), 1);
    assert.equal(db.countRecentPosts(7), 2);
  });

  test('universo de benchmark IG no incluye cuentas solo de X', () => {
    const accounts = db.listDistinctPostAccounts();
    assert.ok(accounts.includes('gcba'));
    assert.ok(!accounts.includes('vecino'));
  });

  test('resultsLimit capea en 50', () => {
    const prev = process.env.X_MONITOR_RESULTS_LIMIT;
    process.env.X_MONITOR_RESULTS_LIMIT = '200';
    assert.equal(xMonitor.resultsLimit(), 50);
    process.env.X_MONITOR_RESULTS_LIMIT = '0';
    assert.equal(xMonitor.resultsLimit(), 30);
    if (prev === undefined) delete process.env.X_MONITOR_RESULTS_LIMIT;
    else process.env.X_MONITOR_RESULTS_LIMIT = prev;
  });
});
