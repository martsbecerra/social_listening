'use strict';

// Búsquedas que esperan y se levantan después (noviembre 2026,
// openspec/changes/ventana-por-fuente): una búsqueda cuya corrida de Apify
// no termina dentro de la espera queda "esperando" con su id, y el ciclo
// siguiente la levanta antes de buscar; sus posteos pasan por la misma
// tubería que cualquier resultado. Es lo que faltó en las corridas #55 y #56
// del piloto: diez búsquedas cortadas a los 300 s que terminaron bien en
// Apify y se perdieron. Base y config temporales; adapter, clasificador y
// fetch simulados; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
process.env.APIFY_POLL_RETRY_MS = '5';
process.env.POST_IMAGES = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-busquedas-pendientes-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
for (const name of ['SEARCH_ENRICH_LIMIT', 'SEARCH_RESULTS_LIMIT', 'MONITOR_LOOKBACK', 'SEARCH_WAIT_MS', 'SEARCH_RUN_TIMEOUT_SECS']) delete process.env[name];
for (const key of Object.keys(process.env)) if (/^(APIFY_RATE_|APIDOJO_)/.test(key)) delete process.env[key];

const escribirConfig = (searches) =>
  fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], searches }, x: { accounts: [], keywords: [] } }, null, 2) + '\n');
escribirConfig(['macri', 'gcba']);

