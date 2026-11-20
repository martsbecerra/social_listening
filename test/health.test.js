'use strict';

// GET /health (src/healthRoutes.js, rama rate-limit-y-salud): responde sin
// sesión, aunque el gate esté delante; 200 { status, db, uptime } y nada
// más; 503 si la base no responde (db.ping tira o no da 1); sin límite de
// pedidos aunque los límites sean mínimos; no-store; y en server.js va antes
// del límite de rechazados y del gate. Base temporal; no carga server.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-health-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.APP_BASE_URL = 'http://localhost';
process.env.ALLOWED_EMAILS = 'alguien@test.local;operador';
process.env.RATE_LIMIT_API_MAX = '1';
process.env.RATE_LIMIT_RECHAZOS_MAX = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const healthRoutes = require('../src/healthRoutes');
const rateLimits = require('../src/rateLimits');
const { createAuthGate } = require('../src/auth/gate');

const ROOT = path.join(__dirname, '..');
let server;
let port;
const pingReal = db.ping;
const consoleError = console.error;
const errores = [];

function pedir(rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  console.error = (...args) => errores.push(args.map(String).join(' '));
  const app = express();
  // El peor caso: el gate y todos los límites DELANTE de /health.
  app.use(rateLimits.limites().rechazados);
  app.use(createAuthGate({ confirmarBajaMs: 5 }));
  rateLimits.registrarLimites(app);
  healthRoutes.register(app, { uptime: () => 123.9 });
  app.get('/api/otra', (req, res) => res.json({ ok: true }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  console.error = consoleError;
  db.ping = pingReal;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('sin sesión, 200 con { status, db, uptime } y nada más, sin caché', async () => {
  const r = await pedir('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'ok', db: 'ok', uptime: 123 });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal((await pedir('/health', 'HEAD')).status, 200);
  // Un /api sin sesión, en cambio, es 401.
  assert.equal((await pedir('/api/otra')).status, 401);
});

test('sin límite de pedidos: con los límites en 1, cuarenta seguidos dan 200', async () => {
  for (let i = 0; i < 40; i++) assert.equal((await pedir('/health')).status, 200);
});

test('503 si la base no responde (tira o no da 1), con una línea de log', async () => {
  db.ping = () => {
    const err = new Error('disk I/O error');
    err.code = 'ERR_SQLITE_ERROR';
    throw err;
  };
  const r = await pedir('/health');
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { status: 'error', db: 'error', uptime: 123 });
  assert.ok(errores.some((l) => l.includes('[health]') && l.includes('ERR_SQLITE_ERROR')));

  db.ping = () => false;
  assert.equal((await pedir('/health')).status, 503);

  db.ping = pingReal;
  assert.equal((await pedir('/health')).status, 200);
});

test('db.ping hace un SELECT 1 de verdad', () => {
  assert.equal(pingReal(), true);
});

test('server.js: /health va antes del límite de rechazados y del gate', () => {
  const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const health = code.indexOf('healthRoutes.register(app)');
  assert.ok(health > code.indexOf('app.use(securityHeaders())'));
  assert.ok(health < code.indexOf('app.use(rateLimits.limites().rechazados)'));
  assert.ok(health < code.indexOf('app.use(createAuthGate())'));
});
