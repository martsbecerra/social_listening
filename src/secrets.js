// ==========================================================================
// secrets.js
// --------------------------------------------------------------------------
// Carga las variables de entorno desde Infisical (proyecto "Social Listening")
// y las deja en process.env. Reemplaza al .env local: la app ya no lee un
// archivo de claves.
//
// Auth, en este orden:
//   1. Machine identity: INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
//   2. Token ya emitido: INFISICAL_TOKEN o INFISICAL_ACCESS_TOKEN
//   3. CLI local: `infisical login` (usa el token del usuario)
//
// El project id y el env default salen de .infisical.json; se pueden pisar
// con INFISICAL_PROJECT_ID e INFISICAL_ENV. INFISICAL_DISABLE=1 saltea la
// carga (útil en tests). Las variables que el proceso ya tiene (no vacías)
// no se pisan: Railway/el host ganan.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INFISICAL_JSON = path.join(ROOT, '.infisical.json');
const LOADED_FLAG = '__INFISICAL_SECRETS_LOADED';
const DEFAULT_SITE_URL = 'https://app.infisical.com';

function readInfisicalJson(filePath = INFISICAL_JSON) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeSiteUrl(raw) {
  return String(raw || DEFAULT_SITE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}

function readConfig(filePath = INFISICAL_JSON) {
  const file = readInfisicalJson(filePath);
  const projectId = (process.env.INFISICAL_PROJECT_ID || file.workspaceId || '').trim();
  const environment = (
    process.env.INFISICAL_ENV ||
    process.env.INFISICAL_ENVIRONMENT ||
    file.defaultEnvironment ||
    'dev'
  ).trim();
  const secretPath = (process.env.INFISICAL_SECRET_PATH || '/').trim() || '/';
  const siteUrl = normalizeSiteUrl(
    process.env.INFISICAL_SITE_URL || process.env.INFISICAL_DOMAIN || file.domain
  );

  if (!projectId) {
    throw new Error(
      'Falta el project id de Infisical. Corré `infisical init` o seteá INFISICAL_PROJECT_ID.'
    );
  }

  return { projectId, environment, secretPath, siteUrl };
}

function parseCliToken(out) {
  const lines = String(out || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jwt = lines.find((line) => /^eyJ/.test(line));
  return jwt || lines[lines.length - 1] || '';
}

function cliUserToken() {
  try {
    const out = execFileSync('infisical', ['user', 'get', 'token', '--plain', '--silent'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, INFISICAL_DISABLE_UPDATE_CHECK: 'true' },
    });
    return parseCliToken(out);
  } catch {
    return '';
  }
}

async function loginUniversalAuth(siteUrl, clientId, clientSecret, fetchFn = fetch) {
  const resp = await fetchFn(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.accessToken) {
    throw new Error(
      `Infisical universal auth falló (HTTP ${resp.status}): ${body.message || 'sin detalle'}`
    );
  }
  return body.accessToken;
}

async function resolveAccessToken(siteUrl, options = {}) {
  if (options.accessToken) {
    return { token: options.accessToken, source: 'injected' };
  }

  const clientId = (process.env.INFISICAL_CLIENT_ID || '').trim();
  const clientSecret = (process.env.INFISICAL_CLIENT_SECRET || '').trim();
  if (clientId && clientSecret) {
    const fetchFn = options.fetch || fetch;
    return {
      token: await loginUniversalAuth(siteUrl, clientId, clientSecret, fetchFn),
      source: 'universal-auth',
    };
  }

  const envToken = (process.env.INFISICAL_TOKEN || process.env.INFISICAL_ACCESS_TOKEN || '').trim();
  if (envToken) return { token: envToken, source: 'token' };

  const fromCli = options.cliUserToken ? options.cliUserToken() : cliUserToken();
  if (fromCli) return { token: fromCli, source: 'cli' };

  throw new Error(
    'No hay credenciales de Infisical. En local: `infisical login`. ' +
      'En prod: INFISICAL_CLIENT_ID e INFISICAL_CLIENT_SECRET (machine identity).'
  );
}

function secretsArrayToRecord(secrets) {
  const record = {};
  for (const item of secrets || []) {
    const key = item.secretKey || item.key;
    if (!key) continue;
    if (record[key] !== undefined) continue;
    const value = item.secretValue != null ? item.secretValue : item.value;
    record[key] = value == null ? '' : String(value);
  }
  return record;
}

async function fetchSecretsRecord(options = {}) {
  const config = options.config || readConfig();
  const tokenInfo = await resolveAccessToken(config.siteUrl, options);
  const params = new URLSearchParams({
    workspaceId: config.projectId,
    environment: config.environment,
    secretPath: config.secretPath || '/',
    include_imports: 'true',
    expandSecretReferences: 'true',
  });
  const url = `${config.siteUrl}/api/v3/secrets/raw?${params}`;
  const fetchFn = options.fetch || fetch;
  const resp = await fetchFn(url, {
    headers: { Authorization: `Bearer ${tokenInfo.token}` },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `Infisical no devolvió los secrets (HTTP ${resp.status}): ${body.message || 'sin detalle'}`
    );
  }

  const record = secretsArrayToRecord(body.secrets);
  if (Array.isArray(body.imports)) {
    for (const imported of body.imports) {
      const extra = secretsArrayToRecord(imported.secrets);
      for (const [key, value] of Object.entries(extra)) {
        if (record[key] === undefined) record[key] = value;
      }
    }
  }

  return {
    secrets: record,
    source: tokenInfo.source,
    environment: config.environment,
    count: Object.keys(record).length,
  };
}

function applySecrets(record) {
  let applied = 0;
  for (const [key, value] of Object.entries(record || {})) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      applied += 1;
    }
  }
  return applied;
}