const classifier = require('../src/classifier');
const clasificados = [];
classifier.clasificarPosteo = async (caption) => {
  clasificados.push(caption);
  return /gestión/i.test(caption)
    ? { relevant: true, title: 'La gestión', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'habla de la Ciudad' }
    : { relevant: false, title: 'otra cosa', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'no habla de la Ciudad' };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const apifyCost = require('../src/apifyCost');
const rs = require('../src/runStatus');
const { resolveSearchWait, searchWait, describeSearchWait } = require('../src/searchWait');
const { runWithContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const provider = require('../src/platforms/instagramApidojo');
const instagram = getPlatform('instagram');

const APIDOJO = 'apidojo~instagram-scraper-api';
let seq = 0;
function resultado(term, caption) {
  seq += 1;
  return {
    id: `q${seq}`,
    account: 'alguien',
    url: `https://www.instagram.com/p/q${seq}/`,
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

/** El error que tira el adapter cuando la corrida no termina dentro de la espera. */
function pendiente(runId) {
  return Object.assign(new Error(`Apify: se superó la espera (900000ms); el run ${runId} sigue en RUNNING`), { code: 'TIMEOUT', runPending: true, apifyRunId: runId });
}

const llamadas = { buscar: [], recuperar: [] };
/** Stub del adapter. `buscar[term]`: posteos o función; `recuperar[runId]`: lo que devuelve recoverSearchRun (o función). */
function stubInstagram({ buscar = {}, recuperar = {} } = {}) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeSearch', 'fetchPostDetails', 'recoverSearchRun']) originals[key] = instagram[key];
  llamadas.buscar = [];
  llamadas.recuperar = [];
  instagram.isConfigured = () => true;
  instagram.fetchPostDetails = async () => [];
  instagram.scrapeSearch = async (term, options = {}) => {
    llamadas.buscar.push({ term, deadlineAt: options.deadlineAt });
    const r = buscar[term];
    if (typeof r === 'function') return r(options);
    return (r || []).map((p) => ({ ...p }));
  };
  instagram.recoverSearchRun = async (row) => {
    llamadas.recuperar.push(row);
    const r = recuperar[row.apifyRunId];
    if (typeof r === 'function') return r(row);
    return r || { estado: 'desconocido', error: new Error('sin simular') };
  };
  return () => Object.assign(instagram, originals);
}

const ciclo = async () => {
  const runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram' });
  const result = await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'], trigger: 'cron' }));
  db.finishMonitoringRun(runId, { newPosts: result.newPosts.length });
  return { runId, result, filas: db.listRunSources({ runId, plataforma: 'instagram' }) };
};
const guardado = (id) => db.listDetectedPosts({ page: 1, pageSize: 200, plataforma: 'instagram' }).posts.find((p) => p.id === id);
/** Cierra cualquier pendiente que haya dejado el test anterior, para que cada uno arranque limpio. */
const limpiarPendientes = () => {
  for (const f of db.listPendingRunSources('instagram')) db.updateRunSource(f.id, { estado: 'fallo', motivo: 'TEST' });
};

let consola;
beforeEach(() => {
  consola = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  clasificados.length = 0;
  limpiarPendientes();
});
afterEach(() => Object.assign(console, consola));

describe('una búsqueda que no termina a tiempo queda esperando y el ciclo siguiente la levanta', { concurrency: false }, () => {
  test('queda esperando con su corrida; el ciclo siguiente levanta sus posteos, los clasifica una vez y vuelve a buscar el término', async () => {
    const viejo = resultado('macri', 'La gestión inauguró un túnel');
    const descartable = resultado('macri', 'receta de pan casero');
    let restore = stubInstagram({
      buscar: {
        macri: (options) => {
          options.onRunStarted({ id: 'run-macri-1' });
          throw pendiente('run-macri-1');
        },
        gcba: [],
      },
    });
    let primero;
    try {
      primero = await ciclo();
      // La llamada quedó en apify_calls como la deja src/apify.js: esperando, con su run.
      apifyCost.recordApifyCall({ runId: primero.runId, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['macri'], maxItems: 100 }, ok: false, error: 'TIMEOUT', estado: 'esperando', apifyRunId: 'run-macri-1' });
    } finally {
      restore();
    }
    const fila = primero.filas.find((f) => f.fuente === 'macri');
    assert.equal(fila.estado, 'esperando');
    assert.equal(fila.motivo, 'TIMEOUT');
    assert.equal(fila.apifyRunId, 'run-macri-1');
    assert.deepEqual(primero.result.porPlataforma.instagram.fuentes.find((f) => f.fuente === 'macri'), { tipo: 'busqueda', fuente: 'macri', estado: 'esperando', motivo: 'TIMEOUT' });
    assert.equal(rs.estadoCorrida(db.getMonitoringRun(primero.runId), primero.filas), 'incompleta');
    assert.equal(rs.resumenFallidas(primero.filas).titulo, '1 de 2 búsquedas sigue en Apify');
    assert.equal(clasificados.length, 0);

    // Ciclo siguiente: la corrida terminó bien en Apify.
    const nuevo = resultado('macri', 'La gestión presentó el presupuesto');
    restore = stubInstagram({
      buscar: { macri: [{ ...viejo }, nuevo], gcba: [] },
      recuperar: { 'run-macri-1': { estado: 'ok', posts: [viejo, descartable], rawItems: 7, runStatus: 'SUCCEEDED' } },
    });
    try {
      const segundo = await ciclo();
      assert.deepEqual(llamadas.recuperar.map((r) => [r.apifyRunId, r.termino, r.actor, r.desdeIso]), [['run-macri-1', 'macri', APIDOJO, fila.desdeIso]]);
      assert.deepEqual(llamadas.buscar.map((b) => b.term).sort(), ['gcba', 'macri'], 'el término se vuelve a buscar en este ciclo');
      assert.equal(clasificados.length, 3, 'el levantado, el descartable y el nuevo: cada uno una sola vez');
      assert.ok(guardado(viejo.id) && guardado(nuevo.id));
      assert.equal(db.getSearchSeen(descartable.id, 'instagram').outcome, 'descartado');
      assert.equal(segundo.result.porPlataforma.instagram.newCandidates, 3);

      const levantada = db.getRunSource(fila.id);
      assert.equal(levantada.estado, 'recuperada');
      assert.equal(levantada.motivo, 'TIMEOUT');
      assert.equal(levantada.items, 7);
      assert.equal(levantada.nuevos, 2);
      assert.equal(levantada.recuperadaEn, segundo.runId);
      assert.ok(levantada.recuperadaAt);
      assert.equal(levantada.finishedAt, fila.finishedAt, 'el cierre original no se pisa');
      assert.equal(segundo.filas.find((f) => f.fuente === 'macri').estado, 'ok');
      assert.equal(rs.estadoCorrida(db.getMonitoringRun(primero.runId), db.listRunSources({ runId: primero.runId, plataforma: 'instagram' })), 'incompleta', 'la corrida original no trajo eso cuando corrió');

      // Su llamada en apify_calls pasa a ser una llamada buena, con lo que trajo.
      const raw = new (require('node:sqlite').DatabaseSync)(process.env.MONITORING_DB_PATH, { readOnly: true });
      const call = raw.prepare("SELECT * FROM apify_calls WHERE apify_run_id = 'run-macri-1'").get();
      raw.close();
      assert.equal(call.estado, 'recuperada');
      assert.equal(call.ok, 1);
      assert.equal(call.error, null);
      assert.equal(call.items, 7);
      assert.ok(Math.abs(call.usd - (0.015 + 7 * 0.0005)) < 1e-9);
      assert.equal(db.getMonitoringRun(primero.runId).results, 7, 'los totales del ciclo que la lanzó se recalculan');

      // Un tercer ciclo no vuelve a levantar nada.
      llamadas.recuperar.length = 0;
      clasificados.length = 0;
      await ciclo();
      assert.equal(llamadas.recuperar.length, 0);
      assert.equal(clasificados.length, 0);
    } finally {
      restore();
    }
  });

  test('si la corrida sigue en Apify, el término no se vuelve a lanzar en este ciclo y la fila sigue esperando', async () => {
    const id = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'macri', clave: 'macri', estado: 'esperando', motivo: 'TIMEOUT', actor: APIDOJO, apifyRunId: 'run-vivo' });
    const restore = stubInstagram({ buscar: { gcba: [] }, recuperar: { 'run-vivo': { estado: 'corriendo', runStatus: 'RUNNING' } } });
    try {
      const { filas, result } = await ciclo();
      assert.deepEqual(llamadas.buscar.map((b) => b.term), ['gcba'], 'macri no se paga dos veces');
      assert.equal(db.getRunSource(id).estado, 'esperando');
      const salteada = filas.find((f) => f.fuente === 'macri');
      assert.equal(salteada.estado, 'fallo');
      assert.equal(salteada.motivo, 'SIGUE_EN_APIFY');
      assert.equal(salteada.apifyRunId, null, 'la de este ciclo no es otra corrida pendiente');
      assert.deepEqual(result.porPlataforma.instagram.fuentes.find((f) => f.fuente === 'macri'), { tipo: 'busqueda', fuente: 'macri', estado: 'fallo', motivo: 'SIGUE_EN_APIFY' });
      assert.equal(rs.resumenFallidas(filas).lineas[0], '«macri» · su corrida anterior sigue en Apify');
    } finally {
      restore();
    }
  });

  test('no se pudo leer: reciente, se saltea el término; vieja (ya no puede estar corriendo), se busca normal; pasados 7 días, perdida', async () => {
    const hace = (ms) => new Date(Date.now() - ms).toISOString();
    const reciente = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'macri', clave: 'macri', estado: 'esperando', actor: APIDOJO, apifyRunId: 'run-r', startedAt: hace(10 * 60 * 1000) });
    const vieja = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'gcba', clave: 'gcba', estado: 'esperando', actor: APIDOJO, apifyRunId: 'run-v', startedAt: hace(5 * 60 * 60 * 1000) });
    let restore = stubInstagram({ buscar: { gcba: [] } });
    try {
      await ciclo();
      assert.deepEqual(llamadas.buscar.map((b) => b.term), ['gcba']);
      assert.equal(db.getRunSource(reciente).estado, 'esperando');
      assert.equal(db.getRunSource(vieja).estado, 'esperando', 'se sigue intentando leer');
    } finally {
      restore();
    }
    limpiarPendientes();
    const muyVieja = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'macri', clave: 'macri', estado: 'esperando', actor: APIDOJO, apifyRunId: 'run-mv', startedAt: hace(8 * 24 * 60 * 60 * 1000) });
    restore = stubInstagram({ buscar: { macri: [], gcba: [] } });
    try {
      await ciclo();
      assert.equal(db.getRunSource(muyVieja).estado, 'perdida');
      assert.deepEqual(llamadas.buscar.map((b) => b.term).sort(), ['gcba', 'macri']);
    } finally {
      restore();
    }
  });

  test('Apify había cortado la corrida: entra lo que dejó y la fila queda parcial; un 404 la deja perdida', async () => {
    const algo = resultado('macri', 'La gestión arregló la plaza');
    const parcial = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'macri', clave: 'macri', estado: 'esperando', motivo: 'TIMEOUT', actor: APIDOJO, apifyRunId: 'run-p' });
    const perdida = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'gcba', clave: 'gcba', estado: 'esperando', motivo: 'TIMEOUT', actor: APIDOJO, apifyRunId: 'run-404' });
    apifyCost.recordApifyCall({ runId: 1, phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['gcba'] }, ok: false, error: 'TIMEOUT', estado: 'esperando', apifyRunId: 'run-404' });
    const restore = stubInstagram({
      buscar: { macri: [], gcba: [] },
      recuperar: { 'run-p': { estado: 'parcial', posts: [algo], rawItems: 1, runStatus: 'TIMED-OUT' }, 'run-404': { estado: 'perdida' } },
    });
    try {
      await ciclo();
      assert.ok(guardado(algo.id));
      assert.equal(db.getRunSource(parcial).estado, 'parcial');
      assert.equal(db.getRunSource(parcial).items, 1);
      assert.equal(db.getRunSource(perdida).estado, 'perdida');
      const raw = new (require('node:sqlite').DatabaseSync)(process.env.MONITORING_DB_PATH, { readOnly: true });
      const call = raw.prepare("SELECT estado, ok FROM apify_calls WHERE apify_run_id = 'run-404'").get();
      raw.close();
      assert.deepEqual({ ...call }, { estado: 'perdida', ok: 0 });
      assert.equal(rs.resumenFallidas([db.getRunSource(perdida)]).lineas[0], '«gcba» · su corrida ya no está en Apify');
    } finally {
      restore();
    }
  });

  test('una consulta que quedó abierta por una caída del proceso, sin corrida de Apify: fallo; un término que ya no está configurado: no se levanta', async () => {
    const abierta = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'macri', clave: 'macri' });
    const conRun = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'gcba', clave: 'gcba', actor: APIDOJO, apifyRunId: 'run-caida' });
    const borrado = db.startRunSource({ runId: 1, plataforma: 'instagram', tipo: 'busqueda', fuente: 'PDLC', clave: 'pdlc', estado: 'esperando', actor: APIDOJO, apifyRunId: 'run-pdlc' });
    const restore = stubInstagram({
      buscar: { macri: [], gcba: [] },
      recuperar: { 'run-caida': { estado: 'ok', posts: [resultado('gcba', 'La gestión y las veredas')], rawItems: 1, runStatus: 'SUCCEEDED' } },
    });
    try {
      await ciclo();
      assert.equal(db.getRunSource(abierta).estado, 'fallo');
      assert.equal(db.getRunSource(abierta).motivo, 'INTERRUMPIDA');
      assert.equal(db.getRunSource(conRun).estado, 'recuperada', 'la que tenía corrida se levanta aunque el proceso se haya caído');
      assert.equal(db.getRunSource(borrado).estado, 'sin_fuente');
      assert.deepEqual(llamadas.recuperar.map((r) => r.apifyRunId), ['run-caida'], 'la del término borrado ni se lee');
    } finally {
      restore();
    }
  });

  test('la espera es UNA para todas las búsquedas de la red; una corrida que Apify corta en el momento entrega lo que dejó (parcial)', async () => {
    const algo = resultado('gcba', 'La gestión en el barrio');
    const restore = stubInstagram({
      buscar: {
        macri: [],
        gcba: (options) => {
          options.onRunStarted({ id: 'run-cortado' });
          options.onMeta({ rawItems: 1, maxItems: 100, until: '2026-11-15', parcial: true, runStatus: 'TIMED-OUT' });
          return [algo];
        },
      },
    });
    process.env.SEARCH_WAIT_MS = '600000';
    try {
      const antes = Date.now();
      const { filas } = await ciclo();
      const [a, b] = llamadas.buscar;
      assert.equal(a.deadlineAt, b.deadlineAt, 'el mismo vencimiento para todas');
      assert.ok(a.deadlineAt >= antes + 600000 && a.deadlineAt <= Date.now() + 600000);
      const fila = filas.find((f) => f.fuente === 'gcba');
      assert.equal(fila.estado, 'parcial');
      assert.equal(fila.motivo, 'RUN_TIMED_OUT');
      assert.equal(fila.until, '2026-11-15');
      assert.equal(fila.apifyRunId, 'run-cortado');
      assert.ok(guardado(algo.id), 'lo que dejó se usa');
      assert.equal(rs.resumenFallidas(filas).lineas[0], '«gcba» · Apify cortó la corrida');
    } finally {
      delete process.env.SEARCH_WAIT_MS;
      restore();
    }
  });
});

