'use strict';

// Registro por fuente (noviembre 2026, openspec/changes/ventana-por-fuente):
// cada consulta de detección de un ciclo deja una fila en
// monitoring_run_sources con cómo terminó, y de ahí sale el estado de la
// corrida (src/runStatus.js) que ven el log, el Pipeline, la barra y el
// inicio. Una corrida con búsquedas caídas ya no es "ok". Base y config
// temporales; el adapter y el clasificador son stubs; nada llama a Apify.

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fuentes-corrida-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
delete process.env.SEARCH_ENRICH_LIMIT;
delete process.env.SEARCH_RESULTS_LIMIT;
delete process.env.MONITOR_LOOKBACK;
for (const name of Object.keys(process.env)) if (name.startsWith('REACH_')) delete process.env[name];

const escribirConfig = (searches) =>
  fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], searches }, x: { accounts: [], keywords: [] } }, null, 2) + '\n');
escribirConfig(['macri', 'gcba', 'blacri']);

const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 'título', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'habla de la Ciudad' });

const db = require('../src/db');
const monitor = require('../src/monitor');
const scheduler = require('../src/scheduler');
const rs = require('../src/runStatus');
const { buildLastRun, estadoUltimaCorrida, estadoDeLaEscucha } = require('../src/lastRun');
const { armarInicio } = require('../src/inicioRoutes');
const { runWithContext } = require('../src/usageContext');
const { getPlatform, listPlatformIds } = require('../src/platforms');
const instagram = getPlatform('instagram');

let seq = 0;
function resultado(term, caption = 'Jorge Macri recorrió el barrio') {
  seq += 1;
  return {
    id: `p${seq}`,
    account: 'alguien',
    url: `https://www.instagram.com/p/p${seq}/`,
    caption,
    hashtagsText: '',
    likes: 1,
    comments: 0,
    postedAt: new Date().toISOString(),
    postType: 'imagen',
    followers: null,
    sourceType: 'search',
    sourceQuery: term,
  };
}

const ERROR_502 = () => Object.assign(new Error('Apify respondió 502: <html><head><title>502 Bad Gateway</title></head></html>'), { status: 502 });
const ERROR_TIMEOUT = () => Object.assign(new Error('Apify: se superó el timeout de seguridad (300000ms) — target=gcba'), { code: 'TIMEOUT', apifyRunId: 'run-gcba' });

/** Stub del adapter: `porTermino[term]` es una lista de posteos o una función que tira. */
function stubInstagram(porTermino, extra = {}) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeSearch', 'fetchPostDetails', 'scrapeAccount']) originals[key] = instagram[key];
  instagram.isConfigured = () => true;
  // El benchmark del ciclo completo consulta el perfil de las cuentas nuevas: acá no trae nada.
  instagram.scrapeAccount = async () => [];
  instagram.scrapeSearch = async (term, options = {}) => {
    const r = porTermino[term];
    if (typeof r === 'function') return r(options);
    return (r || []).map((p) => ({ ...p }));
  };
  instagram.fetchPostDetails = async () => [];
  Object.assign(instagram, extra);
  return () => Object.assign(instagram, originals);
}

// Sin red: cualquier pedido que se escape de los stubs falla el test.
global.fetch = async (url) => {
  throw new Error(`sin red: ${url}`);
};

let logs;
let consola;
beforeEach(() => {
  logs = [];
  consola = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
});
afterEach(() => Object.assign(console, consola));

