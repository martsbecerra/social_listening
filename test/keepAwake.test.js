'use strict';

// src/keepAwake.js: el server lanza un PowerShell hijo (scripts/keep-awake.ps1)
// que pide a Windows no suspender el sistema ni apagar la pantalla, y lo
// corta al cerrar. Sin PowerShell real: `spawnFn` inyectado con un hijo de
// mentira. También se verifica que el .ps1 exista y pida exactamente
// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED.

const fs = require('fs');
const { EventEmitter } = require('node:events');
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const keepAwake = require('../src/keepAwake');

/** Hijo de mentira: EventEmitter con stdout/stderr/stdin y kill(), que registra lo que le hicieron. */
function fakeChild() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.acciones = [];
  proc.stdin = { end: () => proc.acciones.push('stdin.end') };
  proc.kill = () => {
    proc.acciones.push('kill');
    return true;
  };
  return proc;
}

function stubSpawn(child = fakeChild()) {
  const llamadas = [];
  const spawnFn = (cmd, args, opts) => {
    llamadas.push({ cmd, args, opts });
    return child;
  };
  return { spawnFn, llamadas, child };
}

describe('keepAwake', { concurrency: false }, () => {
  afterEach(() => {
    keepAwake.stopKeepAwake();
  });

  test('el .ps1 existe y pide ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED sin permisos especiales', () => {
    const script = fs.readFileSync(keepAwake.SCRIPT_PATH, 'utf8');
    assert.match(script, /SetThreadExecutionState/);
    assert.match(script, /0x80000000/, 'ES_CONTINUOUS');
    assert.match(script, /0x00000001/, 'ES_SYSTEM_REQUIRED');
    assert.match(script, /0x00000002/, 'ES_DISPLAY_REQUIRED');
    assert.match(script, /\[Console\]::In\.ReadLine\(\)/, 'se queda leyendo stdin hasta que el server cierra el pipe');
    assert.ok(!/RunAs|Administrator/i.test(script), 'no pide elevación');
    assert.ok(keepAwake.POWERSHELL_ARGS.includes('-File') && keepAwake.POWERSHELL_ARGS.includes(keepAwake.SCRIPT_PATH));
  });

  test('en Windows lanza powershell.exe con el .ps1, stdin por pipe, y reenvía lo que el hijo escribe con prefijo', () => {
    const { spawnFn, llamadas, child } = stubSpawn();
    const logs = [];
    const proc = keepAwake.startKeepAwake({ platform: 'win32', env: {}, spawnFn, log: (m) => logs.push(m), error: (m) => logs.push(m) });
    assert.equal(proc, child);
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].cmd, 'powershell.exe');
    assert.deepEqual(llamadas[0].args, keepAwake.POWERSHELL_ARGS);
    assert.deepEqual(llamadas[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(llamadas[0].opts.windowsHide, true);

    child.stdout.emit('data', Buffer.from('keep-awake: activo.\n'));
    assert.deepEqual(logs, ['[keep-awake] keep-awake: activo.']);

    // Un segundo start con el hijo vivo no lanza otro.
    assert.equal(keepAwake.startKeepAwake({ platform: 'win32', env: {}, spawnFn }), child);
    assert.equal(llamadas.length, 1);
  });

  test('stopKeepAwake cierra stdin y mata al hijo; es idempotente; tras el exit del hijo se puede volver a lanzar', () => {
    const primero = stubSpawn();
    keepAwake.startKeepAwake({ platform: 'win32', env: {}, spawnFn: primero.spawnFn, log: () => {} });
    assert.equal(keepAwake.stopKeepAwake(), true);
    assert.deepEqual(primero.child.acciones, ['stdin.end', 'kill']);
    assert.equal(keepAwake.stopKeepAwake(), false, 'ya no hay hijo');

    const segundo = stubSpawn();
    const logs = [];
    keepAwake.startKeepAwake({ platform: 'win32', env: {}, spawnFn: segundo.spawnFn, log: (m) => logs.push(m) });
    assert.equal(segundo.llamadas.length, 1, 'con el anterior cortado, lanza uno nuevo');
    segundo.child.emit('exit', 0, null);
    assert.ok(logs.some((l) => /terminó \(código 0\)/.test(l)));
    assert.equal(keepAwake.stopKeepAwake(), false, 'el exit ya lo dio de baja');
  });

  test('KEEP_AWAKE=0 no lanza nada y avisa; fuera de Windows no hace nada; si spawn tira, se loguea y no rompe', () => {
    const { spawnFn, llamadas } = stubSpawn();
    const logs = [];
    assert.equal(keepAwake.startKeepAwake({ platform: 'win32', env: { KEEP_AWAKE: '0' }, spawnFn, log: (m) => logs.push(m) }), null);
    assert.equal(llamadas.length, 0);
    assert.ok(logs.some((l) => /KEEP_AWAKE=0/.test(l)));
    assert.equal(keepAwake.keepAwakeEnabled({ KEEP_AWAKE: 'off' }), false);
    assert.equal(keepAwake.keepAwakeEnabled({}), true);

    assert.equal(keepAwake.startKeepAwake({ platform: 'linux', env: {}, spawnFn }), null);
    assert.equal(llamadas.length, 0);

    const errores = [];
    const rompe = () => {
      throw new Error('no hay powershell');
    };
    assert.equal(keepAwake.startKeepAwake({ platform: 'win32', env: {}, spawnFn: rompe, error: (m) => errores.push(m) }), null);
    assert.match(errores[0], /no se pudo lanzar PowerShell: no hay powershell/);
  });
});
