'use strict';

// APP_MODE (src/appMode.js): principal (default) o replica. Un valor
// desconocido aborta el arranque, como IG_ACTOR y REFRESH_MODE.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveAppMode, isReplica } = require('../src/appMode');

test('sin valor o vacío es principal', () => {
  assert.equal(resolveAppMode(undefined), 'principal');
  assert.equal(resolveAppMode(''), 'principal');
  assert.equal(resolveAppMode('   '), 'principal');
});

test('acepta principal y replica, sin distinguir mayúsculas', () => {
  assert.equal(resolveAppMode('principal'), 'principal');
  assert.equal(resolveAppMode('replica'), 'replica');
  assert.equal(resolveAppMode(' Replica '), 'replica');
});

test('un valor desconocido tira con userMessage que nombra los válidos', () => {
  assert.throws(
    () => resolveAppMode('copia'),
    (err) => {
      assert.match(err.userMessage, /APP_MODE="copia"/);
      assert.match(err.userMessage, /"principal"/);
      assert.match(err.userMessage, /"replica"/);
      return true;
    }
  );
});

test('isReplica lee el entorno', () => {
  assert.equal(isReplica({ APP_MODE: 'replica' }), true);
  assert.equal(isReplica({}), false);
});