describe('adapter apidojo: scrapeSearch por el flujo asincrónico y recoverSearchRun', { concurrency: false }, () => {
  const respond = (status, body, text = '') => ({ ok: status < 400, status, text: async () => text || JSON.stringify(body ?? ''), json: async () => body });
  const item = (id, createdAt) => ({ type: 'post', id: String(id), code: `C${id}`, url: `https://www.instagram.com/p/C${id}/`, createdAt, caption: `posteo ${id}`, owner: { username: 'alguien' } });

  test('scrapeSearch: si la corrida no termina dentro de la espera, el error dice que sigue pendiente y la llamada queda esperando con su run', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      if ((options.method || 'GET') === 'POST') return respond(201, { data: { id: 'run-lento', status: 'RUNNING', defaultDatasetId: 'ds-lento' } });
      await new Promise((r) => setTimeout(r, 150));
      return respond(200, { data: { id: 'run-lento', status: 'RUNNING', defaultDatasetId: 'ds-lento' } });
    };
    try {
      const avisos = [];
      await assert.rejects(
        runWithContext({ runId: 77, phase: 'busqueda' }, () => instagram.scrapeSearch('macri', { resultsLimit: 500, lookback: '10 days', deadlineAt: Date.now() + 1300, onRunStarted: (run) => avisos.push(run.id) })),
        (err) => err.code === 'TIMEOUT' && err.runPending === true && err.apifyRunId === 'run-lento'
      );
      assert.deepEqual(avisos, ['run-lento']);
      const raw = new (require('node:sqlite').DatabaseSync)(process.env.MONITORING_DB_PATH, { readOnly: true });
      const call = raw.prepare("SELECT * FROM apify_calls WHERE apify_run_id = 'run-lento'").get();
      raw.close();
      assert.equal(call.estado, 'esperando');
      assert.equal(call.run_id, 77);
      assert.equal(call.max_items, 500);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('scrapeSearch: una corrida que Apify cortó entrega lo que dejó y avisa que es parcial', async () => {
    const originalFetch = global.fetch;
    const ahora = new Date().toISOString();
    global.fetch = async (url, options = {}) => {
      if ((options.method || 'GET') === 'POST') return respond(201, { data: { id: 'run-f', status: 'RUNNING', defaultDatasetId: 'ds-f' } });
      if (/actor-runs/.test(url)) return respond(200, { data: { id: 'run-f', status: 'TIMED-OUT', defaultDatasetId: 'ds-f' } });
      return respond(200, [item(1, ahora), item(2, ahora)]);
    };
    try {
      let meta = null;
      const posts = await instagram.scrapeSearch('macri', { resultsLimit: 50, lookback: '1 day', onMeta: (m) => (meta = m) });
      assert.equal(posts.length, 2);
      assert.equal(meta.parcial, true);
      assert.equal(meta.runStatus, 'TIMED-OUT');
      assert.equal(meta.rawItems, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('recoverSearchRun: terminada, sus posteos con el término, filtrados por la ventana con la que se lanzó (no por la hora de ahora)', async () => {
    const originalFetch = global.fetch;
    const pedidos = [];
    global.fetch = async (url) => {
      pedidos.push(String(url).replace(/token=[^&]+/, 'token=***').replace('https://api.apify.com/v2', ''));
      if (/actor-runs\/run-ok/.test(url)) return respond(200, { data: { id: 'run-ok', status: 'SUCCEEDED', defaultDatasetId: 'ds-ok', startedAt: '2026-11-16T15:00:00.000Z', finishedAt: '2026-11-16T15:07:19.000Z' } });
      return respond(200, [item(1, '2026-11-05T23:59:00.000Z'), item(2, '2026-11-06T00:10:00.000Z'), item(3, '2026-11-10T12:00:00.000Z'), { ...item(4, null) }]);
    };
    try {
      const r = await provider.recoverSearchRun({ apifyRunId: 'run-ok', termino: ' macri ', desdeIso: '2026-11-06T15:00:00.608Z' });
      assert.equal(r.estado, 'ok');
      assert.equal(r.rawItems, 4);
      assert.equal(r.runStatus, 'SUCCEEDED');
      assert.deepEqual(r.posts.map((p) => p.id), ['2', '3'], 'desde las 00:00 UTC del día de la ventana; sin fecha, afuera');
      assert.ok(r.posts.every((p) => p.sourceType === 'search' && p.sourceQuery === 'macri'));
      assert.deepEqual(pedidos, ['/actor-runs/run-ok?token=***', '/datasets/ds-ok/items?token=***']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('recoverSearchRun: corriendo, cortada, 404 y lectura caída; nunca tira', async () => {
    const originalFetch = global.fetch;
    const estados = { 'run-vivo': 'RUNNING', 'run-cortado': 'ABORTED' };
    global.fetch = async (url) => {
      const id = (/actor-runs\/([^?]+)/.exec(url) || [])[1];
      if (id === 'run-404') return respond(404, null, 'Actor run was not found');
      if (id === 'run-502') return respond(502, null, 'Bad Gateway');
      if (id) return respond(200, { data: { id, status: estados[id], defaultDatasetId: `ds-${id}` } });
      return respond(200, [item(9, new Date().toISOString())]);
    };
    try {
      assert.equal((await provider.recoverSearchRun({ apifyRunId: 'run-vivo', termino: 'macri' })).estado, 'corriendo');
      const cortada = await provider.recoverSearchRun({ apifyRunId: 'run-cortado', termino: 'macri' });
      assert.equal(cortada.estado, 'parcial');
      assert.equal(cortada.posts.length, 1);
      assert.equal(cortada.runStatus, 'ABORTED');
      assert.deepEqual(await provider.recoverSearchRun({ apifyRunId: 'run-404', termino: 'macri' }), { estado: 'perdida' });
      const caida = await provider.recoverSearchRun({ apifyRunId: 'run-502', termino: 'macri' });
      assert.equal(caida.estado, 'desconocido');
      assert.match(caida.error.message, /502/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('la fachada elige el proveedor por el actor que lanzó la corrida, no por IG_ACTOR', async () => {
    const original = provider.recoverSearchRun;
    const vistos = [];
    provider.recoverSearchRun = async (row) => {
      vistos.push(row.apifyRunId);
      return { estado: 'corriendo' };
    };
    try {
      assert.equal((await instagram.recoverSearchRun({ actor: APIDOJO, apifyRunId: 'run-a', termino: 'macri' })).estado, 'corriendo');
      const sinProveedor = await instagram.recoverSearchRun({ actor: 'otro~actor', apifyRunId: 'run-b', termino: 'macri' });
      assert.equal(sinProveedor.estado, 'desconocido');
      assert.deepEqual(vistos, ['run-a']);
    } finally {
      provider.recoverSearchRun = original;
    }
  });
});

describe('SEARCH_WAIT_MS y SEARCH_RUN_TIMEOUT_SECS', () => {
  test('por defecto 15 minutos y 3600 s; el .env los cambia; un valor mal escrito aborta el arranque sin nombrar la variable al usuario', () => {
    assert.deepEqual(resolveSearchWait({}), { waitMs: 900000, runTimeoutSecs: 3600 });
    assert.deepEqual(resolveSearchWait({ SEARCH_WAIT_MS: ' 600000 ', SEARCH_RUN_TIMEOUT_SECS: '1800' }), { waitMs: 600000, runTimeoutSecs: 1800 });
    assert.deepEqual(resolveSearchWait({ SEARCH_WAIT_MS: '', SEARCH_RUN_TIMEOUT_SECS: '' }), { waitMs: 900000, runTimeoutSecs: 3600 });
    for (const env of [{ SEARCH_WAIT_MS: '15 min' }, { SEARCH_WAIT_MS: '500' }, { SEARCH_WAIT_MS: '-1' }, { SEARCH_RUN_TIMEOUT_SECS: '30' }, { SEARCH_RUN_TIMEOUT_SECS: '1.5' }]) {
      assert.throws(() => resolveSearchWait(env), (err) => {
        assert.match(err.message, /SEARCH_(WAIT_MS|RUN_TIMEOUT_SECS)="/);
        assert.doesNotMatch(err.userMessage, /SEARCH_/);
        return true;
      });
    }
    assert.deepEqual(searchWait({ SEARCH_WAIT_MS: 'roto' }), { waitMs: 900000, runTimeoutSecs: 3600 }, 'en el ciclo, un valor roto vale el default');
    assert.match(describeSearchWait({ waitMs: 900000, runTimeoutSecs: 3600 }), /^hasta 15 min por corrida para todas las búsquedas/);
  });
});
