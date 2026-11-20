'use strict';

// Tope por término y segunda consulta (noviembre 2026, openspec/changes/
// ventana-por-fuente). El actor no devuelve los resultados por fecha: una
// búsqueda que llena su tope pierde una parte de cada día. El tope de cada
// búsqueda sale del volumen medido de ese término (nunca menos que el de
// siempre) y, si igual se llena, se hace una segunda consulta mientras entre
// en el techo de gasto de la corrida; si no entra, queda marcado y la
// corrida es incompleta. Base y config temporales; adapter y clasificador
// simulados; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.POST_IMAGES = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tope-busqueda-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
const VARIABLES = ['SEARCH_ENRICH_LIMIT', 'SEARCH_RESULTS_LIMIT', 'SEARCH_RESULTS_MAX', 'SEARCH_EXTRA_MAX_USD_PER_CYCLE', 'MONITOR_LOOKBACK', 'MONITOR_LOOKBACK_MAX', 'MONITOR_MIN_WINDOW', 'SEARCH_WAIT_MS'];
for (const name of VARIABLES) delete process.env[name];
for (const key of Object.keys(process.env)) if (/^(APIFY_RATE_|APIDOJO_)/.test(key)) delete process.env[key];

const escribirConfig = (searches) =>
  fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], searches }, x: { accounts: [], keywords: [] } }, null, 2) + '\n');
escribirConfig(['macri']);

