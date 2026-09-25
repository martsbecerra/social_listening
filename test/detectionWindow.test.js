'use strict';

// Ventana de detección dinámica: sin corrida previa, MONITOR_LOOKBACK (1 día);
// con corrida previa, desde el fin de la última detección exitosa, con techo
// MONITOR_LOOKBACK_MAX. Ver monitor.detectionWindowFor (reloj fijo
// inyectable) y monitor.raiseLimitForWindow. En Instagram la usan las
// búsquedas (la única fuente de detección), con el tope escalado por la
// ventana; cuentas y hashtags no se consultan.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-detectionwindow-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: ['cuenta1'], keywords: ['#caba'], searches: ['jorge macri'] } }, null, 2) + '\n'
);

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const classifier = require('../src/classifier');
// Una sola función, con el criterio de siempre para estos tests:
// coincidencia literal en la pista → relevante; sin ella, no.
classifier.clasificarPosteo = async (caption, { pista } = {}) => ({
  relevant: Boolean(pista && pista.termino),
  title: 't',
  sentiment: 'neutral',
});

const db = require('../src/db');
const monitor = require('../src/monitor');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const KEY = 'detection_last_success:instagram';

beforeEach(() => {
  db.setRefreshState(KEY, ''); // 'borrar' no existe: valor vacío no parsea -> Number.isFinite(NaN) falso, mismo efecto que "sin marca"
});

describe('detectionWindowFor (reloj fijo)', () => {
  test('sin corrida previa: MONITOR_LOOKBACK (default 1 día), no el techo', () => {
    delete process.env.MONITOR_LOOKBACK_MAX;
    delete process.env.MONITOR_LOOKBACK;
    const window = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(window.windowDays, 1);
    assert.equal(window.lookback, '1 day');
    assert.equal(window.isDefault, true);
    assert.equal(window.sinceIso, new Date(NOW - DAY_MS).toISOString());

    // Configurable, en días enteros (una fracción de día redondea a 1).
    process.env.MONITOR_LOOKBACK = '3 days';
    try {
      assert.equal(monitor.detectionWindowFor('instagram', { now: NOW }).lookback, '3 days');
      process.env.MONITOR_LOOKBACK = '2 hours';
      assert.equal(monitor.detectionWindowFor('instagram', { now: NOW }).lookback, '1 day');
      process.env.MONITOR_LOOKBACK = '40 days';
      assert.equal(monitor.detectionWindowFor('instagram', { now: NOW }).windowDays, 30, 'el techo también acota la primera corrida');
    } finally {
      delete process.env.MONITOR_LOOKBACK;
    }
  });

  test('corrida previa reciente (hace 4hs, el cron normal): ventana de 1 día, igual que el default de siempre', () => {
    const fourHoursAgo = NOW - 4 * 60 * 60 * 1000;
    db.setRefreshState(KEY, new Date(fourHoursAgo).toISOString());
    const window = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(window.windowDays, 1);
    assert.equal(window.lookback, '1 day');
    assert.equal(window.isDefault, true);
  });

  test('corrida previa de hace 3 días: la ventana usa esa fecha (3 días), no el techo', () => {
    const threeDaysAgo = NOW - 3 * DAY_MS;
    db.setRefreshState(KEY, new Date(threeDaysAgo).toISOString());
    const window = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(window.windowDays, 3);
    assert.equal(window.lookback, '3 days');
    assert.equal(window.isDefault, false);
    assert.equal(window.sinceIso, new Date(threeDaysAgo).toISOString());
  });

  test('corrida previa de hace 20 días: entra entera (techo default 30); una de hace 40 se acota a MONITOR_LOOKBACK_MAX', () => {
    db.setRefreshState(KEY, new Date(NOW - 20 * DAY_MS).toISOString());
    const veinte = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(veinte.windowDays, 20, 'con el techo viejo de 7 esto se perdía');
    assert.equal(veinte.lookback, '20 days');

    db.setRefreshState(KEY, new Date(NOW - 40 * DAY_MS).toISOString());
    const cuarenta = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(cuarenta.windowDays, 30, 'clampeado al techo default, no a 40');
    assert.equal(cuarenta.lookback, '30 days');
  });

  test('MONITOR_LOOKBACK_MAX configurable: acota una corrida previa muy vieja; sin corrida previa sigue siendo 1 día', () => {
    process.env.MONITOR_LOOKBACK_MAX = '3 days';
    try {
      assert.equal(monitor.detectionWindowFor('instagram', { now: NOW }).windowDays, 1);
      db.setRefreshState(KEY, new Date(NOW - 20 * DAY_MS).toISOString());
      assert.equal(monitor.detectionWindowFor('instagram', { now: NOW }).windowDays, 3);
    } finally {
      delete process.env.MONITOR_LOOKBACK_MAX;
    }
  });

  test('plataformas distintas no comparten marca', () => {
    db.setRefreshState('detection_last_success:instagram', new Date(NOW - 3 * DAY_MS).toISOString());
    delete process.env.MONITOR_LOOKBACK_MAX;
    const x = monitor.detectionWindowFor('x', { now: NOW });
    assert.equal(x.windowDays, 1, 'x nunca tuvo una corrida marcada: 1 día, sin importar la de instagram');
  });
});

