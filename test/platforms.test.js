'use strict';

// Contrato de la capa de plataformas: migración del config al formato por
// secciones (sin perder keywords) y filtro por platform en db. Corre contra
// tempfiles: nunca toca config/monitoring.json ni data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-platforms-'));
const configPath = path.join(tmpDir, 'monitoring.json');
process.env.MONITORING_CONFIG_PATH = configPath;
process.env.MONITORING_DB_PATH = path.join(tmpDir, 'monitoring.db');

// Config en el formato PLANO viejo, como el real (52 keywords): la migración
// no puede perder ninguna.
const FLAT_KEYWORDS = Array.from({ length: 52 }, (_, i) => `keyword ${i + 1}`);
fs.writeFileSync(
  configPath,
  JSON.stringify({ accounts: ['cuentaig'], keywords: FLAT_KEYWORDS }, null, 2) + '\n',
  'utf8'
);

const monitor = require('../src/monitor');
const db = require('../src/db');
const { getPlatform, listPlatformIds } = require('../src/platforms');

describe('platforms', { concurrency: false }, () => {
  test('el config plano se migra a secciones sin perder nada', () => {
    const config = monitor.loadConfig();
    assert.deepEqual(config.accounts, ['cuentaig']);
    assert.equal(config.keywords.length, 52);
    assert.deepEqual(config.keywords, FLAT_KEYWORDS);

    // El archivo quedó reescrito en formato por secciones.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.accounts, undefined);
    assert.deepEqual(onDisk.instagram.accounts, ['cuentaig']);
    assert.equal(onDisk.instagram.keywords.length, 52);
  });

  test('la migración es idempotente: en formato nuevo no reescribe', () => {
    monitor.loadConfig(); // asegura formato nuevo
    const before = fs.statSync(configPath).mtimeMs;
    const raw = fs.readFileSync(configPath, 'utf8');
    monitor.loadConfig();
    assert.equal(fs.statSync(configPath).mtimeMs, before);
    assert.equal(fs.readFileSync(configPath, 'utf8'), raw);
  });

  test('registro: getPlatform y contrato del adapter', () => {
    assert.deepEqual(listPlatformIds(), ['instagram']);
    const ig = getPlatform('instagram');
    assert.equal(ig.id, 'instagram');
    assert.equal(ig.actorId, 'apify~instagram-scraper');
    assert.equal(typeof ig.scrapeAccount, 'function');
    assert.equal(typeof ig.normalizePost, 'function');
    assert.equal(ig.buildProfileUrl('pepe'), 'https://www.instagram.com/pepe/');
    // Metadata de métricas: exactamente una primaria.
    assert.equal(ig.metrics.filter((m) => m.primary).length, 1);
    assert.ok(ig.metrics.every((m) => m.key && m.label && typeof m.primary === 'boolean'));

    assert.throws(() => getPlatform('tiktok'), /Plataforma desconocida/);
  });

  test('detected_posts: plataforma se guarda y el filtro opcional funciona', () => {
    const base = {
      caption: 'hola', matchedReason: 'test', likes: 1, comments: 1,
      postedAt: new Date().toISOString(), title: 't', sentiment: 'neutral',
      postType: null, followers: null,
    };
    assert.equal(db.saveDetectedPost({ ...base, id: 'ig1', account: 'a', url: 'https://ex.com/1', plataforma: 'instagram' }), true);
    assert.equal(db.saveDetectedPost({ ...base, id: 'tk1', account: 'b', url: 'https://ex.com/2', plataforma: 'tiktok' }), true);
    // Sin plataforma en el post: default instagram (filas de antes del refactor).
    assert.equal(db.saveDetectedPost({ ...base, id: 'ig2', account: 'c', url: 'https://ex.com/3' }), true);

    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20 }).total, 3);
    const ig = db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'instagram' });
    assert.equal(ig.total, 2);
    assert.ok(ig.posts.every((p) => p.plataforma === 'instagram'));
    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'tiktok' }).total, 1);
    assert.equal(db.countRecentPosts(7), 3);
    assert.equal(db.countRecentPosts(7, 'tiktok'), 1);
  });
});
