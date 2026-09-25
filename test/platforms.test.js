'use strict';

// Contrato de la capa de plataformas: migración del config al formato por
// secciones (sin perder keywords) y filtro por plataforma en db. Corre contra
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
// Sin archivo viejo de X en el tempdir: que el test nunca absorba (y
// renombre) un config/monitoring-x.json real del working tree.
process.env.MONITORING_X_CONFIG_PATH = path.join(tmpDir, 'monitoring-x.json');

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
    const config = monitor.loadConfig('instagram');
    assert.deepEqual(config.accounts, ['cuentaig']);
    assert.equal(config.keywords.length, 52);
    assert.deepEqual(config.keywords, FLAT_KEYWORDS);

    // El archivo quedó reescrito en formato por secciones.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.accounts, undefined);
    assert.deepEqual(Object.keys(onDisk), ['instagram']); // ninguna sección ajena se coló
    assert.deepEqual(onDisk.instagram.accounts, ['cuentaig']);
    assert.equal(onDisk.instagram.keywords.length, 52);
  });

  test('errores tipificados: platforms/errors.js y los `code` que marca apify.js', async () => {
    const { isPlatformError, isQuotaExceeded, PLATFORM_ERROR_CODES } = require('../src/platforms/errors');
    assert.deepEqual(PLATFORM_ERROR_CODES, ['NOT_CONFIGURED', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'AUTH_INVALID']);
    for (const code of PLATFORM_ERROR_CODES) {
      assert.equal(isPlatformError(Object.assign(new Error(code), { code })), true, code);
    }
    const apifyQuotaByText = new Error('Apify respondió 403: {"error":{"type":"actor-disabled","message":"Monthly usage hard limit exceeded"}}');
    assert.equal(isQuotaExceeded(apifyQuotaByText), true);
    assert.equal(isPlatformError(apifyQuotaByText), true);
    assert.equal(isPlatformError(new Error('Grok no devolvió JSON')), false);
    assert.equal(isPlatformError(null), false);

    // runActorSync marca code según la respuesta de Apify (fetch stubeado).
    const { runActorSync } = require('../src/apify');
    const originalFetch = global.fetch;
    const respond = (status, text) => async () => ({ ok: false, status, text: async () => text, json: async () => [] });
    try {
      const cases = [
        [401, 'invalid token', 'AUTH_INVALID', /clave de Apify/],
        [403, 'forbidden', 'AUTH_INVALID', /clave de Apify/],
        [403, '{"error":{"type":"actor-disabled","message":"Monthly usage hard limit exceeded"}}', 'QUOTA_EXCEEDED', /cuota mensual de Apify/],
        [429, 'too many requests', 'RATE_LIMITED', /límite de uso de Apify/],
        [500, 'boom', undefined, /Apify\) falló/], // fallo puntual: sin código
      ];
      for (const [status, text, code, messageRe] of cases) {
        global.fetch = respond(status, text);
        await assert.rejects(runActorSync({}, { actorId: 'apify~instagram-scraper', plataforma: 'instagram' }), (err) => {
          assert.equal(err.code, code, `${status} ${text}`);
          assert.match(err.userMessage, messageRe);
          return true;
        });
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('benchmark y refresco de métricas solo para las plataformas con esa capability', () => {
    const { benchmarkPlatformIds } = require('../src/accountStats');
    const { refreshPlatformIds } = require('../src/metricsRefresh');
    assert.deepEqual(benchmarkPlatformIds(), ['instagram']);
    assert.deepEqual(benchmarkPlatformIds(['x']), []);
    assert.deepEqual(benchmarkPlatformIds(['x', 'instagram']), ['instagram']);
    assert.deepEqual(refreshPlatformIds(), ['instagram']);
    assert.deepEqual(refreshPlatformIds(['x']), []);
  });

  test('la migración es idempotente: en formato nuevo no reescribe', () => {
    monitor.loadConfig('instagram'); // asegura formato nuevo
    const before = fs.statSync(configPath).mtimeMs;
    const raw = fs.readFileSync(configPath, 'utf8');
    monitor.loadConfig('instagram');
    assert.equal(fs.statSync(configPath).mtimeMs, before);
    assert.equal(fs.readFileSync(configPath, 'utf8'), raw);
  });

  test('registro: getPlatform y contrato del adapter', () => {
    assert.deepEqual(listPlatformIds(), ['instagram', 'x']);
    const ig = getPlatform('instagram');
    assert.equal(ig.id, 'instagram');
    assert.equal(ig.label, 'Instagram');
    // Apify es un detalle interno de este adapter, no parte del contrato.
    // El actor depende de IG_ACTOR (default apidojo): lo que se fija acá es la
    // coherencia proveedor <-> actor; cada proveedor tiene su propio test.
    assert.ok(['apidojo', 'apify'].includes(ig.provider), ig.provider);
    assert.equal(ig.actorId, ig.provider === 'apidojo' ? 'apidojo~instagram-scraper-api' : 'apify~instagram-scraper');
    assert.equal(ig.buildProfileUrl('pepe'), 'https://www.instagram.com/pepe/');
    assert.deepEqual(ig.capabilities, { benchmark: true, followers: true, metricsRefresh: true });

    // Contrato genérico: lo mismo para cada adapter del registro.
    for (const id of listPlatformIds()) {
      const adapter = getPlatform(id);
      assert.equal(adapter.id, id);
      assert.equal(typeof adapter.label, 'string');
      for (const fn of ['isConfigured', 'validateAccount', 'validateHashtag', 'scrapeAccount', 'scrapeHashtag', 'normalizePost', 'buildProfileUrl', 'fetchAccountFollowers']) {
        assert.equal(typeof adapter[fn], 'function', `${id}.${fn}`);
      }
      for (const cap of ['benchmark', 'followers', 'metricsRefresh']) {
        assert.equal(typeof adapter.capabilities[cap], 'boolean', `${id}.capabilities.${cap}`);
      }
      // Metadata de métricas: exactamente una primaria.
      assert.equal(adapter.metrics.filter((m) => m.primary).length, 1, `${id}.metrics primaria`);
      assert.ok(adapter.metrics.every((m) => m.key && m.label && typeof m.primary === 'boolean'));
    }

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
    // Sin plataforma en el post no hay default a instagram: tira y no escribe.
    assert.throws(() => db.saveDetectedPost({ ...base, id: 'ig2', account: 'c', url: 'https://ex.com/3' }), /falta plataforma/);

    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20 }).total, 2);
    const ig = db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'instagram' });
    assert.equal(ig.total, 1);
    assert.ok(ig.posts.every((p) => p.plataforma === 'instagram'));
    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'tiktok' }).total, 1);
    assert.equal(db.countRecentPosts(7), 2);
    assert.equal(db.countRecentPosts(7, 'tiktok'), 1);
  });
});
