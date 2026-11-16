'use strict';

// Sesión revocable en SQLite (src/auth/session.js, src/auth/sessionConfig.js,
// el gate y src/auth/authRoutes.js): crear, inactividad, tope absoluto,
// revocación, logout, verify (siempre una sesión nueva), un correo sacado de
// la allowlist pierde el acceso, X-SL-Auto no renueva pero tampoco salva una
// sesión vencida, y la purga.
//
// Base temporal (MONITORING_DB_PATH antes de los require); los tiempos se
// manejan con `now` o moviendo last_seen_at/created_at en la base. App de
// prueba en un puerto local con el gate y las rutas de auth reales (el mail,
// de mentira); no carga server.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sesion-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.APP_BASE_URL = 'http://localhost';
delete process.env.SESSION_IDLE_MIN;
delete process.env.SESSION_MAX_HOURS;
const ALLOWLIST_INICIAL = 'ana@test.local;operador,sale@test.local;operador,lee@test.local';
process.env.ALLOWED_EMAILS = ALLOWLIST_INICIAL;

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const db = require('../src/db');
const session = require('../src/auth/session');
const { resolveSessionConfig } = require('../src/auth/sessionConfig');
const { createAuthGate } = require('../src/auth/gate');
const authRoutes = require('../src/auth/authRoutes');
const { issueMagicLink } = require('../src/auth/magicLink');

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const raw = new DatabaseSync(DB_PATH); // para mover los tiempos a mano

// Una sesión nueva: el id de la cookie y la línea Set-Cookie entera.
function nueva(email, opts) {
  let header = '';
  const sessionId = session.setSessionCookie({ append: (name, value) => (header = value) }, email, opts);
  const id = header.split(';')[0].split('=')[1];
  return { id, cookie: `sl_session=${id}`, header, sessionId };
}

const reqCon = (cookie, headers = {}) => ({ headers: { cookie, ...headers } });
const fila = (sessionId) => raw.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(sessionId);
const mover = (sessionId, campos) => {
  for (const [col, val] of Object.entries(campos)) {
    raw.prepare(`UPDATE sessions SET ${col} = ? WHERE id_hash = ?`).run(val, sessionId);
  }
};

let server;
let port;
const llegadas = [];

function pedir(method, rawPath, { cookie = null, headers = {}, body = null } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: text, location: res.headers.location || null, setCookie: res.headers['set-cookie'] || [] })
        );
      }
    );
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(createAuthGate());
  authRoutes.register(app, { sendMagicLinkEmail: async () => {} });
  app.use('/api', (req, res) => {
    llegadas.push(`${req.method} ${req.path}`);
    res.json({ llego: true });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  llegadas.length = 0;
  process.env.ALLOWED_EMAILS = ALLOWLIST_INICIAL;
});

