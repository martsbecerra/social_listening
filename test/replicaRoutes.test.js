'use strict';

// GET /api/app/mode (src/replicaRoutes.js, REQ-REP-08): el frontend sabe si
// está en una réplica, de cuándo son los datos y si hay una versión nueva
// de la app. App de prueba en un puerto local, sin server.js ni base.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const replicaRoutes = require('../src/replicaRoutes');

function replicaStub(overrides = {}) {
  const calls = { checkForUpdate: 0, verifyToken: [], saveToken: [], restart: 0 };
  let onRestart;
  const restarted = new Promise((resolve) => (onRestart = resolve));
  const stub = {
    hasToken: () => true,
    checkForUpdate: async () => {
      calls.checkForUpdate++;
      return 'same';
    },
    verifyToken: async (token) => {
      calls.verifyToken.push(token);
      return { ok: true };
    },
    saveToken: (token) => calls.saveToken.push(token),
    restart: () => {
      calls.restart++;
      onRestart();
    },
    ...overrides,
  };
  return { stub, calls, restarted };
}

async function withApp(options, fn) {
  const app = express();
  app.use(express.json());
  replicaRoutes.register(app, { replica: replicaStub().stub, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function modeOf(options) {
  return withApp(options, async (base) => {
    const res = await fetch(`${base}/api/app/mode`);
    return { status: res.status, body: await res.json() };
  });
}

async function post(options, rawPath, body) {
  return withApp(options, async (base) => {
    const res = await fetch(`${base}${rawPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  });
}

function eventually(promise, ms = 2000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('no reinició')), ms))]);
}

const INFO = { publishedAt: '2026-10-20T14:40:00.000Z', runId: 9, appVersion: 'abc1234' };

function infoFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mode-'));
  const file = path.join(dir, 'replica-snapshot.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('principal: no es de solo lectura', async () => {
  const { status, body } = await modeOf({ mode: 'principal', infoPath: infoFile(), appVersion: 'abc1234' });
  assert.equal(status, 200);
  assert.deepEqual(body, { mode: 'principal', readOnly: false });
});

test('réplica: fecha de los datos, ciclo y versiones', async () => {
  const infoPath = infoFile({ publishedAt: '2026-10-20T14:40:00.000Z', runId: 9, appVersion: 'abc1234' });
  const { body } = await modeOf({ mode: 'replica', infoPath, appVersion: 'abc1234', bootId: 'b1' });
  assert.deepEqual(body, {
    mode: 'replica',
    readOnly: true,
    dataAsOf: '2026-10-20T14:40:00.000Z',
    runId: 9,
    appVersion: 'abc1234',
    snapshotAppVersion: 'abc1234',
    newerAppAvailable: false,
    needsToken: false,
    bootId: 'b1',
  });
});

test('réplica: bootId del arranque (la página sabe cuándo la app ya se reinició)', async () => {
  const { body } = await modeOf({ mode: 'replica', infoPath: infoFile(INFO), appVersion: null, bootId: 'arranque-1' });
  assert.equal(body.bootId, 'arranque-1');
});

test('réplica sin token de lectura: needsToken (el frontend muestra el modal)', async () => {
  const { stub } = replicaStub({ hasToken: () => false });
  const { body } = await modeOf({ mode: 'replica', infoPath: infoFile(), appVersion: null, replica: stub });
  assert.equal(body.needsToken, true);
});

test('buscar datos nuevos: hay → 202 y reinicia después de responder', async () => {
  const { stub, calls, restarted } = replicaStub({ checkForUpdate: async () => 'new' });
  const res = await post({ mode: 'replica', infoPath: infoFile(INFO), appVersion: null, replica: stub }, '/api/replica/refresh');
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { status: 'actualizando' });
  await eventually(restarted);
  assert.equal(calls.restart, 1);
});

test('buscar datos nuevos: ya está al día → 200, sin reiniciar', async () => {
  const { stub, calls } = replicaStub({ checkForUpdate: async () => 'same' });
  const res = await post({ mode: 'replica', infoPath: infoFile(INFO), appVersion: null, replica: stub }, '/api/replica/refresh');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'al-dia' });
  assert.equal(calls.restart, 0);
});

test('buscar datos nuevos: sin conexión → 502 con mensaje, sin reiniciar', async () => {
  const { stub, calls } = replicaStub({ checkForUpdate: async () => 'error' });
  const res = await post({ mode: 'replica', infoPath: infoFile(INFO), appVersion: null, replica: stub }, '/api/replica/refresh');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /No se pudo consultar/);
  assert.equal(calls.restart, 0);
});

test('buscar datos nuevos sin token → 409, no consulta', async () => {
  const { stub, calls } = replicaStub({ hasToken: () => false });
  const res = await post({ mode: 'replica', infoPath: infoFile(), appVersion: null, replica: stub }, '/api/replica/refresh');
  assert.equal(res.status, 409);
  assert.equal(calls.checkForUpdate, 0);
});

test('token: lo prueba, lo guarda, no lo devuelve y reinicia', async () => {
  const { stub, calls, restarted } = replicaStub({ hasToken: () => false });
  const res = await post({ mode: 'replica', infoPath: infoFile(), appVersion: null, replica: stub }, '/api/replica/token', {
    token: '  github_pat_prueba123  ',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'guardado' });
  assert.doesNotMatch(res.text, /github_pat_prueba123/);
  assert.deepEqual(calls.verifyToken, ['github_pat_prueba123']);
  assert.deepEqual(calls.saveToken, ['github_pat_prueba123']);
  await eventually(restarted);
});

for (const token of [undefined, '', '   ', 'con espacio', 'dos\nlineas', 'x'.repeat(501)]) {
  test(`token inválido (${JSON.stringify(token)?.slice(0, 20)}) → 400 sin probarlo`, async () => {
    const { stub, calls } = replicaStub();
    const res = await post({ mode: 'replica', infoPath: infoFile(), appVersion: null, replica: stub }, '/api/replica/token', { token });
    assert.equal(res.status, 400);
    assert.deepEqual(calls.verifyToken, []);
    assert.deepEqual(calls.saveToken, []);
  });
}

for (const [reason, status, pattern] of [
  ['acceso', 400, /no puede leer el repo de datos/],
  ['red', 502, /conexión/],
  ['sin-repo', 409, /repo de datos/],
]) {
  test(`token que no sirve (${reason}) → ${status}, no se guarda ni reinicia`, async () => {
    const { stub, calls } = replicaStub({ verifyToken: async () => ({ ok: false, reason }) });
    const res = await post({ mode: 'replica', infoPath: infoFile(), appVersion: null, replica: stub }, '/api/replica/token', { token: 'abc' });
    assert.equal(res.status, status);
    assert.match(res.body.error, pattern);
    assert.deepEqual(calls.saveToken, []);
    assert.equal(calls.restart, 0);
  });
}

test('token: si no se puede escribir el .env → 500 con mensaje, sin reiniciar', async () => {
  const { stub, calls } = replicaStub({
    saveToken: () => {
      throw new Error('EPERM: operation not permitted');
    },
  });
  const res = await post({ mode: 'replica', infoPath: infoFile(), appVersion: null, replica: stub }, '/api/replica/token', { token: 'abc' });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /No se pudo guardar el token/);
  assert.equal(calls.restart, 0);
});

test('en la principal no existen las acciones de la copia', async () => {
  const { stub, calls } = replicaStub();
  for (const rawPath of ['/api/replica/refresh', '/api/replica/token']) {
    const res = await withApp({ mode: 'principal', infoPath: infoFile(), appVersion: null, replica: stub }, (base) =>
      fetch(`${base}${rawPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"a"}' })
    );
    assert.equal(res.status, 404);
  }
  assert.equal(calls.checkForUpdate + calls.verifyToken.length, 0);
});

test('réplica con otra versión que la de la principal: avisa', async () => {
  const infoPath = infoFile({ publishedAt: '2026-10-20T14:40:00.000Z', runId: 9, appVersion: 'def5678' });
  const { body } = await modeOf({ mode: 'replica', infoPath, appVersion: 'abc1234' });
  assert.equal(body.newerAppAvailable, true);
});

test('sin alguna de las dos versiones no avisa', async () => {
  const infoPath = infoFile({ publishedAt: '2026-10-20T14:40:00.000Z', runId: 9, appVersion: null });
  assert.equal((await modeOf({ mode: 'replica', infoPath, appVersion: 'abc1234' })).body.newerAppAvailable, false);
  const infoPath2 = infoFile({ publishedAt: '2026-10-20T14:40:00.000Z', runId: 9, appVersion: 'def5678' });
  assert.equal((await modeOf({ mode: 'replica', infoPath: infoPath2, appVersion: null })).body.newerAppAvailable, false);
});

test('réplica sin datos todavía (o snapshot roto): dataAsOf null', async () => {
  for (const infoPath of [infoFile(), infoFile('{ roto')]) {
    const { body } = await modeOf({ mode: 'replica', infoPath, appVersion: 'abc1234' });
    assert.equal(body.readOnly, true);
    assert.equal(body.dataAsOf, null);
    assert.equal(body.runId, null);
    assert.equal(body.newerAppAvailable, false);
  }
});

test('lee el snapshot en cada pedido: cambia con cada sincronización', async () => {
  const infoPath = infoFile({ publishedAt: '2026-10-20T10:00:00.000Z', runId: 1, appVersion: null });
  assert.equal((await modeOf({ mode: 'replica', infoPath, appVersion: null })).body.runId, 1);
  fs.writeFileSync(infoPath, JSON.stringify({ publishedAt: '2026-10-20T14:00:00.000Z', runId: 2, appVersion: null }));
  assert.equal((await modeOf({ mode: 'replica', infoPath, appVersion: null })).body.runId, 2);
});