describe('cada consulta de detección deja su fila', { concurrency: false }, () => {
  test('ciclo con una búsqueda con 502, otra cortada por tiempo y otra ok: tres filas con su estado, su motivo y su run', async () => {
    const restore = stubInstagram({
      macri: () => {
        throw ERROR_502();
      },
      gcba: (options) => {
        options.onRunStarted({ id: 'run-gcba' });
        throw ERROR_TIMEOUT();
      },
      blacri: [resultado('blacri')],
    });
    try {
      const runId = db.startMonitoringRun({ trigger: 'manual', plataforma: 'instagram' });
      const result = await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'] }));
      assert.deepEqual(result.porPlataforma.instagram.fuentes, [
        { tipo: 'busqueda', fuente: 'macri', estado: 'fallo', motivo: 'HTTP_502' },
        { tipo: 'busqueda', fuente: 'gcba', estado: 'fallo', motivo: 'TIMEOUT' },
        { tipo: 'busqueda', fuente: 'blacri', estado: 'ok', motivo: null },
      ]);

      const filas = db.listRunSources({ runId, plataforma: 'instagram' });
      assert.equal(filas.length, 3);
      const [macri, gcba, blacri] = filas;
      assert.equal(macri.estado, 'fallo');
      assert.equal(macri.motivo, 'HTTP_502');
      assert.equal(macri.detalle, 'Apify respondió 502: 502 Bad Gateway', 'el texto crudo, en una línea y sin HTML');
      assert.equal(macri.clave, 'macri');
      assert.equal(macri.tope, 100);
      assert.ok(macri.desdeIso && macri.startedAt && macri.finishedAt);
      assert.equal(gcba.motivo, 'TIMEOUT');
      assert.equal(gcba.apifyRunId, 'run-gcba', 'el run de Apify queda en la fila aunque la consulta se corte');
      assert.equal(blacri.estado, 'ok');
      assert.equal(blacri.items, 1);
      assert.equal(blacri.nuevos, 1);
      assert.equal(blacri.actor, 'apidojo~instagram-scraper-api');
      assert.deepEqual(db.listRunSources({ runId, plataforma: 'x' }), [], 'por plataforma');
      assert.throws(() => db.listRunSources({ runId }), /falta plataforma/);

      db.finishMonitoringRun(runId, { newPosts: 1, newCandidates: 1 });
      const run = db.getLastFinishedRun('instagram');
      assert.equal(rs.estadoCorrida(run, run.fuentes), 'incompleta');
      assert.equal(rs.resumenFallidas(run.fuentes).titulo, 'Fallaron 2 de 3 búsquedas');
    } finally {
      restore();
    }
  });

  test('sin corrida abierta (sin run_id) la consulta se registra igual', async () => {
    const restore = stubInstagram({ macri: [resultado('macri')], gcba: [], blacri: [] });
    try {
      const antes = db.listPendingRunSources('instagram').length;
      await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(db.listPendingRunSources('instagram').length, antes, 'ninguna quedó abierta');
    } finally {
      restore();
    }
  });

  test('no se buscó nada: sin credenciales o sin búsquedas configuradas queda una fila "plataforma" con el motivo', async () => {
    const originalConfigured = instagram.isConfigured;
    try {
      instagram.isConfigured = () => false;
      let runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram' });
      await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'], trigger: 'cron' }));
      let filas = db.listRunSources({ runId, plataforma: 'instagram' });
      assert.deepEqual(filas.map((f) => [f.tipo, f.estado, f.motivo]), [['plataforma', 'fallo', 'NOT_CONFIGURED']]);
      assert.equal(rs.resumenFallidas(filas).titulo, 'No se buscó nada: falta configuración del servidor');

      instagram.isConfigured = () => true;
      escribirConfig([]);
      runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram' });
      await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'], trigger: 'cron' }));
      filas = db.listRunSources({ runId, plataforma: 'instagram' });
      assert.deepEqual(filas.map((f) => [f.tipo, f.motivo]), [['plataforma', 'SIN_FUENTES']]);
      assert.equal(rs.estadoCorrida({ id: runId, finishedAt: 'x' }, filas), 'incompleta');
    } finally {
      instagram.isConfigured = originalConfigured;
      escribirConfig(['macri', 'gcba', 'blacri']);
    }
  });

  test('el detalle de los resultados nuevos también deja su fila: si falla, la corrida es incompleta', async () => {
    const sinTexto = { ...resultado('macri'), caption: '' };
    const restore = stubInstagram(
      { macri: [sinTexto], gcba: [], blacri: [] },
      {
        fetchPostDetails: async () => {
          throw ERROR_502();
        },
      }
    );
    try {
      const runId = db.startMonitoringRun({ trigger: 'manual', plataforma: 'instagram' });
      await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'] }));
      const filas = db.listRunSources({ runId, plataforma: 'instagram' });
      const detalle = filas.find((f) => f.tipo === 'detalle');
      assert.equal(detalle.estado, 'fallo');
      assert.equal(detalle.motivo, 'HTTP_502');
      assert.equal(detalle.tope, 1);
      assert.equal(rs.estadoCorrida({ id: runId, finishedAt: 'x' }, filas), 'incompleta');
      assert.equal(rs.resumenFallidas(filas).titulo, 'No se pudo pedir el texto de 1 resultado nuevo');
    } finally {
      restore();
    }
  });
});

