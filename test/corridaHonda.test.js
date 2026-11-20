'use strict';

// Corridas hondas (noviembre 2026, src/deepRun.js): en las horas de
// MONITOR_DEEP_HOURS la corrida programada es honda y la ventana mínima de
// todas las búsquedas es MONITOR_DEEP_WINDOW (7 días) en vez de
// MONITOR_MIN_WINDOW. Si pasaron más de 24 h desde la última honda
// terminada, la próxima programada es honda aunque no sea su hora;
// "Actualizar ahora" es siempre corta. Sin esas variables todo queda como
// siempre. Base y config temporales; adapters y clasificador simulados; nada
// llama a Apify ni a un modelo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
process.env.POST_IMAGES = '0';
delete process.env.REFRESH_MODE;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-corrida-honda-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
const VARIABLES = [
  'MONITOR_DEEP_HOURS',
  'MONITOR_DEEP_WINDOW',
  'MONITOR_CRON',
  'MONITOR_LOOKBACK',
  'MONITOR_LOOKBACK_MAX',
  'MONITOR_MIN_WINDOW',
  'SEARCH_ENRICH_LIMIT',
  'SEARCH_RESULTS_LIMIT',
  'SEARCH_RESULTS_MAX',
  'SEARCH_EXTRA_MAX_USD_PER_CYCLE',
  'MONITOR_ACCOUNT_LIMIT',
  'MONITOR_HASHTAG_LIMIT',
  'MONITOR_RESULTS_LIMIT',
  'APIDOJO_INCLUDED_SEARCH',
  'APIDOJO_RATE_SEARCH',
  'APIDOJO_RATE_ITEM',
];
for (const name of VARIABLES) delete process.env[name];

const escribirConfig = (instagram, x = { accounts: [], keywords: [] }) =>
  fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], ...instagram }, x }, null, 2) + '\n');
escribirConfig({ searches: ['macri', 'gcba'] });

const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 'título', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'habla de la Ciudad' });

const db = require('../src/db');
const monitor = require('../src/monitor');
const scheduler = require('../src/scheduler');
const deepRun = require('../src/deepRun');
const busquedaTope = require('../src/busquedaTope');
const apifyCost = require('../src/apifyCost');
const { runWithContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const x = getPlatform('x');

// Sin red: cualquier pedido que se escape de los stubs falla el test.
global.fetch = async (url) => {
  throw new Error(`pedido de red inesperado en el test: ${String(url).slice(0, 80)}`);
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T15:00:00.000Z');
const SIETE_DIAS = 7 * DAY_MS;
const marca = (term, tipo = 'busqueda', red = 'instagram') => monitor.sourceMarkKey(red, tipo, term);
const cerca = (iso, ms, tolerancia = 5000) => Math.abs(Date.parse(iso) - ms) <= tolerancia;
/** Una fecha con ESA hora local (la que mira el cron), sea cual sea la zona de la máquina. */
const local = (hora, minuto = 0, dia = 20, mes = 10, anio = 2026) => new Date(anio, mes, dia, hora, minuto, 0, 0);
const HONDA = { activas: true, honda: true, motivo: 'hora', motivoTexto: 'por la hora', windowMs: SIETE_DIAS, windowText: '7 días' };
const CORTA = { activas: true, honda: false, motivo: null, motivoTexto: '', windowMs: null, windowText: null };

function borrarMarcas() {
  for (const { key } of db.listRefreshStateByPrefix('detection_')) db.deleteRefreshState(key);
}
/** La red al día: marca de la red y de cada búsqueda hace 4 h (como entre dos corridas del cron). */
function alDia(terms = ['macri', 'gcba'], red = 'instagram', tipo = 'busqueda') {
  const iso = new Date(Date.now() - 4 * HOUR_MS).toISOString();
  db.setRefreshState(`detection_last_success:${red}`, iso);
  db.setRefreshState(`detection_por_fuente:${red}`, iso);
  for (const term of terms) db.setRefreshState(marca(term, tipo, red), iso);
}

const pedidos = [];
function stubInstagram(buscar = {}) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeSearch', 'fetchPostDetails', 'recoverSearchRun']) originals[key] = instagram[key];
  pedidos.length = 0;
  instagram.isConfigured = () => true;
  instagram.fetchPostDetails = async () => [];
  instagram.recoverSearchRun = async () => ({ estado: 'desconocido', error: new Error('sin simular') });
  instagram.scrapeSearch = async (term, options = {}) => {
    pedidos.push({ term, lookback: options.lookback, resultsLimit: options.resultsLimit, sinceIso: options.sinceIso });
    return buscar[term] || [];
  };
  return () => Object.assign(instagram, originals);
}
const pedido = (term) => pedidos.find((p) => p.term === term);

const ciclo = async (opciones) => {
  const runId = db.startMonitoringRun({ trigger: opciones.trigger || 'cron', plataforma: (opciones.plataformas || ['todas']).join(','), honda: opciones.pasada ? opciones.pasada.honda : null });
  const result = await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle(opciones));
  db.finishMonitoringRun(runId, { newPosts: result.newPosts.length });
  return { runId, result };
};