const classifier = require('../src/classifier');
const clasificados = [];
classifier.clasificarPosteo = async (caption) => {
  clasificados.push(caption);
  return { relevant: true, title: 'título', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'habla de la Ciudad' };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const apifyCost = require('../src/apifyCost');
const tope = require('../src/busquedaTope');
const rs = require('../src/runStatus');
const { runWithContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const APIDOJO = 'apidojo~instagram-scraper-api';
const HOUR_MS = 60 * 60 * 1000;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ≈ ${b}`);

let seq = 0;
function resultado(term) {
  seq += 1;
  return {
    id: `t${seq}`,
    account: 'alguien',
    url: `https://www.instagram.com/p/t${seq}/`,
    caption: `Jorge Macri en el barrio ${seq}`,
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

const pedidos = [];
/** Stub del adapter: `responder(term, options, n)` devuelve { posts, meta } o tira; n es el número de pedido de ese término. */
function stubInstagram(responder) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeSearch', 'fetchPostDetails', 'recoverSearchRun']) originals[key] = instagram[key];
  pedidos.length = 0;
  const veces = {};
  instagram.isConfigured = () => true;
  instagram.fetchPostDetails = async () => [];
  instagram.recoverSearchRun = async () => ({ estado: 'desconocido', error: new Error('sin simular') });
  instagram.scrapeSearch = async (term, options = {}) => {
    veces[term] = (veces[term] || 0) + 1;
    pedidos.push({ term, resultsLimit: options.resultsLimit, sinceIso: options.sinceIso, deadlineAt: options.deadlineAt });
    const r = await responder(term, options, veces[term]);
    if (r.meta && typeof options.onMeta === 'function') options.onMeta(r.meta);
    return r.posts;
  };
  return () => Object.assign(instagram, originals);
}
const llena = (n) => ({ rawItems: n, maxItems: n, until: '2026-11-15', parcial: false, runStatus: 'SUCCEEDED' });
const holgada = (n, max) => ({ rawItems: n, maxItems: max, until: '2026-11-15', parcial: false, runStatus: 'SUCCEEDED' });

const ciclo = async () => {
  const runId = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram' });
  const result = await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'], trigger: 'cron' }));
  db.finishMonitoringRun(runId, { newPosts: result.newPosts.length });
  return { runId, result, filas: db.listRunSources({ runId, plataforma: 'instagram' }) };
};

let consola;
let avisos;
beforeEach(() => {
  consola = { log: console.log, error: console.error, warn: console.warn };
  avisos = [];
  console.log = (...a) => avisos.push(a.join(' '));
  console.error = (...a) => avisos.push(a.join(' '));
  console.warn = (...a) => avisos.push(a.join(' '));
  clasificados.length = 0;
  for (const { key } of db.listRefreshStateByPrefix('detection_')) db.deleteRefreshState(key);
  for (const f of db.listPendingRunSources('instagram')) db.updateRunSource(f.id, { estado: 'fallo', motivo: 'TEST' });
  escribirConfig(['macri']);
});
afterEach(() => {
  Object.assign(console, consola);
  for (const name of VARIABLES) delete process.env[name];
});

describe('busquedaTope (puro)', () => {
  test('horasPedidas: desde las 00:00 UTC del until hasta el lanzamiento; mínimo 1; null sin until', () => {
    assert.equal(tope.horasPedidas('2026-11-15', '2026-11-16T16:24:00.000Z'), 40.4);
    assert.equal(tope.horasPedidas('2026-11-15T16:24:00.000Z', Date.parse('2026-11-16T00:00:00.000Z')), 24, 'de un instante toma su día');
    assert.equal(tope.horasPedidas('2026-11-16', '2026-11-16T00:10:00.000Z'), 1);
    assert.equal(tope.horasPedidas(null, '2026-11-16T00:10:00.000Z'), null);
    assert.equal(tope.horasPedidas('2026-11-16', 'nada'), null);
  });

  test('tasaTermino: el máximo de resultados por hora de las consultas recientes; un 0 aislado no la baja; el doble si esa consulta llenó su tope', () => {
    assert.equal(tope.tasaTermino([]), 0);
    assert.equal(tope.tasaTermino(undefined), 0);
    const calls = [
      { items: 0, maxItems: 50, until: '2026-11-15', at: '2026-11-16T16:24:00.000Z' }, // macri en la #57: 0 en 13 s
      { items: 48, maxItems: 500, until: '2026-11-13', at: '2026-11-15T00:00:00.000Z' }, // 48 en 48 h = 1 por hora
      { items: 12, maxItems: 50, until: '2026-11-14', at: '2026-11-15T00:00:00.000Z' }, // 0,5 por hora
    ];
    assert.equal(tope.tasaTermino(calls), 1);
    // La de 7 días de la sonda: 400 de 400 en 186,25 h. Llenó el tope: vale el doble.
    near(tope.tasaTermino([{ items: 400, maxItems: 400, until: '2026-11-09', at: '2026-11-16T18:15:00.000Z' }]), (400 / 186.25) * 2);
    // Una consulta anterior a noviembre 2026 (sin until ni tope): se toma como de 24 h.
    assert.equal(tope.tasaTermino([{ items: 24, maxItems: null, until: null, at: '2026-10-20T15:00:00.000Z' }]), 1);
  });

  test('topeParaTermino: nunca menos que el de siempre, sube con el volumen, hasta el máximo', () => {
    assert.equal(tope.topeParaTermino({ topeDeHoy: 50, tasa: 0, horas: 40 }), 50);
    assert.equal(tope.topeParaTermino({ topeDeHoy: 50, tasa: 0.2, horas: 40 }), 50, 'un término chico se queda con el de siempre');
    assert.equal(tope.topeParaTermino({ topeDeHoy: 50, tasa: 4.25, horas: 40 }), 340, 'el doble de lo que suele traer');
    assert.equal(tope.topeParaTermino({ topeDeHoy: 50, tasa: 100, horas: 40 }), 2000);
    assert.equal(tope.topeParaTermino({ topeDeHoy: 50, tasa: 100, horas: 40, resultsMax: 300 }), 300);
    // El piso es el de hoy: una ventana de 10 días con tope base 50 ya daba 500, con historia chica o sin ella.
    assert.equal(tope.topeParaTermino({ topeDeHoy: 500, tasa: 0.1, horas: 240 }), 500);
    assert.equal(tope.topeParaTermino({ topeDeHoy: 3000, tasa: 0, horas: 24, resultsMax: 2000 }), 3000, 'ni el máximo lo baja');
  });

  test('topeRelanzamiento y el techo de las segundas consultas', () => {
    assert.equal(tope.topeRelanzamiento(50), 200);
    assert.equal(tope.topeRelanzamiento(600), 2000);
    assert.equal(tope.topeRelanzamiento(2000), null, 'ya está en el máximo: no hay más que pedir');
    assert.equal(tope.topeRelanzamiento(100, 100), null);

    const p = tope.crearPresupuesto({ extraMaxUsd: 2 });
    assert.equal(p.reservar(1.015), true);
    assert.equal(p.reservar(1.015), false, 'la segunda de 2.000 ya no entra');
    assert.equal(p.reservar(0.985), true, 'una más chica sí, justo hasta el techo');
    near(p.reservado(), 2);
    assert.equal(p.reservar(0.001), false);
    assert.equal(tope.crearPresupuesto({ extraMaxUsd: 0 }).reservar(0.1), false);
    assert.equal(p.reservar(NaN), false);
  });

  test('configuración: valores por defecto, del .env y mal escritos (aborta el arranque sin nombrar la variable al usuario)', () => {
    assert.deepEqual(tope.resolveTopeConfig({}), { resultsMax: 2000, extraMaxUsd: 2 });
    assert.deepEqual(tope.resolveTopeConfig({ SEARCH_RESULTS_MAX: ' 500 ', SEARCH_EXTRA_MAX_USD_PER_CYCLE: '0,5' }), { resultsMax: 500, extraMaxUsd: 0.5 });
    assert.deepEqual(tope.resolveTopeConfig({ SEARCH_EXTRA_MAX_USD_PER_CYCLE: '0' }), { resultsMax: 2000, extraMaxUsd: 0 });
    for (const env of [{ SEARCH_RESULTS_MAX: '2.000' }, { SEARCH_RESULTS_MAX: '0' }, { SEARCH_RESULTS_MAX: 'mil' }, { SEARCH_EXTRA_MAX_USD_PER_CYCLE: '-1' }, { SEARCH_EXTRA_MAX_USD_PER_CYCLE: 'dos' }]) {
      assert.throws(() => tope.resolveTopeConfig(env), (err) => /SEARCH_/.test(err.message) && !/SEARCH_/.test(err.userMessage));
    }
    assert.deepEqual(tope.topeConfig({ SEARCH_RESULTS_MAX: 'mil' }), { resultsMax: 2000, extraMaxUsd: 2 });
    assert.equal(tope.describeTopeConfig({ resultsMax: 2000, extraMaxUsd: 2 }), 'tope máximo 2.000 resultados por búsqueda · si una llena su tope se pide más, hasta US$ 2,00 por corrida');
    assert.match(tope.describeTopeConfig({ resultsMax: 500, extraMaxUsd: 0 }), /sin segunda consulta/);
  });
});

describe('el ciclo: tope por volumen y segunda consulta', { concurrency: false }, () => {
  test('db.lastSearchCallsForTerm: las últimas búsquedas buenas del término, sin distinguir mayúsculas, de la más nueva a la más vieja', () => {
    const call = (target, items, extra = {}) =>
      apifyCost.recordApifyCall({ phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: [target], maxItems: 50, until: '2026-11-15' }, items, ok: true, ...extra });
    call('GCBA', 5);
    call('gcba', 9);
    call(' gcba ', 0, { ok: false, error: 'TIMEOUT' });
    call('otro', 30);
    const ultimas = db.lastSearchCallsForTerm('instagram', 'Gcba', 6);
    assert.deepEqual(ultimas.map((c) => c.items), [9, 5], 'las fallidas no cuentan');
    assert.equal(ultimas[0].maxItems, 50);
    assert.equal(ultimas[0].until, '2026-11-15');
    assert.equal(db.lastSearchCallsForTerm('instagram', 'gcba', 1).length, 1);
    // Mayúsculas acentuadas y Ñ: el término se compara como lo escribe una persona.
    call('POLICÍA DE LA CIUDAD', 40);
    call('policía de la ciudad', 41);
    call('Ñuñoa', 7);
    assert.deepEqual(db.lastSearchCallsForTerm('instagram', 'Policía de la Ciudad').map((c) => c.items), [41, 40]);
    assert.deepEqual(db.lastSearchCallsForTerm('instagram', 'POLICÍA DE LA CIUDAD').map((c) => c.items), [41, 40]);
    assert.deepEqual(db.lastSearchCallsForTerm('instagram', 'ñuñoa').map((c) => c.items), [7]);
    assert.deepEqual(db.lastSearchCallsForTerm('x', 'gcba'), []);
    assert.throws(() => db.lastSearchCallsForTerm(undefined, 'gcba'), /falta plataforma/);
  });

  test('un término que suele traer mucho pide un tope más alto que el base; uno sin historia, el de siempre', async () => {
    escribirConfig(['volumen', 'nuevo']);
    // Un término que llenó 400 de 400 pidiendo 7 días (como "macri" en la sonda del 16/11).
    apifyCost.recordApifyCall({ phase: 'busqueda', plataforma: 'instagram', actor: APIDOJO, input: { keywords: ['volumen'], maxItems: 400, until: '2026-11-09' }, items: 400, ok: true, at: '2026-11-16T18:15:00.000Z' });
    const restore = stubInstagram(() => ({ posts: [] }));
    try {
      const antes = Date.now();
      await ciclo();
      const macri = pedidos.find((p) => p.term === 'volumen');
      const tasa = (400 / 186.25) * 2;
      const horas = tope.horasPedidas(macri.sinceIso, antes);
      assert.ok(Math.abs(macri.resultsLimit - Math.ceil(2 * tasa * horas)) <= 1, `tope ${macri.resultsLimit}`);
      assert.ok(macri.resultsLimit > 200 && macri.resultsLimit < 500);
      assert.equal(pedidos.find((p) => p.term === 'nuevo').resultsLimit, 100);
    } finally {
      restore();
    }
  });

  test('tope lleno con lugar en el techo: segunda consulta con 4 veces el tope, las respuestas se juntan sin repetir y la corrida es ok', async () => {
    const a = resultado('macri');
    const b = resultado('macri');
    const c = resultado('macri');
    const restore = stubInstagram((term, options, n) =>
      n === 1 ? { posts: [a, b], meta: llena(100) } : { posts: [{ ...b }, c], meta: holgada(150, options.resultsLimit) }
    );
    try {
      const { filas, result, runId } = await ciclo();
      assert.deepEqual(pedidos.map((p) => p.resultsLimit), [100, 400]);
      assert.equal(pedidos[0].sinceIso, pedidos[1].sinceIso, 'la misma ventana');
      assert.equal(pedidos[0].deadlineAt, pedidos[1].deadlineAt, 'y la misma espera: la detección no se alarga');
      assert.equal(clasificados.length, 3, 'tres posteos distintos');
      assert.equal(result.porPlataforma.instagram.newCount, 3);
      const [primera, segunda] = filas;
      assert.deepEqual([primera.intento, primera.estado, primera.tope, primera.items, primera.topeLleno], [1, 'ok', 100, 100, false]);
      assert.deepEqual([segunda.intento, segunda.estado, segunda.tope, segunda.items, segunda.topeLleno], [2, 'ok', 400, 150, false]);
      assert.equal(primera.nuevos, 3);
      assert.equal(rs.estadoCorrida(db.getMonitoringRun(runId), filas), 'ok');
      assert.deepEqual(result.porPlataforma.instagram.fuentes, [{ tipo: 'busqueda', fuente: 'macri', estado: 'ok', motivo: null }]);
      assert.ok(avisos.some((l) => /«macri» llenó su tope \(100\): se pide más, con tope 400 \(hasta US\$ 0\.2[12]\)/.test(l)));
    } finally {
      restore();
    }
  });

  test('sin lugar en el techo: no hay segunda consulta, queda marcado "tope lleno", la corrida es incompleta y la marca avanza igual', async () => {
    process.env.SEARCH_EXTRA_MAX_USD_PER_CYCLE = '0.1';
    const restore = stubInstagram(() => ({ posts: [resultado('macri')], meta: llena(100) }));
    try {
      const antes = Date.now();
      const { filas, result, runId } = await ciclo();
      assert.equal(pedidos.length, 1, 'la consulta normal no se recorta; la segunda no entra');
      assert.equal(filas.length, 1);
      assert.equal(filas[0].topeLleno, true);
      assert.equal(filas[0].estado, 'ok');
      assert.equal(rs.estadoCorrida(db.getMonitoringRun(runId), filas), 'incompleta');
      assert.equal(rs.resumenFallidas(filas).titulo, '«macri» llegó al tope de 100 resultados');
      assert.deepEqual(result.porPlataforma.instagram.fuentes, [{ tipo: 'busqueda', fuente: 'macri', estado: 'ok', motivo: null, topeLleno: true }]);
      assert.ok(Math.abs(Date.parse(db.getRefreshState(monitor.sourceMarkKey('instagram', 'busqueda', 'macri'))) - antes) < 5000, 'si no avanzara, la ventana crecería sin fin');
      assert.ok(avisos.some((l) => /no entra en el techo de esta corrida/.test(l)));
    } finally {
      restore();
    }
  });

  test('el techo es de la corrida: con dos búsquedas llenas y lugar para una sola segunda consulta, la otra queda marcada', async () => {
    escribirConfig(['macri', 'gcba']);
    process.env.SEARCH_EXTRA_MAX_USD_PER_CYCLE = '0.25'; // una segunda de 400 cuesta hasta 0,215
    const restore = stubInstagram((term, options, n) => (n === 1 ? { posts: [resultado(term)], meta: llena(100) } : { posts: [], meta: holgada(120, options.resultsLimit) }));
    try {
      const { filas } = await ciclo();
      assert.equal(pedidos.filter((p) => p.resultsLimit === 400).length, 1);
      const primeras = filas.filter((f) => f.intento === 1);
      assert.deepEqual(primeras.map((f) => f.topeLleno).sort(), [false, true]);
    } finally {
      restore();
    }
  });

  test('ya en el máximo, la segunda también se llena, falla o queda en Apify: se usa lo de la primera y queda marcado', async () => {
    // En el máximo: no hay más que pedir.
    process.env.SEARCH_RESULTS_MAX = '100';
    let restore = stubInstagram(() => ({ posts: [], meta: llena(100) }));
    try {
      const { filas } = await ciclo();
      assert.equal(pedidos.length, 1);
      assert.equal(filas[0].topeLleno, true);
    } finally {
      restore();
      delete process.env.SEARCH_RESULTS_MAX;
    }

    // La segunda también se llena.
    restore = stubInstagram((term, options) => ({ posts: [], meta: llena(options.resultsLimit) }));
    try {
      const { filas } = await ciclo();
      assert.deepEqual(filas.map((f) => [f.intento, f.topeLleno]), [[1, true], [2, true]]);
    } finally {
      restore();
    }

    // La segunda falla: lo de la primera se usa igual.
    const unico = resultado('macri');
    restore = stubInstagram((term, options, n) => {
      if (n === 1) return { posts: [unico], meta: llena(100) };
      throw Object.assign(new Error('Apify respondió 502: Bad Gateway'), { status: 502 });
    });
    try {
      const { filas, result } = await ciclo();
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      assert.deepEqual(filas.map((f) => [f.intento, f.estado, f.motivo, f.topeLleno]), [[1, 'ok', null, true], [2, 'fallo', 'HTTP_502', false]]);
    } finally {
      restore();
    }

    // La segunda no termina a tiempo: queda esperando con su corrida, como cualquier búsqueda.
    restore = stubInstagram((term, options, n) => {
      if (n === 1) return { posts: [], meta: llena(100) };
      options.onRunStarted({ id: 'run-segunda' });
      throw Object.assign(new Error('Apify: se superó la espera'), { code: 'TIMEOUT', runPending: true, apifyRunId: 'run-segunda' });
    });
    try {
      const { filas, runId } = await ciclo();
      const segunda = filas.find((f) => f.intento === 2);
      assert.deepEqual([segunda.estado, segunda.apifyRunId], ['esperando', 'run-segunda']);
      assert.equal(filas.find((f) => f.intento === 1).topeLleno, true);
      assert.equal(rs.estadoCorrida(db.getMonitoringRun(runId), filas), 'incompleta');
      assert.ok(db.listPendingRunSources('instagram').some((f) => f.id === segunda.id), 'el ciclo siguiente la levanta');
    } finally {
      restore();
    }
  });

  test('la segunda consulta quedó en Apify: la corrida dice que lo que falta sigue en Apify; al levantarla, la primera deja de decir "tope lleno" si no llenó el suyo', async () => {
    const segundaPendiente = (run) => (term, options, n) => {
      if (n === 1) return { posts: [], meta: llena(100) };
      options.onRunStarted({ id: run });
      throw Object.assign(new Error('Apify: se superó la espera'), { code: 'TIMEOUT', runPending: true, apifyRunId: run });
    };
    const levantar = async (rawItems) => {
      const restore = stubInstagram(() => ({ posts: [], meta: holgada(3, 100) }));
      instagram.recoverSearchRun = async () => ({ estado: 'ok', posts: [], rawItems, runStatus: 'SUCCEEDED' });
      try {
        await ciclo();
      } finally {
        restore();
      }
    };

    let restore = stubInstagram(segundaPendiente('run-2a'));
    let uno;
    try {
      uno = await ciclo();
    } finally {
      restore();
    }
    let r = rs.resumenFallidas(uno.filas);
    assert.equal(r.pipeline, '«macri» llegó al tope de 100 resultados: lo que falta sigue en Apify y se levanta en la próxima corrida.');
    assert.deepEqual(r.lineas, ['«macri» · llegó al tope de 100 resultados: lo que falta sigue en Apify, se levanta en la próxima corrida']);

    // La segunda se levanta con 150 de 400: ya no falta nada.
    await levantar(150);
    let filas = db.listRunSources({ runId: uno.runId, plataforma: 'instagram' });
    assert.deepEqual(filas.map((f) => [f.intento, f.estado, f.items, f.topeLleno]), [[1, 'ok', 100, false], [2, 'recuperada', 150, false]]);
    assert.equal(rs.estadoCorrida(db.getMonitoringRun(uno.runId), filas), 'incompleta', 'la corrida no trajo eso cuando corrió');
    r = rs.resumenFallidas(filas);
    assert.equal(r.pipeline, '«macri» llegó al tope de 100 resultados: lo que faltaba se levantó en una corrida posterior.');
    assert.deepEqual(r.lineas, ['«macri» · llegó al tope de 100 resultados · lo que faltaba se levantó después']);

    // Otra corrida igual, pero la segunda también llenó su tope (400 de 400): sigue pudiendo faltar algo.
    restore = stubInstagram(segundaPendiente('run-2b'));
    let dos;
    try {
      dos = await ciclo();
    } finally {
      restore();
    }
    await levantar(400);
    filas = db.listRunSources({ runId: dos.runId, plataforma: 'instagram' });
    assert.deepEqual(filas.map((f) => [f.intento, f.estado, f.topeLleno]), [[1, 'ok', true], [2, 'recuperada', true]]);
    assert.equal(rs.resumenFallidas(filas).pipeline, '«macri» llegó al tope de 100 resultados: puede faltar algo.');
  });

  test('un adapter que no informa la meta de la consulta: no se sabe si llenó el tope, no hay segunda consulta', async () => {
    const restore = stubInstagram(() => ({ posts: Array.from({ length: 100 }, () => resultado('macri')) }));
    try {
      const { filas } = await ciclo();
      assert.equal(pedidos.length, 1);
      assert.equal(filas[0].topeLleno, false);
      assert.equal(filas[0].items, 100);
    } finally {
      restore();
    }
  });
});