describe('el cierre del ciclo dice cómo salió', { concurrency: false }, () => {
  test('scheduler: resultado=incompleta con lo que falló en el log, el estado en la respuesta, y la corrida guardada lo conserva', async () => {
    const restore = stubInstagram({
      macri: () => {
        throw ERROR_502();
      },
      gcba: [resultado('gcba')],
      blacri: [],
    });
    try {
      const result = await scheduler.runCycle({ plataforma: 'instagram' });
      assert.equal(result.estado, 'incompleta');
      assert.deepEqual(result.estadoPorPlataforma, { instagram: 'incompleta' });
      const fin = logs.find((l) => l.startsWith('[ciclo] fin'));
      assert.match(fin, /resultado=incompleta — instagram: falló 1 de 3 búsquedas: «macri» HTTP_502\)$/);
      assert.ok(logs.findIndex((l) => l.startsWith('[ciclo] fin')) < logs.findIndex((l) => l.startsWith('[costo] ciclo')), 'el orden de los logs no cambia');

      const lastRun = buildLastRun('instagram', { hasBenchmark: true });
      assert.equal(lastRun.estado, 'incompleta');
      assert.equal(lastRun.fallidas.titulo, 'Falló 1 de 3 búsquedas');
      assert.deepEqual(lastRun.fallidas.lineas, ['«macri» · Apify respondió con un error (502)']);
      assert.equal(estadoUltimaCorrida(['instagram']).estado, 'incompleta');
      assert.equal(estadoUltimaCorrida(['x']), null, 'una red que nunca corrió');
      assert.equal(estadoUltimaCorrida([]), null);

      // El estado de la escucha del inicio: la hora es de cualquier red, y
      // el estado va solo si es de ESA corrida. Una corrida a mano de X (en
      // pausa) que termina después no se muestra con lo que falló en la de
      // Instagram.
      const horaInstagram = db.getLastFinishedRunAtAny();
      assert.equal(estadoDeLaEscucha(['instagram'], horaInstagram).estado, 'incompleta');
      assert.equal(estadoDeLaEscucha(['instagram'], horaInstagram).fallidas.titulo, 'Falló 1 de 3 búsquedas');
      await new Promise((resolve) => setTimeout(resolve, 5));
      db.finishMonitoringRun(db.startMonitoringRun({ trigger: 'manual', plataforma: 'x' }), { newPosts: 0 });
      const horaX = db.getLastFinishedRunAtAny();
      assert.ok(horaX > horaInstagram);
      assert.deepEqual(estadoDeLaEscucha(['instagram'], horaX), { estado: null, fallidas: null });
      assert.deepEqual(estadoDeLaEscucha([], horaX), { estado: null, fallidas: null });
      assert.equal(estadoUltimaCorrida(['instagram']).estado, 'incompleta', 'la de Instagram sigue siendo la suya');

      // Nada crudo sale por la API: ni el texto del error ni el código HTML.
      const inicio = armarInicio({ listPlatformIds, getPlatform, cronPlatforms: () => ['instagram'], nextRunAt: () => new Date(), runHours: () => [8, 12, 16, 20] });
      const ig = inicio.redes.find((r) => r.id === 'instagram');
      const corrida = ig.corridasHoy.at(-1);
      assert.equal(corrida.estado, 'incompleta');
      assert.equal(corrida.fallidas.titulo, 'Falló 1 de 3 búsquedas');
      // Tampoco por la respuesta de "Actualizar ahora" (lo que devuelve
      // runCycle): ni el motivo en código de cada fuente.
      assert.equal(result.porPlataforma.instagram.fuentes, undefined);
      assert.equal(result.porPlataforma.instagram.newCandidates, 1, 'lo que usa la pantalla sigue viniendo');
      const salida = JSON.stringify({ lastRun, inicio, result });
      assert.doesNotMatch(salida, /Bad Gateway|respondió 502|detalle|HTTP_502/);
    } finally {
      restore();
    }
  });

  test('scheduler: una corrida con todas las búsquedas bien sigue cerrando como resultado=ok', async () => {
    const restore = stubInstagram({ macri: [resultado('macri')], gcba: [], blacri: [] });
    try {
      const result = await scheduler.runCycle({ plataforma: 'instagram' });
      assert.equal(result.estado, 'ok');
      assert.match(logs.find((l) => l.startsWith('[ciclo] fin')), /resultado=ok\)$/);
      const lastRun = buildLastRun('instagram', { hasBenchmark: true });
      assert.equal(lastRun.estado, 'ok');
      assert.equal(lastRun.fallidas, null);
    } finally {
      restore();
    }
  });

  test('corrida manual que tira por un error de plataforma: queda el código en monitoring_runs y no figura ok', async () => {
    const restore = stubInstagram({
      macri: () => {
        throw Object.assign(new Error('Apify respondió 401: token inválido'), { code: 'AUTH_INVALID', status: 401, userMessage: 'La clave de Apify del servidor es inválida.' });
      },
      gcba: [],
      blacri: [],
    });
    try {
      await assert.rejects(scheduler.runCycle({ plataforma: 'instagram' }), { code: 'AUTH_INVALID' });
      const run = db.getLastFinishedRun('instagram');
      assert.equal(run.errorCode, 'AUTH_INVALID');
      assert.equal(rs.estadoCorrida(run, run.fuentes), 'incompleta');
      assert.match(logs.find((l) => l.startsWith('[ciclo] fin')), /resultado=error: .* — instagram: falló 1 de 3 búsquedas: «macri» AUTH_INVALID\)$/);
    } finally {
      restore();
    }
  });
});