let consola;
let lineas;
beforeEach(() => {
  consola = { log: console.log, error: console.error, warn: console.warn };
  lineas = [];
  console.log = (...args) => lineas.push(args.join(' '));
  console.error = () => {};
  console.warn = (...args) => lineas.push(args.join(' '));
  borrarMarcas();
  for (const f of db.listPendingRunSources('instagram')) db.updateRunSource(f.id, { estado: 'fallo', motivo: 'TEST' });
  escribirConfig({ searches: ['macri', 'gcba'] });
});
afterEach(() => {
  Object.assign(console, consola);
  for (const name of VARIABLES) delete process.env[name];
});
const linea = (texto) => lineas.find((l) => l.includes(texto));

describe('deepRun: la configuración', () => {
  test('sin las variables no hay corridas hondas', () => {
    const c = deepRun.resolveDeepConfig({});
    assert.deepEqual({ enabled: c.enabled, hours: c.hours, windowSinHoras: c.windowSinHoras }, { enabled: false, hours: [], windowSinHoras: false });
    assert.equal(deepRun.describeDeepConfig(c), 'apagadas (todas las corridas usan la ventana mínima de siempre)');
    assert.equal(deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '  ' }).enabled, false);
  });

  test('las horas: una lista de 0 a 23, ordenada y sin repetidos; la ventana, 7 días por defecto', () => {
    let c = deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8,16' });
    assert.deepEqual(c, { enabled: true, hours: [8, 16], windowMs: SIETE_DIAS, windowText: '7 días', windowSinHoras: false });
    assert.equal(
      deepRun.describeDeepConfig(c),
      'a las 8 y 16 h con ventana mínima de 7 días; las demás, cortas. Si pasan más de 24 h sin una honda terminada, la siguiente programada es honda; "Actualizar ahora" es siempre corta'
    );
    c = deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: ' 16 , 8,8,0 ', MONITOR_DEEP_WINDOW: '36 hours' });
    assert.deepEqual(c.hours, [0, 8, 16]);
    assert.equal(c.windowMs, 36 * HOUR_MS);
    assert.equal(c.windowText, '36 horas');
    // Cambiar cuántas hondas hay por día es cambiar un valor.
    assert.deepEqual(deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8' }).hours, [8]);
    assert.deepEqual(deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8,12,16,20' }).hours, [8, 12, 16, 20]);
    assert.equal(deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8', MONITOR_DEEP_WINDOW: '1 week' }).windowText, '7 días');
    assert.equal(deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8', MONITOR_DEEP_WINDOW: '1 day' }).windowText, '1 día');
  });

  test('la ventana sola no prende nada, y el arranque lo dice', () => {
    const c = deepRun.resolveDeepConfig({ MONITOR_DEEP_WINDOW: '7 days' });
    assert.equal(c.enabled, false);
    assert.equal(c.windowSinHoras, true);
    assert.equal(deepRun.describeDeepConfig(c), 'apagadas: está la ventana pero faltan las horas (todas las corridas son cortas)');
  });

  test('un valor mal escrito tira, sin nombrar la variable en lo que va a la pantalla; en el ciclo, apaga las hondas', () => {
    for (const mal of ['24', '8;16', 'ocho', '8,', '-1', '8.5', '8,16h']) {
      assert.throws(
        () => deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: mal }),
        (err) => /MONITOR_DEEP_HOURS/.test(err.message) && err.userMessage === 'Falta configuración del servidor.',
        mal
      );
      assert.equal(deepRun.deepConfig({ MONITOR_DEEP_HOURS: mal }).enabled, false);
    }
    for (const mal of ['7', 'siete días', '0 days', '7 dias']) {
      assert.throws(
        () => deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8', MONITOR_DEEP_WINDOW: mal }),
        (err) => /MONITOR_DEEP_WINDOW/.test(err.message) && err.userMessage === 'Falta configuración del servidor.',
        mal
      );
    }
  });

  test('una hora honda que el cron no dispara se avisa', () => {
    const c = deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8,9,16' });
    assert.deepEqual(deepRun.horasFueraDelCron(c, [8, 12, 16, 20]), [9]);
    assert.deepEqual(deepRun.horasFueraDelCron(deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8,16' }), [8, 12, 16, 20]), []);
    assert.deepEqual(deepRun.horasFueraDelCron(deepRun.resolveDeepConfig({}), [8, 12]), []);
  });
});