describe('la línea de costo del ciclo', () => {
  test('suma las búsquedas que quedaron esperando y lo que clasificó el modelo; sin nada de eso es la de siempre', () => {
    const run = { id: 58, calls: 9, results: 105, usd: 0.172, porFase: { busqueda: { results: 105 } } };
    const base = '[costo] ciclo #58: 9 llamadas, 105 resultados ≈ US$ 0.17 (monitoreo 0 · busqueda 105 · benchmark 0 · refresco 0)';
    assert.equal(apifyCost.formatCycleCostLine(run), base);
    assert.equal(apifyCost.formatCycleCostLine(run, { esperando: 0, clasificaciones: 0 }), base);
    assert.equal(
      apifyCost.formatCycleCostLine(run, { esperando: 2, clasificaciones: 67, clasificacionesUsd: 0.5234 }),
      `${base} · 2 búsquedas esperando en Apify · 67 clasificaciones ≈ US$ 0.52 (estimado, modelo)`
    );
    assert.equal(apifyCost.formatCycleCostLine(run, { esperando: 1, clasificaciones: 1, clasificacionesUsd: null }), `${base} · 1 búsqueda esperando en Apify · 1 clasificación`);
  });

  test('db.sumSearchSeenByRun: cuántos resultados decidió el modelo en una corrida y lo que costó', () => {
    db.markSearchSeen({ postId: 'c1', plataforma: 'instagram', term: 'macri', outcome: 'descartado', llmUsd: 0.01, runId: 700 });
    db.markSearchSeen({ postId: 'c2', plataforma: 'instagram', term: 'macri', outcome: 'guardado', llmUsd: 0.02, runId: 700 });
    db.markSearchSeen({ postId: 'c3', plataforma: 'instagram', term: 'macri', outcome: 'descartado', runId: 701 });
    const r = db.sumSearchSeenByRun(700);
    assert.equal(r.n, 2);
    near(r.usd, 0.03);
    assert.deepEqual(db.sumSearchSeenByRun(701), { n: 1, usd: null });
    assert.deepEqual(db.sumSearchSeenByRun(999), { n: 0, usd: null });
    assert.deepEqual(db.sumSearchSeenByRun(null), { n: 0, usd: null });
  });
});