describe('el aviso de ciclo sin actividad', () => {
  test('heartbeatDue: cada chequeo el primer minuto; después, una vez por minuto (las búsquedas pueden esperar 15 min: no es un cuelgue)', () => {
    assert.equal(scheduler.heartbeatDue(10000, 999999), false, 'menos de 15 s sin actividad: nada');
    assert.equal(scheduler.heartbeatDue(15000, 0), true);
    assert.equal(scheduler.heartbeatDue(45000, 15000), true);
    assert.equal(scheduler.heartbeatDue(75000, 15000), false, 'pasado el minuto, no cada 15 s');
    assert.equal(scheduler.heartbeatDue(75000, 45000), false);
    assert.equal(scheduler.heartbeatDue(120000, 60000), true);
    assert.equal(scheduler.heartbeatDue(900000, 59000), false);
  });
});

describe('db: filas de monitoring_run_sources', { concurrency: false }, () => {
  test('startRunSource / updateRunSource: lo que no viene no se toca; las pendientes son las que esperan o quedaron abiertas', () => {
    const id = db.startRunSource({ runId: 900, plataforma: 'instagram', tipo: 'busqueda', fuente: 'Macri', clave: 'macri', tope: 500, desdeIso: '2026-11-06T15:00:00.000Z', until: '2026-11-06' });
    let fila = db.getRunSource(id);
    assert.equal(fila.estado, 'en curso');
    assert.equal(fila.intento, 1);
    assert.equal(fila.topeLleno, false);
    assert.ok(db.listPendingRunSources('instagram').some((f) => f.id === id));
    assert.equal(db.listPendingRunSources('x').length, 0);

    assert.equal(db.updateRunSource(id, { apifyRunId: 'run-1' }), 1);
    assert.equal(db.updateRunSource(id, { estado: 'esperando', motivo: 'TIMEOUT', detalle: 'se <b>cortó</b>\n a los 900 s' }), 1);
    fila = db.getRunSource(id);
    assert.equal(fila.apifyRunId, 'run-1');
    assert.equal(fila.estado, 'esperando');
    assert.equal(fila.detalle, 'se cortó a los 900 s');
    assert.equal(fila.tope, 500, 'lo que no vino sigue igual');
    assert.equal(fila.until, '2026-11-06');

    db.updateRunSource(id, { estado: 'recuperada', items: 500, nuevos: 120, topeLleno: true, recuperadaEn: 901, recuperadaAt: '2026-11-16T19:00:00.000Z' });
    fila = db.getRunSource(id);
    assert.equal(fila.estado, 'recuperada');
    assert.equal(fila.topeLleno, true);
    assert.equal(fila.recuperadaEn, 901);
    assert.ok(!db.listPendingRunSources('instagram').some((f) => f.id === id));
    assert.equal(db.updateRunSource(id, {}), 0);
    assert.equal(db.updateRunSource(999999, { estado: 'ok' }), 0);
    assert.throws(() => db.startRunSource({ tipo: 'busqueda' }), /falta plataforma/);

    const ultimas = db.lastRunSourcesForKey({ plataforma: 'instagram', tipo: 'busqueda', clave: 'macri', limit: 5 });
    assert.equal(ultimas[0].id, id);
  });
});
