'use strict';

// src/replicaPoller.js (REQ-REP-07): la réplica compara cada tanto el commit
// remoto de la rama snapshot con el que tiene; si cambió, sale con 75 para
// que el lanzador sincronice y la vuelva a levantar. Un error al consultar
// se loguea y no termina el proceso. git y exit simulados.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createReplicaPoller, RESTART_EXIT_CODE } = require('../src/replicaPoller');

function cloneDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-poller-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const REPO_URL = 'https://github.com/ejemplo/datos.git';

const REMOTO = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const LOCAL = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';

function fakeGit({ remote = REMOTO, local = LOCAL, failRemote = false } = {}) {
  const calls = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'ls-remote') {
        if (failRemote) throw new Error('git ls-remote falló: Could not resolve host');
        return remote ? `${remote}\trefs/heads/snapshot\n` : '';
      }
      if (args[0] === 'rev-parse') return `${local}\n`;
      throw new Error(`git ${args[0]} inesperado`);
    },
  };
}

function poller(git, extra = {}) {
  const exits = [];
  const errores = [];
  const p = createReplicaPoller({
    dataDir: cloneDir(),
    repoUrl: REPO_URL,
    git,
    exit: (code) => exits.push(code),
    log: () => {},
    error: (m) => errores.push(m),
    ...extra,
  });
  return { p, exits, errores };
}

test('mismo commit: sigue', async () => {
  const { p, exits } = poller(fakeGit({ remote: LOCAL, local: LOCAL }));
  assert.equal(await p.checkOnce(), 'same');
  assert.deepEqual(exits, []);
});

test('commit distinto: sale con 75', async () => {
  const { p, exits } = poller(fakeGit());
  assert.equal(await p.checkOnce(), 'new');
  assert.deepEqual(exits, [RESTART_EXIT_CODE]);
  assert.equal(RESTART_EXIT_CODE, 75);
});

test('consulta ls-remote de la rama snapshot en el clon', async () => {
  const git = fakeGit({ remote: LOCAL, local: LOCAL });
  const { p } = poller(git);
  await p.checkOnce();
  assert.deepEqual(git.calls[0], ['ls-remote', 'origin', 'refs/heads/snapshot']);
  assert.deepEqual(git.calls[1], ['rev-parse', 'HEAD']);
});

test('sin red: lo loguea y sigue, sin salir', async () => {
  const { p, exits, errores } = poller(fakeGit({ failRemote: true }));
  assert.equal(await p.checkOnce(), 'error');
  assert.deepEqual(exits, []);
  assert.match(errores.join('\n'), /\[réplica\]/);
});

test('la rama remota no existe todavía: sigue', async () => {
  const { p, exits } = poller(fakeGit({ remote: '' }));
  assert.equal(await p.checkOnce(), 'same');
  assert.deepEqual(exits, []);
});

test('checkForUpdate dice si hay datos nuevos sin salir (lo usa el botón)', async () => {
  const nuevo = poller(fakeGit());
  assert.equal(await nuevo.p.checkForUpdate(), 'new');
  const igual = poller(fakeGit({ remote: LOCAL, local: LOCAL }));
  assert.equal(await igual.p.checkForUpdate(), 'same');
  const sinRed = poller(fakeGit({ failRemote: true }));
  assert.equal(await sinRed.p.checkForUpdate(), 'error');
  assert.deepEqual([...nuevo.exits, ...igual.exits, ...sinRed.exits], []);
});

test('sin clon todavía (arrancó sin datos): consulta la URL del repo y, si ya hay snapshot, es nuevo', async () => {
  const git = fakeGit();
  const { p, exits } = poller(git, { dataDir: path.join(os.tmpdir(), 'sl-poller-no-existe', String(Date.now())) });
  assert.equal(await p.checkOnce(), 'new');
  assert.deepEqual(git.calls, [['ls-remote', REPO_URL, 'refs/heads/snapshot']]);
  assert.deepEqual(exits, [RESTART_EXIT_CODE]);
});

test('sin clon y la principal todavía no publicó: sigue', async () => {
  const { p, exits } = poller(fakeGit({ remote: '' }), { dataDir: path.join(os.tmpdir(), 'sl-poller-no-existe', 'b') });
  assert.equal(await p.checkOnce(), 'same');
  assert.deepEqual(exits, []);
});

test('start programa el sondeo con el intervalo y stop lo corta', () => {
  const programados = [];
  const cortados = [];
  const { p } = poller(fakeGit(), {
    intervalMs: 600000,
    setIntervalFn: (fn, ms) => {
      programados.push(ms);
      return 'timer';
    },
    clearIntervalFn: (id) => cortados.push(id),
  });
  p.start();
  p.stop();
  assert.deepEqual(programados, [600000]);
  assert.deepEqual(cortados, ['timer']);
});

test('pollIntervalMs: REPLICA_POLL_MINUTES, default 10, piso 1', () => {
  const { pollIntervalMs } = require('../src/replicaPoller');
  assert.equal(pollIntervalMs({}), 10 * 60000);
  assert.equal(pollIntervalMs({ REPLICA_POLL_MINUTES: '3' }), 3 * 60000);
  assert.equal(pollIntervalMs({ REPLICA_POLL_MINUTES: '0' }), 60000);
  assert.equal(pollIntervalMs({ REPLICA_POLL_MINUTES: 'abc' }), 10 * 60000);
});
