'use strict';

// Horario del cron: por defecto a las 8, 12, 16 y 20 (hora local), sin las
// corridas de 0 y 4; MONITOR_CRON lo pisa. Sin red ni ciclo: solo la
// expresión y lo que el pie de página deriva de ella.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
delete process.env.MONITOR_CRON;
delete process.env.MONITOR_PLATFORMS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cron-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { getCronExpression, estimateRunsPerDay, getNextRunAt, cronPlatforms } = require('../src/scheduler');

/** Fecha local del mismo día (o del siguiente) a la hora dada. */
function localAt(hour, minute = 0, dayOffset = 0) {
  const d = new Date(2026, 8, 25, hour, minute, 0, 0); // 25/9/2026, hora local
  d.setDate(d.getDate() + dayOffset);
  return d;
}

describe('MONITOR_CRON', { concurrency: false }, () => {
  test('default: 8, 12, 16 y 20 h (4 corridas por día); MONITOR_CRON lo pisa', () => {
    assert.equal(getCronExpression(), '0 8,12,16,20 * * *');
    assert.equal(estimateRunsPerDay(getCronExpression()), 4);
    process.env.MONITOR_CRON = '0 */4 * * *';
    try {
      assert.equal(getCronExpression(), '0 */4 * * *');
      assert.equal(estimateRunsPerDay(getCronExpression()), 6);
    } finally {
      delete process.env.MONITOR_CRON;
    }
  });

  test('próxima corrida con el default: nunca a las 0 ni a las 4', () => {
    const cron = getCronExpression();
    assert.deepEqual(getNextRunAt(cron, localAt(13, 30)), localAt(16));
    assert.deepEqual(getNextRunAt(cron, localAt(20, 0)), localAt(8, 0, 1), 'a las 20 en punto ya disparó: la próxima es a las 8 del día siguiente');
    assert.deepEqual(getNextRunAt(cron, localAt(23, 59)), localAt(8, 0, 1));
    assert.deepEqual(getNextRunAt(cron, localAt(3, 0)), localAt(8));
  });
});

// X en stand by: el cron corre solo las plataformas de MONITOR_PLATFORMS
// (default instagram); el código de X sigue ahí y "Actualizar ahora" en su
// solapa no pasa por acá.
describe('MONITOR_PLATFORMS', { concurrency: false }, () => {
  function conEnv(valor, fn) {
    const previo = process.env.MONITOR_PLATFORMS;
    if (valor === undefined) delete process.env.MONITOR_PLATFORMS;
    else process.env.MONITOR_PLATFORMS = valor;
    const avisos = [];
    try {
      return { resultado: fn(() => cronPlatforms((msg) => avisos.push(msg))), avisos };
    } finally {
      if (previo === undefined) delete process.env.MONITOR_PLATFORMS;
      else process.env.MONITOR_PLATFORMS = previo;
    }
  }

  test('default: solo instagram (X fuera del ciclo automático), sin avisos', () => {
    const { resultado, avisos } = conEnv(undefined, (f) => f());
    assert.deepEqual(resultado, ['instagram']);
    assert.deepEqual(avisos, []);
    assert.deepEqual(conEnv('', (f) => f()).resultado, ['instagram'], 'vacía = default');
  });

  test('instagram,x vuelve a sumar X; mayúsculas, espacios y repetidos no molestan', () => {
    assert.deepEqual(conEnv('instagram,x', (f) => f()).resultado, ['instagram', 'x']);
    assert.deepEqual(conEnv(' X , instagram, x ', (f) => f()).resultado, ['x', 'instagram']);
    assert.deepEqual(conEnv('x', (f) => f()).resultado, ['x'], 'solo X también vale');
  });

  test('una plataforma desconocida se ignora con aviso; sin ninguna válida, el default', () => {
    const conTiktok = conEnv('instagram,tiktok', (f) => f());
    assert.deepEqual(conTiktok.resultado, ['instagram']);
    assert.equal(conTiktok.avisos.length, 1);
    assert.match(conTiktok.avisos[0], /desconocidas: tiktok/);

    const soloRara = conEnv('facebook', (f) => f());
    assert.deepEqual(soloRara.resultado, ['instagram']);
    assert.ok(soloRara.avisos.some((a) => /ninguna plataforma válida/.test(a)));
  });
});
