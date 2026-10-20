'use strict';

// server.js con APP_MODE=replica (REQ-REP-01, REQ-REP-04, REQ-REP-05): arranca
// sin claves de Apify, LLM, SMTP ni SESSION_SECRET, sin pedir login, responde
// 403 a lo que escribe, 421 a un Host ajeno, y GET /api/app/mode dice que es
// de solo lectura.
//
// Se lanza `node server.js` como proceso hijo con una base y carpetas
// temporales. Las claves van vacías a propósito (dotenv no pisa una
// variable que ya existe, aunque esté vacía) y el cron apunta a una fecha que
// no existe: aunque algo fallara, el hijo no puede llamar a Apify ni a un
// LLM. Sin repo de datos: el sondeo falla y se loguea, sin salir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-replica-server-'));

let child;
let port;
let output = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

before(async () => {
  port = await freePort();
  const configPath = path.join(tmp, 'monitoring.json');
  fs.writeFileSync(configPath, JSON.stringify({ instagram: { accounts: [], keywords: [], searches: [] }, x: { accounts: [], keywords: [] } }));
  fs.writeFileSync(
    path.join(tmp, 'replica-snapshot.json'),
    JSON.stringify({ publishedAt: '2026-10-20T14:40:00.000Z', runId: 9, appVersion: null })
  );
  const env = {
    ...process.env,
    APP_MODE: 'replica',
    PORT: String(port),
    MONITORING_DB_PATH: path.join(tmp, 'monitoring.db'),
    MONITORING_CONFIG_PATH: configPath,
    MONITORING_X_CONFIG_PATH: path.join(tmp, 'monitoring-x.json'),
    MONITORING_MEDIA_DIR: path.join(tmp, 'media'),
    REPLICA_DATA_DIR: path.join(tmp, 'replica-datos'),
    REPLICA_POLL_MINUTES: '600',
    MONITOR_CRON: '0 0 31 2 *',
    KEEP_AWAKE: '0',
    APIFY_API_TOKEN: '',
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    XAI_API_KEY: '',
    SESSION_SECRET: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    REPLICA_PUBLISH_DIR: '',
  };
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`el server no arrancó:\n${output}`)), 20000);
    const check = setInterval(() => {
      // La última línea del banner: las anteriores ya llegaron.
      if (output.includes('se revisa si hay nuevos')) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 50);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error(`el server salió con ${code}:\n${output}`));
    });
  });
});

after(() => {
  if (child && child.exitCode === null) child.kill();
});

function pedir(method, p) {
  return fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
    redirect: 'manual',
  });
}

test('arranca sin claves y dice que es una réplica', () => {
  assert.match(output, /Servidor listo/);
  assert.match(output, /réplica de solo lectura/i);
  assert.doesNotMatch(output, /No se puede arrancar/);
});

test('GET /api/app/mode: solo lectura, con la fecha de los datos', async () => {
  const res = await pedir('GET', '/api/app/mode');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.dataAsOf, '2026-10-20T14:40:00.000Z');
});

test('lee sin login', async () => {
  const res = await pedir('GET', '/api/monitoring/posts?plataforma=instagram&pageSize=10');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).posts, []);
});

test('"Actualizar ahora" y el análisis responden 403', async () => {
  for (const p of ['/api/monitoring/run-now?plataforma=instagram', '/api/analyze']) {
    const res = await pedir('POST', p);
    assert.equal(res.status, 403, p);
  }
});

test('un Host ajeno responde 421', async () => {
  // fetch no deja cambiar el Host: http.request sí.
  const status = await new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: '/api/app/mode', headers: { Host: `evil.example:${port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 421);
});

test('la página de login redirige al dashboard', async () => {
  const res = await pedir('GET', '/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard.html');
});
