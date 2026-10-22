'use strict';

// "escuchando · HH:MM" de la barra superior (diseño v4):
// db.getLastFinishedRunAt lee monitoring_runs por plataforma, sea la corrida
// de esa red sola, de varias juntas o de todas, y solo las terminadas;
// db.getLastFinishedRunAtAny, la última de cualquier red (el inicio). Base
// temporal; nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ultima-corrida-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');

function corrida(plataforma, startedAt, finishedAt) {
  const id = db.startMonitoringRun({ trigger: 'cron', plataforma, startedAt });
  if (finishedAt) db.finishMonitoringRun(id, { finishedAt });
  return id;
}

describe('db.getLastFinishedRunAt', { concurrency: false }, () => {
  test('sin corridas: null', () => {
    assert.equal(db.getLastFinishedRunAt('instagram'), null);
    assert.equal(db.getLastFinishedRunAt('x'), null);
  });

  test('una red sola, varias juntas o todas; la más nueva gana', () => {
    corrida('instagram', '2026-10-20T11:00:00.000Z', '2026-10-20T11:05:00.000Z');
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T11:05:00.000Z');
    assert.equal(db.getLastFinishedRunAt('x'), null, 'una corrida de Instagram no es de X');

    corrida('instagram,x', '2026-10-20T15:00:00.000Z', '2026-10-20T15:07:00.000Z');
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T15:07:00.000Z');
    assert.equal(db.getLastFinishedRunAt('x'), '2026-10-20T15:07:00.000Z');

    corrida('x', '2026-10-20T16:00:00.000Z', '2026-10-20T16:02:00.000Z');
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T15:07:00.000Z', 'la de X sola no cuenta para Instagram');
    assert.equal(db.getLastFinishedRunAt('x'), '2026-10-20T16:02:00.000Z');

    corrida('todas', '2026-10-20T19:00:00.000Z', '2026-10-20T19:04:00.000Z');
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T19:04:00.000Z');
    assert.equal(db.getLastFinishedRunAt('x'), '2026-10-20T19:04:00.000Z');
  });

  test('una corrida en curso (sin terminar) no cuenta', () => {
    corrida('instagram', '2026-10-20T23:00:00.000Z', null);
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T19:04:00.000Z');
  });

  test('el nombre de una red no matchea dentro de otro', () => {
    corrida('xinstagram', '2026-10-21T08:00:00.000Z', '2026-10-21T08:01:00.000Z');
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T19:04:00.000Z');
    assert.equal(db.getLastFinishedRunAt('x'), '2026-10-20T19:04:00.000Z');
  });

  test('sin plataforma tira, como toda función por plataforma', () => {
    assert.throws(() => db.getLastFinishedRunAt(), /falta plataforma/);
    assert.throws(() => db.getLastFinishedRunAt(''), /falta plataforma/);
  });
});

describe('db.getLastFinishedRunAtAny', { concurrency: false }, () => {
  test('la más nueva de cualquier red, sola o junto con otras', () => {
    // La última de las de arriba es la de "xinstagram", del 21/10 08:01.
    assert.equal(db.getLastFinishedRunAtAny(), '2026-10-21T08:01:00.000Z');

    corrida('x', '2026-10-21T11:00:00.000Z', '2026-10-21T11:03:00.000Z');
    assert.equal(db.getLastFinishedRunAtAny(), '2026-10-21T11:03:00.000Z', 'una de X sola también cuenta');
    assert.equal(db.getLastFinishedRunAt('instagram'), '2026-10-20T19:04:00.000Z', 'y no cambia la de Instagram');

    corrida('instagram,x', '2026-10-21T15:00:00.000Z', '2026-10-21T15:06:00.000Z');
    assert.equal(db.getLastFinishedRunAtAny(), '2026-10-21T15:06:00.000Z');
  });

  test('una corrida en curso no cuenta', () => {
    corrida('instagram', '2026-10-21T19:00:00.000Z', null);
    assert.equal(db.getLastFinishedRunAtAny(), '2026-10-21T15:06:00.000Z');
  });
});