describe('deepRun: ¿esta corrida es honda?', () => {
  const config = deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8,16' });
  const decidir = (extra) => deepRun.decidirHonda({ config, ...extra });
  const hace = (ms, desde) => new Date(desde.getTime() - ms).toISOString();

  test('la corrida programada de una hora honda es honda; las demás, cortas', () => {
    const recien = hace(HOUR_MS, local(8));
    assert.deepEqual(decidir({ trigger: 'cron', now: local(8), lastDeepFinishedAt: recien }), { honda: true, motivo: 'hora', windowMs: SIETE_DIAS, windowText: '7 días' });
    assert.equal(decidir({ trigger: 'cron', now: local(16, 0), lastDeepFinishedAt: hace(8 * HOUR_MS, local(16)) }).motivo, 'hora');
    assert.deepEqual(decidir({ trigger: 'cron', now: local(12), lastDeepFinishedAt: hace(4 * HOUR_MS, local(12)) }), { honda: false, motivo: null, windowMs: null, windowText: null });
    assert.equal(decidir({ trigger: 'cron', now: local(20), lastDeepFinishedAt: hace(4 * HOUR_MS, local(20)) }).honda, false);
    // El cron con minutos ("30 8 * * *") sigue siendo la hora 8; también en epoch.
    assert.equal(decidir({ trigger: 'cron', now: local(8, 30).getTime(), lastDeepFinishedAt: recien }).motivo, 'hora');
  });

  test('"Actualizar ahora" es siempre corta, también a una hora honda y con la honda atrasada', () => {
    assert.equal(decidir({ trigger: 'manual', now: local(8), lastDeepFinishedAt: null }).honda, false);
    assert.equal(decidir({ now: local(16), lastDeepFinishedAt: hace(5 * DAY_MS, local(16)) }).honda, false);
  });

  test('más de 24 h desde la última honda terminada: la próxima programada es honda aunque no sea su hora', () => {
    // La máquina estuvo apagada a las 8 y a las 16: la de las 20 es honda.
    const ayer = hace(27 * HOUR_MS + 40 * 60 * 1000, local(20));
    assert.deepEqual(decidir({ trigger: 'cron', now: local(20), lastDeepFinishedAt: ayer }), { honda: true, motivo: 'atrasada', windowMs: SIETE_DIAS, windowText: '7 días' });
    assert.equal(deepRun.describeMotivo('atrasada', ayer), 'pasaron más de 24 h desde la última honda');
    // "Más de 24 h": justo 24 h todavía no.
    assert.equal(decidir({ trigger: 'cron', now: local(12), lastDeepFinishedAt: hace(DAY_MS, local(12)) }).honda, false);
    assert.equal(decidir({ trigger: 'cron', now: local(12), lastDeepFinishedAt: hace(DAY_MS + 1, local(12)) }).motivo, 'atrasada');
    // Todavía no hubo ninguna: también.
    assert.equal(decidir({ trigger: 'cron', now: local(12), lastDeepFinishedAt: null }).motivo, 'atrasada');
    assert.equal(deepRun.describeMotivo('atrasada', null), 'todavía no hubo ninguna honda');
    assert.equal(deepRun.describeMotivo('hora'), 'por la hora');
  });

  test('una sola honda por día (MONITOR_DEEP_HOURS=8): las otras tres son cortas mientras la de las 8 haya terminado', () => {
    const una = deepRun.resolveDeepConfig({ MONITOR_DEEP_HOURS: '8' });
    const termino = local(8, 20).toISOString();
    for (const hora of [12, 16, 20]) assert.equal(deepRun.decidirHonda({ config: una, trigger: 'cron', now: local(hora), lastDeepFinishedAt: termino }).honda, false, String(hora));
    assert.equal(deepRun.decidirHonda({ config: una, trigger: 'cron', now: local(8, 0, 21), lastDeepFinishedAt: termino }).motivo, 'hora');
  });

  test('con las hondas apagadas, nunca', () => {
    const apagadas = deepRun.resolveDeepConfig({});
    assert.equal(deepRun.decidirHonda({ config: apagadas, trigger: 'cron', now: local(8), lastDeepFinishedAt: null }).honda, false);
  });
});