describe('raiseLimitForWindow', () => {
  test('ventana de 1 día (default): no sube el tope', () => {
    assert.equal(monitor.raiseLimitForWindow(10, 1), 10);
  });
  test('ventana de 3 días: sube proporcionalmente', () => {
    assert.equal(monitor.raiseLimitForWindow(10, 3), 30);
  });
  test('ventana larga: el factor no pasa de 10x', () => {
    assert.equal(monitor.raiseLimitForWindow(10, 7), 70);
    assert.equal(monitor.raiseLimitForWindow(10, 10), 100);
    assert.equal(monitor.raiseLimitForWindow(10, 30), 100, 'un windowDays más grande que el factor tope no sube más');
  });
});

describe('runMonitoringCycle: en Instagram solo se consulta la búsqueda, con la ventana dinámica', () => {
  test('scrapeAccount/scrapeHashtag no se llaman (cuentas y hashtags son guía); scrapeSearch recibe la ventana dinámica y el tope escalado', async () => {
    delete process.env.MONITOR_LOOKBACK_MAX;
    delete process.env.MONITOR_LOOKBACK;
    delete process.env.SEARCH_RESULTS_LIMIT;
    // Última detección exitosa hace unos días (NOW es un reloj fijo del
    // pasado): la ventana real, calculada con Date.now(), supera 1 día.
    db.setRefreshState(KEY, new Date(NOW - 3 * DAY_MS).toISOString());

    const seen = { account: null, hashtag: null, search: null };
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async (account, { lookback }) => {
      seen.account = lookback;
      return [];
    };
    instagram.scrapeHashtag = async (tag, { lookback }) => {
      seen.hashtag = lookback;
      return [];
    };
    instagram.scrapeSearch = async (term, { lookback, resultsLimit }) => {
      seen.search = { lookback, resultsLimit };
      return [];
    };

    // La ventana depende de Date.now() real acá (runMonitoringCycle no toma
    // un `now` inyectado): se calcula con el mismo criterio para comparar.
    const expected = monitor.detectionWindowFor('instagram');
    assert.equal(expected.isDefault, false, 'precondición: la marca de hace días abre la ventana');
    await monitor.runMonitoringCycle({ plataformas: ['instagram'] });

    assert.equal(seen.account, null, 'la cuenta trackeada no se consulta en la detección');
    assert.equal(seen.hashtag, null, 'la página del hashtag no se recorre');
    assert.deepEqual(seen.search, { lookback: expected.lookback, resultsLimit: monitor.raiseLimitForWindow(100, expected.windowDays) });

    // Ciclo al día (marca de hace 4hs): ventana default y tope base.
    db.setRefreshState(KEY, new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
    await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
    assert.deepEqual(seen.search, { lookback: '1 day', resultsLimit: 100 });
  });
});
