'use strict';

// src/appVersion.js: la versión del código que corre. En una réplica
// instalada la da build-info.json (lo escribe el armado del instalador); en
// la PC principal, el commit de git. Sin ninguna de las dos, null.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getAppVersion } = require('../src/appVersion');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sl-version-'));
}

test('build-info.json manda sobre git', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ commit: 'abc1234' }));
  const execFileSyncFn = () => {
    throw new Error('no debería llamar a git');
  };
  assert.equal(getAppVersion({ rootDir: root, execFileSyncFn }), 'abc1234');
});

test('sin build-info.json usa git rev-parse --short HEAD en la raíz', () => {
  const root = tmpRoot();
  const calls = [];
  const execFileSyncFn = (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return 'def5678\n';
  };
  assert.equal(getAppVersion({ rootDir: root, execFileSyncFn }), 'def5678');
  assert.deepEqual(calls, [{ file: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: root }]);
});

test('sin build-info.json ni git: null', () => {
  const root = tmpRoot();
  const execFileSyncFn = () => {
    throw new Error('git no está');
  };
  assert.equal(getAppVersion({ rootDir: root, execFileSyncFn }), null);
});

test('build-info.json con BOM (lo escribe PowerShell 5.1) se lee igual', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'build-info.json'), '\uFEFF' + JSON.stringify({ commit: 'bom1234' }));
  assert.equal(getAppVersion({ rootDir: root, execFileSyncFn: () => 'git9999' }), 'bom1234');
});

test('build-info.json roto cae a git', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'build-info.json'), '{ esto no es json');
  assert.equal(getAppVersion({ rootDir: root, execFileSyncFn: () => 'aaa1111' }), 'aaa1111');
});