describe('la última corrida honda terminada (base)', { concurrency: false }, () => {
  const fuente = (runId, estado, term = 'macri') =>
    db.startRunSource({ runId, plataforma: 'instagram', tipo: 'busqueda', fuente: term, clave: term, estado, finishedAt: '2026-01-05T12:00:00.000Z' });

  test('cuenta la honda que cerró sin error y en la que alguna búsqueda respondió o quedó en Apify', () => {
    assert.equal(db.getLastFinishedDeepRunAt(), null, 'sin ninguna');

    // Una corta y una anterior a las hondas (honda NULL) no cuentan.
    const cortaId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', honda: false });
    db.finishMonitoringRun(cortaId, { finishedAt: '2026-01-01T11:10:00.000Z' });
    const vieja = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram' });
    db.finishMonitoringRun(vieja, { finishedAt: '2026-01-01T11:20:00.000Z' });
    assert.equal(db.getLastFinishedDeepRunAt(), null);

    // Una honda en curso (o interrumpida) no terminó.
    const abierta = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', honda: true });
    assert.equal(db.getLastFinishedDeepRunAt(), null);

    // Una honda sin búsquedas registradas que cerró bien cuenta.
    db.finishMonitoringRun(abierta, { finishedAt: '2026-01-02T11:10:00.000Z' });
    assert.equal(db.getLastFinishedDeepRunAt(), '2026-01-02T11:10:00.000Z');

    // El ciclo tiró: no cuenta.
    const conError = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', honda: true });
    fuente(conError, 'ok');
    db.finishMonitoringRun(conError, { finishedAt: '2026-01-03T11:10:00.000Z', errorCode: 'AUTH_INVALID' });
    assert.equal(db.getLastFinishedDeepRunAt(), '2026-01-02T11:10:00.000Z');

    // No respondió ninguna búsqueda: no trajo nada, no cuenta.
    const todasCaidas = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', honda: true });
    fuente(todasCaidas, 'fallo', 'macri');
    fuente(todasCaidas, 'perdida', 'gcba');
    db.finishMonitoringRun(todasCaidas, { finishedAt: '2026-01-04T11:10:00.000Z' });
    assert.equal(db.getLastFinishedDeepRunAt(), '2026-01-02T11:10:00.000Z');

    // Una falló y otra quedó en Apify (se levanta en la corrida siguiente): cuenta.
    const incompleta = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', honda: true });
    fuente(incompleta, 'fallo', 'macri');
    fuente(incompleta, 'esperando', 'gcba');
    db.finishMonitoringRun(incompleta, { finishedAt: '2026-01-05T11:10:00.000Z' });
    assert.equal(db.getLastFinishedDeepRunAt(), '2026-01-05T11:10:00.000Z');
  });
});

describe('la ventana de una búsqueda en una corrida honda (reloj fijo)', { concurrency: false }, () => {
  const ventana = (extra = {}) => monitor.detectionWindowFor('instagram', { tipo: 'busqueda', fuente: 'macri', now: NOW, ...extra });

  test('con la marca al día, la honda mira 7 días en vez de 1', () => {
    db.setRefreshState(marca('macri'), new Date(NOW - 4 * HOUR_MS).toISOString());
    assert.equal(ventana().lookback, '1 day', 'una corta: como siempre');
    assert.deepEqual(ventana({ minWindowMs: SIETE_DIAS }), {
      lookback: '7 days',
      windowDays: 7,
      isDefault: false,
      sinceIso: new Date(NOW - SIETE_DIAS).toISOString(),
      origen: 'minimo',
      huecoDesde: null,
    });
  });

  test('una marca más vieja que la ventana honda manda; una búsqueda nueva también mira la honda', () => {
    const diezDias = new Date(NOW - 10 * DAY_MS).toISOString();
    db.setRefreshState(marca('macri'), diezDias);
    const w = ventana({ minWindowMs: SIETE_DIAS });
    assert.equal(w.sinceIso, diezDias);
    assert.equal(w.origen, 'marca');
    db.deleteRefreshState(marca('macri'));
    const nueva = ventana({ minWindowMs: SIETE_DIAS });
    assert.equal(nueva.windowDays, 7);
    assert.equal(nueva.origen, 'primera');
  });

  test('nunca achica la ventana mínima de siempre, y respeta el techo sin inventar un hueco', () => {
    db.setRefreshState(marca('macri'), new Date(NOW - 4 * HOUR_MS).toISOString());
    assert.equal(ventana({ minWindowMs: 12 * HOUR_MS }).lookback, '1 day', 'una honda más corta que MONITOR_MIN_WINDOW no acorta nada');
    process.env.MONITOR_MIN_WINDOW = '3 days';
    assert.equal(ventana({ minWindowMs: DAY_MS }).windowDays, 3);
    delete process.env.MONITOR_MIN_WINDOW;

    process.env.MONITOR_LOOKBACK_MAX = '5 days';
    const w = ventana({ minWindowMs: SIETE_DIAS });
    assert.equal(w.windowDays, 5);
    assert.equal(w.origen, 'techo');
    assert.equal(w.huecoDesde, null, 'la ventana honda pasó el techo, pero la marca estaba al día: no quedó nada sin pedir');
    // Con una marca de hace 9 días sí: lo anterior al techo no se pide.
    const nueveDias = new Date(NOW - 9 * DAY_MS).toISOString();
    db.setRefreshState(marca('macri'), nueveDias);
    assert.equal(ventana({ minWindowMs: SIETE_DIAS }).huecoDesde, nueveDias);
  });
});