describe('crear', () => {
  test('la cookie lleva solo un id al azar de 32 bytes; la base, su SHA-256', () => {
    const s = nueva('ana@test.local');
    assert.match(s.id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(s.id, 'base64url').length, 32);
    assert.equal(s.sessionId, crypto.createHash('sha256').update(s.id).digest('hex'));
    const f = fila(s.sessionId);
    assert.equal(f.email, 'ana@test.local');
    assert.equal(f.revoked, 0);
    // El id en claro no está en ninguna fila.
    const todo = JSON.stringify(raw.prepare('SELECT * FROM sessions').all());
    assert.ok(!todo.includes(s.id));
    assert.equal(nueva('ana@test.local').id === s.id, false, 'cada sesión tiene su id');
  });

  test('cookie httpOnly, sameSite strict, de 8 horas; secure solo con https', () => {
    const s = nueva('ana@test.local');
    assert.match(s.header, /HttpOnly/);
    assert.match(s.header, /SameSite=Strict/);
    assert.match(s.header, /Max-Age=28800/);
    assert.match(s.header, /Path=\//);
    assert.doesNotMatch(s.header, /Secure/);
    process.env.APP_BASE_URL = 'https://escucha.ejemplo.test';
    try {
      assert.match(nueva('ana@test.local').header, /Secure/);
    } finally {
      process.env.APP_BASE_URL = 'http://localhost';
    }
  });

  test('readSession: email, rol de la allowlist y sessionId (el hash)', () => {
    const s = nueva('lee@test.local');
    assert.deepEqual(session.readSession(reqCon(s.cookie)), { email: 'lee@test.local', role: 'lector', sessionId: s.sessionId });
    assert.equal(session.readSession(reqCon('sl_session=inventada')), null);
    assert.equal(session.readSession(reqCon(`sl_session=${'A'.repeat(43)}`)), null);
    assert.equal(session.readSession({ headers: {} }), null);
  });
});

describe('inactividad y tope absoluto', () => {
  test('sin actividad en SESSION_IDLE_MIN (30), la sesión se corta', () => {
    const t0 = Date.now();
    const s = nueva('ana@test.local', { now: t0 });
    assert.ok(session.readSession(reqCon(s.cookie), { now: t0 + 30 * MIN - 1 }));
    // Esa lectura renovó last_seen_at: la ventana corre desde ahí.
    assert.ok(session.readSession(reqCon(s.cookie), { now: t0 + 59 * MIN }));
    assert.equal(session.readSession(reqCon(s.cookie), { now: t0 + 59 * MIN + 30 * MIN + 1 }), null);
  });

  test('last_seen_at se actualiza como mucho una vez por minuto', () => {
    const t0 = Date.now();
    const s = nueva('ana@test.local', { now: t0 });
    session.readSession(reqCon(s.cookie), { now: t0 + 30 * 1000 });
    assert.equal(fila(s.sessionId).last_seen_at, t0);
    session.readSession(reqCon(s.cookie), { now: t0 + 61 * 1000 });
    assert.equal(fila(s.sessionId).last_seen_at, t0 + 61 * 1000);
  });

  test('a las SESSION_MAX_HOURS (8) del login se corta aunque haya actividad', () => {
    const t0 = Date.now();
    const s = nueva('ana@test.local', { now: t0 });
    let t = t0;
    while (t < t0 + 8 * HORA) {
      assert.ok(session.readSession(reqCon(s.cookie), { now: t }), `viva a las ${(t - t0) / HORA} h`);
      t += 20 * MIN;
    }
    assert.equal(session.readSession(reqCon(s.cookie), { now: t0 + 8 * HORA + 1 }), null);
  });

  test('los topes salen del .env; un valor mal escrito tira', () => {
    assert.deepEqual(resolveSessionConfig({}), { idleMin: 30, maxHours: 8, idleMs: 30 * MIN, maxMs: 8 * HORA });
    assert.deepEqual(resolveSessionConfig({ SESSION_IDLE_MIN: '15', SESSION_MAX_HOURS: ' 12 ' }).idleMin, 15);
    assert.equal(resolveSessionConfig({ SESSION_MAX_HOURS: '12' }).maxHours, 12);
    for (const malo of ['0', '-5', '30.5', '2.000', '1,5', 'treinta', '1e3']) {
      assert.throws(() => resolveSessionConfig({ SESSION_IDLE_MIN: malo }), /SESSION_IDLE_MIN/, malo);
      assert.throws(() => resolveSessionConfig({ SESSION_MAX_HOURS: malo }), /SESSION_MAX_HOURS/, malo);
    }
  });
});

describe('X-SL-Auto: las consultas automáticas no renuevan la sesión', { concurrency: false }, () => {
  test('readSession con el header valida pero no toca last_seen_at', () => {
    const t0 = Date.now();
    const s = nueva('ana@test.local', { now: t0 });
    const auto = reqCon(s.cookie, { 'x-sl-auto': '1' });
    assert.ok(session.readSession(auto, { now: t0 + 10 * MIN }));
    assert.equal(fila(s.sessionId).last_seen_at, t0);
    // Solo pedidos automáticos: a los 30 min se corta igual.
    assert.equal(session.readSession(auto, { now: t0 + 30 * MIN + 1 }), null);
  });

  test('por HTTP: un pedido con X-SL-Auto no renueva; uno sin el header, sí', async () => {
    const s = nueva('ana@test.local');
    const hace5 = Date.now() - 5 * MIN;
    mover(s.sessionId, { last_seen_at: hace5 });
    const auto = await pedir('GET', '/api/monitoring/status', { cookie: s.cookie, headers: { 'X-SL-Auto': '1' } });
    assert.equal(auto.status, 200);
    assert.equal(fila(s.sessionId).last_seen_at, hace5);
    const manual = await pedir('GET', '/api/monitoring/status', { cookie: s.cookie });
    assert.equal(manual.status, 200);
    assert.ok(fila(s.sessionId).last_seen_at > hace5);
  });

  test('por HTTP: una sesión vencida da 401 aunque el pedido sea automático', async () => {
    const s = nueva('ana@test.local');
    mover(s.sessionId, { last_seen_at: Date.now() - 31 * MIN });
    const res = await pedir('GET', '/api/monitoring/status', { cookie: s.cookie, headers: { 'X-SL-Auto': '1' } });
    assert.equal(res.status, 401);
    // La cookie que ya no es una sesión se borra.
    assert.ok(res.setCookie.some((c) => /^sl_session=;/.test(c) && /Max-Age=0/.test(c)), res.setCookie.join(' | '));
    // Vencida por el tope absoluto, igual.
    const s2 = nueva('ana@test.local');
    mover(s2.sessionId, { created_at: Date.now() - 8 * HORA - MIN });
    assert.equal((await pedir('GET', '/api/monitoring/status', { cookie: s2.cookie, headers: { 'X-SL-Auto': '1' } })).status, 401);
    assert.deepEqual(llegadas, [], 'ninguna de las dos llegó al handler');
  });
});

describe('revocación, logout y verify', { concurrency: false }, () => {
  test('una sesión revocada no vale más', async () => {
    const s = nueva('ana@test.local');
    assert.equal((await pedir('GET', '/api/x', { cookie: s.cookie })).status, 200);
    assert.equal(session.revokeRequestSession(reqCon(s.cookie)), true);
    assert.equal(session.readSession(reqCon(s.cookie)), null);
    assert.equal((await pedir('GET', '/api/x', { cookie: s.cookie })).status, 401);
  });

  test('logout revoca en la base y borra la cookie: copiada, tampoco sirve', async () => {
    const s = nueva('lee@test.local'); // un lector también puede salir
    const res = await pedir('POST', '/api/auth/logout', { cookie: s.cookie, body: {} });
    assert.equal(res.status, 204);
    assert.ok(res.setCookie.some((c) => /^sl_session=;/.test(c)));
    assert.equal(fila(s.sessionId).revoked, 1);
    assert.equal((await pedir('GET', '/api/x', { cookie: s.cookie })).status, 401);
  });

  test('/api/auth/me devuelve email y rol', async () => {
    const s = nueva('lee@test.local');
    const me = await pedir('GET', '/api/auth/me', { cookie: s.cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(JSON.parse(me.body), { email: 'lee@test.local', role: 'lector' });
    assert.equal((await pedir('GET', '/api/auth/me')).status, 401);
  });

  test('verify: siempre una sesión nueva (JSON), y la de la cookie anterior se revoca', async () => {
    const vieja = nueva('ana@test.local');
    const { rawToken } = issueMagicLink('ana@test.local');
    const res = await pedir('POST', '/api/auth/verify', { cookie: vieja.cookie, body: { token: rawToken } });
    assert.equal(res.status, 302);
    assert.equal(res.location, '/dashboard.html');
    const set = res.setCookie.find((c) => /^sl_session=[A-Za-z0-9_-]{43};/.test(c));
    assert.ok(set, res.setCookie.join(' | '));
    const nuevaCookie = set.split(';')[0];
    assert.notEqual(nuevaCookie, vieja.cookie);
    assert.equal(fila(vieja.sessionId).revoked, 1);
    assert.equal((await pedir('GET', '/api/x', { cookie: vieja.cookie })).status, 401);
    assert.equal((await pedir('GET', '/api/x', { cookie: nuevaCookie })).status, 200);
    // El mismo token no entra dos veces.
    assert.equal((await pedir('POST', '/api/auth/verify', { body: { token: rawToken } })).status, 400);
  });
});

describe('allowlist: un correo que sale pierde el acceso', { concurrency: false }, () => {
  test('en el próximo pedido: 401, cookie borrada y TODAS sus sesiones revocadas', async () => {
    const a = nueva('sale@test.local');
    const b = nueva('sale@test.local');
    assert.equal((await pedir('GET', '/api/x', { cookie: a.cookie })).status, 200);

    process.env.ALLOWED_EMAILS = 'ana@test.local;operador';
    const res = await pedir('GET', '/api/x', { cookie: a.cookie });
    assert.equal(res.status, 401);
    assert.ok(res.setCookie.some((c) => /^sl_session=;/.test(c)));
    assert.equal(fila(a.sessionId).revoked, 1);
    assert.equal(fila(b.sessionId).revoked, 1);

    // Si vuelve a la allowlist, las sesiones de antes siguen revocadas.
    process.env.ALLOWED_EMAILS = ALLOWLIST_INICIAL;
    assert.equal((await pedir('GET', '/api/x', { cookie: b.cookie })).status, 401);
    // Una página tampoco: al login.
    const pag = await pedir('GET', '/dashboard.html', { cookie: b.cookie });
    assert.equal(pag.status, 302);
    assert.equal(pag.location, '/');
  });

  test('un cambio de rol vale en el próximo pedido, sin volver a entrar', async () => {
    const s = nueva('sale@test.local');
    assert.equal((await pedir('POST', '/api/monitoring/run-now', { cookie: s.cookie, body: {} })).status, 200);
    process.env.ALLOWED_EMAILS = 'sale@test.local';
    assert.equal((await pedir('POST', '/api/monitoring/run-now', { cookie: s.cookie, body: {} })).status, 403);
  });
});

describe('purga', () => {
  test('borra revocadas, inactivas y vencidas; deja las vivas', () => {
    raw.exec('DELETE FROM sessions');
    const t0 = Date.now();
    const viva = nueva('ana@test.local', { now: t0 - 5 * MIN });
    const revocada = nueva('ana@test.local', { now: t0 });
    session.revokeRequestSession(reqCon(revocada.cookie));
    const inactiva = nueva('ana@test.local', { now: t0 - 31 * MIN });
    const vieja = nueva('ana@test.local', { now: t0 - 9 * HORA });
    mover(vieja.sessionId, { last_seen_at: t0 - MIN });
    assert.equal(session.purgeExpiredSessions({ now: t0 }), 3);
    assert.ok(fila(viva.sessionId));
    for (const s of [revocada, inactiva, vieja]) assert.equal(fila(s.sessionId), undefined);
  });
});
