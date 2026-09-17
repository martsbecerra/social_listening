'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readConfig,
  fetchSecretsRecord,
  applySecrets,
  loadSecrets,
  parseCliToken,
} = require('../src/secrets');

const TRACKED = [
  'INFISICAL_DISABLE',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_ENV',
  'INFISICAL_ENVIRONMENT',
  'INFISICAL_SECRET_PATH',
  'INFISICAL_SITE_URL',
  'INFISICAL_DOMAIN',
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_SECRET',
  'INFISICAL_TOKEN',
  'INFISICAL_ACCESS_TOKEN',
  '__INFISICAL_SECRETS_LOADED',
  'SL_TEST_SECRET',
  'SL_TEST_KEEP',
];

const original = {};

beforeEach(() => {
  for (const key of TRACKED) {
    original[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TRACKED) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('secrets / Infisical', () => {
  test('readConfig usa .infisical.json y admite overrides de env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-infisical-'));
    const filePath = path.join(dir, '.infisical.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        workspaceId: 'proj-from-file',
        defaultEnvironment: 'staging',
        domain: 'https://app.infisical.com/api',
      }),
      'utf8'
    );

    const fromFile = readConfig(filePath);
    assert.equal(fromFile.projectId, 'proj-from-file');
    assert.equal(fromFile.environment, 'staging');
    assert.equal(fromFile.siteUrl, 'https://app.infisical.com');

    process.env.INFISICAL_PROJECT_ID = 'proj-from-env';
    process.env.INFISICAL_ENV = 'prod';
    const fromEnv = readConfig(filePath);
    assert.equal(fromEnv.projectId, 'proj-from-env');
    assert.equal(fromEnv.environment, 'prod');
  });

  test('applySecrets no pisa variables ya seteadas y sí llena las vacías', () => {
    process.env.SL_TEST_KEEP = 'host';
    process.env.SL_TEST_SECRET = '';
    const applied = applySecrets({ SL_TEST_KEEP: 'infisical', SL_TEST_SECRET: 'from-infisical' });
    assert.equal(process.env.SL_TEST_KEEP, 'host');
    assert.equal(process.env.SL_TEST_SECRET, 'from-infisical');
    assert.equal(applied, 1);
  });

  test('parseCliToken elige el JWT si el CLI imprimió más de una línea', () => {
    const token = parseCliToken('tip: update available\neyJhbGciOiJIUzI1NiJ9.aaa.bbb\nTTL: 1h\n');
    assert.equal(token, 'eyJhbGciOiJIUzI1NiJ9.aaa.bbb');
  });

  test('fetchSecretsRecord mapea secretKey/secretValue y no loguea valores', async () => {
    const fetchFn = async (url, init) => {
      assert.match(url, /\/api\/v3\/secrets\/raw\?/);
      assert.match(url, /workspaceId=proj-test/);
      assert.match(url, /environment=dev/);
      assert.equal(init.headers.Authorization, 'Bearer tok');
      return {
        ok: true,
        json: async () => ({
          secrets: [
            { secretKey: 'SL_TEST_SECRET', secretValue: 's3cret' },
            { secretKey: 'PORT', secretValue: '3000' },
          ],
        }),
      };
    };

    const result = await fetchSecretsRecord({
      config: {
        projectId: 'proj-test',
        environment: 'dev',
        secretPath: '/',
        siteUrl: 'https://app.infisical.com',
      },
      accessToken: 'tok',
      fetch: fetchFn,
    });

    assert.equal(result.count, 2);
    assert.equal(result.secrets.SL_TEST_SECRET, 's3cret');
    assert.equal(result.secrets.PORT, '3000');
    assert.equal(result.source, 'injected');
  });

  test('loadSecrets inyecta en process.env y no vuelve a pedir si ya cargó', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        secrets: [{ secretKey: 'SL_TEST_SECRET', secretValue: 'once' }],
      }),
    });

    const first = await loadSecrets({
      config: {
        projectId: 'proj-test',
        environment: 'dev',
        secretPath: '/',
        siteUrl: 'https://app.infisical.com',
      },
      accessToken: 'tok',
      fetch: fetchFn,
    });
    assert.equal(first.applied, 1);
    assert.equal(process.env.SL_TEST_SECRET, 'once');

    const second = await loadSecrets({
      fetch: async () => {
        throw new Error('no debería volver a llamar a Infisical');
      },
    });
    assert.equal(second.source, 'already-loaded');
  });

  test('loadSecrets respeta INFISICAL_DISABLE', async () => {
    process.env.INFISICAL_DISABLE = '1';
    const result = await loadSecrets({
      fetch: async () => {
        throw new Error('no debería llamar a Infisical');
      },
    });
    assert.equal(result.source, 'disabled');
  });
});