async function loadSecrets(options = {}) {
  if (process.env.INFISICAL_DISABLE === '1') {
    return { source: 'disabled', count: 0, applied: 0 };
  }
  if (process.env[LOADED_FLAG] === '1') {
    return { source: 'already-loaded', count: 0, applied: 0 };
  }
  const result = await fetchSecretsRecord(options);
  const applied = applySecrets(result.secrets);
  process.env[LOADED_FLAG] = '1';
  return {
    source: result.source,
    count: result.count,
    applied,
    environment: result.environment,
  };
}

function loadSecretsSync() {
  if (process.env.INFISICAL_DISABLE === '1') {
    return { source: 'disabled', count: 0, applied: 0 };
  }
  if (process.env[LOADED_FLAG] === '1') {
    return { source: 'already-loaded', count: 0, applied: 0 };
  }

  const child = spawnSync(process.execPath, [path.join(__dirname, 'secretsDump.js')], {
    encoding: 'utf8',
    env: { ...process.env, INFISICAL_DISABLE_UPDATE_CHECK: 'true' },
    timeout: 45000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status !== 0) {
    const msg = (child.stderr || child.stdout || 'Error desconocido').trim();
    throw new Error(msg || `Infisical dump salió con código ${child.status}`);
  }

  let payload;
  try {
    payload = JSON.parse(child.stdout);
  } catch {
    throw new Error('Infisical devolvió una respuesta que no es JSON al cargar secrets.');
  }

  const applied = applySecrets(payload.secrets);
  process.env[LOADED_FLAG] = '1';
  if (!process.env.INFISICAL_QUIET) {
    console.log(
      `[infisical] ${payload.count} secretos cargados (${payload.source}, env=${payload.environment})`
    );
  }
  return {
    source: payload.source,
    count: payload.count,
    applied,
    environment: payload.environment,
  };
}

function loadSecretsOrExit() {
  try {
    return loadSecretsSync();
  } catch (err) {
    console.error(`\n❌ No se pueden leer los secrets de Infisical:\n    ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  readConfig,
  fetchSecretsRecord,
  applySecrets,
  loadSecrets,
  loadSecretsSync,
  loadSecretsOrExit,
  parseCliToken,
};