describe('el ciclo en una corrida honda', { concurrency: false }, () => {
  test('todas las búsquedas piden la ventana honda, con el tope subido, y la línea del log dice que es honda y cuánto cuesta', async () => {
    alDia();
    const restore = stubInstagram();
    try {
      const antes = Date.now();
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: HONDA });
      for (const term of ['macri', 'gcba']) {
        assert.equal(pedido(term).lookback, '7 days', term);
        assert.ok(cerca(pedido(term).sinceIso, antes - SIETE_DIAS, 10000), `${term} pide desde hace 7 días`);
        assert.equal(pedido(term).resultsLimit, 700, 'el tope sube con la ventana: 100 × 7');
      }
      const l = linea('[monitor] instagram: corrida honda');
      assert.equal(
        l,
        '[monitor] instagram: corrida honda (ventana mínima de 7 días, por la hora) · 2 búsquedas · costo estimado US$ 0,03 ' +
          '(como mucho US$ 0,73 si todas llenan su tope, más hasta US$ 2,00 en segundas consultas) · 2 sin historia: cuentan solo la consulta'
      );
      assert.equal(lineas.filter((t) => t.includes('retoma desde')).length, 0, 'en una honda no hace falta una línea por búsqueda');
      // La marca de cada búsqueda avanza como siempre.
      assert.ok(Date.parse(db.getRefreshState(marca('macri'))) >= antes - 1000);
    } finally {
      restore();
    }
  });

  test('una corrida corta con las hondas activas: 1 día, y la línea dice "corta"', async () => {
    alDia();
    const restore = stubInstagram();
    try {
      const antes = Date.now();
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: CORTA });
      assert.equal(pedido('macri').lookback, '1 day');
      assert.ok(cerca(pedido('macri').sinceIso, antes - DAY_MS, 10000));
      assert.equal(pedido('macri').resultsLimit, 100);
      assert.equal(
        linea('[monitor] instagram: corrida'),
        '[monitor] instagram: corrida corta · 2 búsquedas · costo estimado US$ 0,03 ' +
          '(como mucho US$ 0,13 si todas llenan su tope, más hasta US$ 2,00 en segundas consultas) · 2 sin historia: cuentan solo la consulta'
      );
    } finally {
      restore();
    }
  });

  test('sin las variables (o sin `pasada`) todo queda como siempre: 1 día y ninguna línea nueva', async () => {
    alDia();
    const restore = stubInstagram();
    try {
      await ciclo({ plataformas: ['instagram'], trigger: 'cron' });
      assert.equal(pedido('macri').lookback, '1 day');
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: { activas: false, honda: false, windowMs: null } });
      assert.equal(pedidos.filter((p) => p.lookback !== '1 day').length, 0);
      // Una pasada "honda" con las hondas apagadas no cambia nada.
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: { activas: false, honda: true, windowMs: SIETE_DIAS } });
      assert.equal(pedidos.filter((p) => p.lookback !== '1 day').length, 0);
      assert.equal(lineas.filter((t) => t.includes('corrida honda') || t.includes('corrida corta')).length, 0);
    } finally {
      restore();
    }
  });

  test('el costo estimado sale de lo que trajo cada término en consultas de una ventana parecida', async () => {
    alDia();
    // "macri" ya tuvo una consulta honda (desde hace 7 días) que trajo 400 de un tope de 700; "gcba", ninguna.
    const until = new Date(Date.now() - SIETE_DIAS).toISOString().slice(0, 10);
    apifyCost.recordApifyCall({
      runId: null,
      phase: 'busqueda',
      plataforma: 'instagram',
      actor: apifyCost.APIDOJO_ACTOR,
      input: { keywords: ['macri'], maxItems: 700, until },
      ok: true,
      items: 400,
    });
    const restore = stubInstagram();
    try {
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: HONDA });
      // 0,015 + 400 × 0,0005 = 0,215 de "macri", más la consulta sola de "gcba" (0,015).
      assert.match(linea('[monitor] instagram: corrida honda'), /· 2 búsquedas · costo estimado US\$ 0,23 \(como mucho US\$ \d+,\d\d si todas llenan su tope/);
      assert.match(linea('[monitor] instagram: corrida honda'), /· 1 sin historia: cuenta solo la consulta$/);
      assert.ok(pedido('macri').resultsLimit >= 700, 'el tope por volumen nunca baja del de la ventana');
      // En una corta, esa consulta honda no sirve para estimar: va por la tasa (400 en ~7 días, unos 2 por hora).
      pedidos.length = 0;
      lineas.length = 0;
      alDia();
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: CORTA });
      const corta = linea('[monitor] instagram: corrida corta');
      assert.match(corta, /costo estimado US\$ 0,0[5-9] /, corta);
    } finally {
      restore();
    }
  });

  test('muchas cortas entre dos hondas no borran lo aprendido en la honda: el tope sigue saliendo del volumen del término', async () => {
    alDia();
    // "gcba": una honda que llenó 700 de 700 y, después, ocho consultas
    // cortas ("Actualizar ahora" varias veces en el día) que trajeron 3.
    const dia = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 10);
    const llamada = (input, items) =>
      apifyCost.recordApifyCall({ runId: null, phase: 'busqueda', plataforma: 'instagram', actor: apifyCost.APIDOJO_ACTOR, input: { keywords: ['gcba'], ...input }, ok: true, items });
    llamada({ maxItems: 700, until: dia(SIETE_DIAS) }, 700);
    for (let i = 0; i < 8; i += 1) llamada({ maxItems: 100, until: dia(DAY_MS) }, 3);
    const restore = stubInstagram();
    try {
      await ciclo({ plataformas: ['instagram'], trigger: 'cron', pasada: HONDA });
      // Con las últimas 6 consultas solas (todas cortas) el tope volvía a 100 × 7.
      assert.equal(pedido('gcba').resultsLimit, 2000, 'el doble de lo que suele traer, hasta el máximo');
    } finally {
      restore();
    }
  });

  test('en X, las cuentas no cambian con la honda: es de las búsquedas', async () => {
    escribirConfig({ searches: [] }, { accounts: ['jorgemacri'], keywords: [] });
    alDia(['jorgemacri'], 'x', 'cuenta');
    const originals = { isConfigured: x.isConfigured, scrapeAccount: x.scrapeAccount };
    const vistos = [];
    x.isConfigured = () => true;
    x.scrapeAccount = async (account, options = {}) => {
      vistos.push({ account, lookback: options.lookback });
      return [];
    };
    try {
      await ciclo({ plataformas: ['x'], trigger: 'cron', pasada: HONDA });
      assert.deepEqual(vistos, [{ account: 'jorgemacri', lookback: '1 day' }]);
      assert.equal(lineas.filter((t) => t.includes('corrida honda')).length, 0, 'sin búsquedas no hay línea de costo');
    } finally {
      Object.assign(x, originals);
    }
  });
});

