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

async function modeOf(options) {
  const app = express();
  replicaRoutes.register(app, options);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/app/mode`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

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
  const { body } = await modeOf({ mode: 'replica', infoPath, appVersion: 'abc1234' });
  assert.deepEqual(body, {
    mode: 'replica',
    readOnly: true,
    dataAsOf: '2026-10-20T14:40:00.000Z',
    runId: 9,
    appVersion: 'abc1234',
    snapshotAppVersion: 'abc1234',
    newerAppAvailable: false,
  });
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
