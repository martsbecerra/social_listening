'use strict';

// Cambio D: ventana de detección dinámica (cuentas y hashtags SOLO) desde el
// fin de la última detección exitosa, con techo MONITOR_LOOKBACK_MAX. Ver
// monitor.detectionWindowFor (reloj fijo inyectable) y monitor.raiseLimitForWindow.
// Búsquedas, keywords (X) y benchmark no cambian: se prueba aparte que
// runMonitoringCycle les sigue mandando el MONITOR_LOOKBACK fijo de siempre.

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

describe('Cambio D: detectionWindowFor (reloj fijo)', () => {
  test('sin corrida previa: usa el techo (MONITOR_LOOKBACK_MAX, default 7 días)', () => {
    delete process.env.MONITOR_LOOKBACK_MAX;
    const window = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(window.windowDays, 7);
    assert.equal(window.lookback, '7 days');
    assert.equal(window.isDefault, false);
    assert.equal(window.sinceIso, new Date(NOW - 7 * DAY_MS).toISOString());
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

  test('corrida previa de hace 20 días: se acota a MONITOR_LOOKBACK_MAX, no a los 20 días', () => {
    const twentyDaysAgo = NOW - 20 * DAY_MS;
    db.setRefreshState(KEY, new Date(twentyDaysAgo).toISOString());
    const window = monitor.detectionWindowFor('instagram', { now: NOW });
    assert.equal(window.windowDays, 7, 'clampeado al techo default, no a 20');
    assert.equal(window.lookback, '7 days');
  });

  test('MONITOR_LOOKBACK_MAX configurable: cambia el techo cuando no hay corrida previa (o es muy vieja)', () => {
    process.env.MONITOR_LOOKBACK_MAX = '3 days';
    try {
      assert.equal(monitor.detectionWindowFor('instagram', { now: NOW }).windowDays, 3);
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
    assert.equal(x.windowDays, 7, 'x nunca tuvo una corrida marcada: usa el techo, sin importar la de instagram');
  });
});

describe('Cambio D: raiseLimitForWindow', () => {
  test('ventana de 1 día (default): no sube el tope', () => {
    assert.equal(monitor.raiseLimitForWindow(10, 1), 10);
  });
  test('ventana de 3 días: sube proporcionalmente', () => {
    assert.equal(monitor.raiseLimitForWindow(10, 3), 30);
  });
  test('ventana en el techo (7 días): el factor no pasa de 5x', () => {
    assert.equal(monitor.raiseLimitForWindow(10, 7), 50);
    assert.equal(monitor.raiseLimitForWindow(10, 30), 50, 'un windowDays más grande que el factor tope no sube más');
  });
});

describe('runMonitoringCycle: en Instagram solo se consulta la búsqueda', () => {
  test('scrapeAccount/scrapeHashtag no se llaman (cuentas y hashtags son guía); scrapeSearch recibe MONITOR_LOOKBACK fijo', async () => {
    delete process.env.MONITOR_LOOKBACK_MAX;
    process.env.MONITOR_LOOKBACK = '2 hours';
    db.setRefreshState(KEY, new Date(NOW - 3 * DAY_MS).toISOString());

    const seenLookbacks = { account: null, hashtag: null, search: null };
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async (account, { lookback }) => {
      seenLookbacks.account = lookback;
      return [];
    };
    instagram.scrapeHashtag = async (tag, { lookback }) => {
      seenLookbacks.hashtag = lookback;
      return [];
    };
    instagram.scrapeSearch = async (term, { lookback }) => {
      seenLookbacks.search = lookback;
      return [];
    };

    await monitor.runMonitoringCycle({ plataformas: ['instagram'] });

    assert.equal(seenLookbacks.account, null, 'la cuenta trackeada no se consulta en la detección');
    assert.equal(seenLookbacks.hashtag, null, 'la página del hashtag no se recorre');
    assert.equal(seenLookbacks.search, '2 hours', 'la búsqueda va con MONITOR_LOOKBACK fijo');

    delete process.env.MONITOR_LOOKBACK;
  });
});