describe('estimado de resultados y costo de las búsquedas (puro)', () => {
  const at = '2026-11-20T15:00:00.000Z';
  const honda = (items, maxItems = 700) => ({ items, maxItems, until: '2026-11-13', at });
  const corta = (items, maxItems = 100) => ({ items, maxItems, until: '2026-11-19', at });
  const HORAS_HONDA = busquedaTope.horasPedidas('2026-11-13', at);
  const HORAS_CORTA = busquedaTope.horasPedidas('2026-11-19', at);

  test('sin historia, null; con consultas de una ventana parecida, su promedio; nunca más que el tope', () => {
    assert.equal(busquedaTope.estimarResultados({ calls: [], horas: HORAS_HONDA, tope: 700 }), null);
    assert.equal(busquedaTope.estimarResultados({ calls: [honda(400), honda(300), corta(4)], horas: HORAS_HONDA, tope: 700 }), 350);
    assert.equal(busquedaTope.estimarResultados({ calls: [honda(400), honda(300)], horas: HORAS_HONDA, tope: 320 }), 320);
    assert.equal(busquedaTope.estimarResultados({ calls: [honda(400), corta(4), corta(12)], horas: HORAS_CORTA, tope: 100 }), 8);
    // Una búsqueda que no trae nada: 0, no "sin historia".
    assert.equal(busquedaTope.estimarResultados({ calls: [corta(0), corta(0)], horas: HORAS_CORTA, tope: 100 }), 0);
  });

  test('sin ninguna consulta parecida: la tasa del término por las horas pedidas', () => {
    // Solo cortas (12 resultados en 39 h) y se pide una honda de 183 h: 12 / 39 × 183 = 56.
    assert.equal(busquedaTope.estimarResultados({ calls: [corta(12)], horas: HORAS_HONDA, tope: 700 }), Math.round((12 / HORAS_CORTA) * HORAS_HONDA));
    // Solo una que no trajo nada: sin tasa, no hay de dónde estimar.
    assert.equal(busquedaTope.estimarResultados({ calls: [corta(0)], horas: HORAS_HONDA, tope: 700 }), null);
  });

  test('historiaPara: las últimas 6 y, de las más viejas, hasta 3 de una ventana parecida a la que se pide', () => {
    const cortas = Array.from({ length: 8 }, (_, i) => corta(i + 1));
    // De la más nueva a la más vieja: 8 cortas, 4 hondas y una corta más.
    const todas = [...cortas, honda(400), honda(300), honda(200), honda(100), corta(99)];
    const paraHonda = busquedaTope.historiaPara({ calls: todas, horas: HORAS_HONDA });
    assert.deepEqual(paraHonda.map((c) => c.items), [1, 2, 3, 4, 5, 6, 400, 300, 200]);
    assert.equal(busquedaTope.estimarResultados({ calls: paraHonda, horas: HORAS_HONDA, tope: 700 }), 300, 'el estimado sale de las hondas');
    const paraCorta = busquedaTope.historiaPara({ calls: todas, horas: HORAS_CORTA });
    assert.deepEqual(paraCorta.map((c) => c.items), [1, 2, 3, 4, 5, 6, 7, 8, 99]);
    assert.deepEqual(busquedaTope.historiaPara({ calls: cortas.slice(0, 3), horas: HORAS_HONDA }).map((c) => c.items), [1, 2, 3]);
    assert.deepEqual(busquedaTope.historiaPara({ calls: null, horas: HORAS_HONDA }), []);
    assert.equal(busquedaTope.consultasParecidas({ calls: todas, horas: HORAS_HONDA }).length, 4);
  });

  test('costoDeBusquedas: el estimado, el techo y cuántas van sin historia', () => {
    const usd = (n) => 0.015 + n * 0.0005;
    const r = busquedaTope.costoDeBusquedas(
      [
        { estimado: 400, limit: 800 },
        { estimado: null, limit: 350 },
        { estimado: 0, limit: 100 },
      ],
      usd
    );
    assert.equal(r.n, 3);
    assert.equal(r.sinHistoria, 1);
    assert.ok(Math.abs(r.estimado - (0.215 + 0.015 + 0.015)) < 1e-9);
    assert.ok(Math.abs(r.techo - (0.415 + 0.19 + 0.065)) < 1e-9);
    assert.deepEqual(busquedaTope.costoDeBusquedas([], usd), { estimado: 0, techo: 0, sinHistoria: 0, n: 0 });
  });
});

describe('el scheduler decide y lo deja registrado', { concurrency: false }, () => {
  const TODAS = Array.from({ length: 24 }, (_, h) => h).join(',');
  // Una hora que no es la de ahora ni la que viene: la corrida de este test nunca cae en ella.
  const otraHora = () => String((new Date().getHours() + 6) % 24);
  const ultimaDeInstagram = () => db.getLastFinishedRun('instagram');

  test('decidirPasada: con las hondas apagadas no hay nada que decidir; con ellas, manual es corta y el cron mira la hora', () => {
    assert.deepEqual(scheduler.decidirPasada('cron'), { activas: false, honda: false, motivo: null, motivoTexto: '', windowMs: null, windowText: null });
    process.env.MONITOR_DEEP_HOURS = '8,16';
    assert.deepEqual(scheduler.decidirPasada('manual', local(8).getTime()), { activas: true, honda: false, motivo: null, windowMs: null, windowText: null, motivoTexto: '' });
    const honda = scheduler.decidirPasada('cron', local(8).getTime());
    assert.deepEqual({ activas: honda.activas, honda: honda.honda, motivo: honda.motivo, motivoTexto: honda.motivoTexto, windowText: honda.windowText }, { activas: true, honda: true, motivo: 'hora', motivoTexto: 'por la hora', windowText: '7 días' });
  });

  test('una corrida programada a una hora honda: queda registrada como honda, pide 7 días y el log lo dice', async () => {
    process.env.MONITOR_DEEP_HOURS = TODAS;
    alDia();
    const restore = stubInstagram();
    try {
      const antes = new Date().toISOString();
      await scheduler.runCycle({ trigger: 'cron', plataformas: ['instagram'] });
      assert.equal(pedido('macri').lookback, '7 days');
      assert.ok(linea('[ciclo] inicio (trigger=cron, plataforma=instagram, honda: ventana mínima de 7 días, por la hora)'));
      assert.ok(linea('[monitor] instagram: corrida honda (ventana mínima de 7 días, por la hora) · 2 búsquedas · costo estimado US$'));
      assert.match(linea('[ciclo] próxima corrida programada:'), /^\[ciclo\] próxima corrida programada: \d\d\/\d\d \d\d:\d\d · honda \(por la hora\)$/);
      assert.ok(db.getLastFinishedDeepRunAt() >= antes, 'la honda que acaba de terminar es la última');
    } finally {
      restore();
    }
  });

  test('"Actualizar ahora" es corta aunque sea una hora honda, y no cuenta como honda', async () => {
    process.env.MONITOR_DEEP_HOURS = TODAS;
    alDia();
    const restore = stubInstagram();
    try {
      const ultimaHonda = db.getLastFinishedDeepRunAt();
      await scheduler.runCycle({ plataforma: 'instagram' });
      assert.equal(pedido('macri').lookback, '1 day');
      assert.ok(linea('[ciclo] inicio (trigger=manual, plataforma=instagram, corta)'));
      assert.ok(linea('[monitor] instagram: corrida corta · 2 búsquedas'));
      assert.equal(db.getLastFinishedDeepRunAt(), ultimaHonda);
    } finally {
      restore();
    }
  });

  test('fuera de su hora es corta; si la última honda terminó hace más de 24 h, la programada es honda igual', async () => {
    process.env.MONITOR_DEEP_HOURS = otraHora();
    alDia();
    const restore = stubInstagram();
    try {
      // La honda del test anterior terminó hace un instante: esta es corta.
      await scheduler.runCycle({ trigger: 'cron', plataformas: ['instagram'] });
      assert.equal(pedido('macri').lookback, '1 day');
      assert.ok(linea('[ciclo] inicio (trigger=cron, plataforma=instagram, corta)'));

      // Todas las hondas terminadas pasan a ser de hace más de 24 h.
      const { DatabaseSync } = require('node:sqlite');
      const directa = new DatabaseSync(process.env.MONITORING_DB_PATH);
      directa.prepare('UPDATE monitoring_runs SET finished_at = ? WHERE honda = 1 AND finished_at > ?').run(new Date(Date.now() - 25 * HOUR_MS).toISOString(), new Date(Date.now() - 25 * HOUR_MS).toISOString());
      directa.close();

      pedidos.length = 0;
      lineas.length = 0;
      alDia();
      await scheduler.runCycle({ trigger: 'cron', plataformas: ['instagram'] });
      assert.equal(pedido('macri').lookback, '7 days');
      assert.ok(linea('[ciclo] inicio (trigger=cron, plataforma=instagram, honda: ventana mínima de 7 días, pasaron más de 24 h desde la última honda)'));
      assert.equal(ultimaDeInstagram().trigger, 'cron');

    } finally {
      restore();
    }
  });

  test('sin las variables el ciclo no dice nada de hondas y la corrida queda sin marcar', async () => {
    alDia();
    const restore = stubInstagram();
    try {
      const ultimaHonda = db.getLastFinishedDeepRunAt();
      await scheduler.runCycle({ trigger: 'cron', plataformas: ['instagram'] });
      assert.equal(pedido('macri').lookback, '1 day');
      assert.ok(linea('[ciclo] inicio (trigger=cron, plataforma=instagram)'));
      assert.equal(lineas.filter((t) => /honda|corrida corta|próxima corrida/.test(t)).length, 0);
      assert.equal(db.getLastFinishedDeepRunAt(), ultimaHonda);
      assert.equal(scheduler.describeNextRun(), '');
    } finally {
      restore();
    }
  });

  // Va al final: deja en la base una honda terminada en 2031.
  test('describeNextRun: cuándo es la próxima corrida programada y si va a ser honda o corta', () => {
    process.env.MONITOR_DEEP_HOURS = '8,16';
    const honda = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', honda: true, startedAt: local(8, 0, 10, 0, 2031).toISOString() });
    db.finishMonitoringRun(honda, { finishedAt: local(8, 20, 10, 0, 2031).toISOString() });
    // Son las 9: sigue la de las 12, corta (la honda de las 8 terminó hace menos de 24 h).
    assert.equal(scheduler.describeNextRun(local(9, 0, 10, 0, 2031)), '10/01 12:00 · corta');
    // Son las 13: sigue la de las 16, honda por la hora.
    assert.equal(scheduler.describeNextRun(local(13, 0, 10, 0, 2031)), '10/01 16:00 · honda (por la hora)');
    // Al otro día a las 17, sin ninguna honda desde ayer a las 8: la de las 20 es honda.
    assert.equal(scheduler.describeNextRun(local(17, 0, 11, 0, 2031)), '11/01 20:00 · honda (pasaron más de 24 h desde la última honda)');
    // De noche: la próxima es mañana a las 8.
    assert.equal(scheduler.describeNextRun(local(21, 0, 10, 0, 2031)), '11/01 08:00 · honda (por la hora)');
  });
});
