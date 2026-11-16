'use strict';

// Ventana y marca de detección POR FUENTE (noviembre 2026, openspec/changes/
// ventana-por-fuente). Antes había una sola marca por red, que avanzaba
// aunque fallaran búsquedas: en las corridas #55 y #56 del piloto quedaron
// días enteros sin pedir. Ahora cada búsqueda retoma desde SU última
// detección exitosa, con un mínimo (MONITOR_MIN_WINDOW) y un techo
// (MONITOR_LOOKBACK_MAX). Base y config temporales; adapters y clasificador
// simulados; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.POST_IMAGES = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ventana-fuente-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
for (const name of ['SEARCH_ENRICH_LIMIT', 'SEARCH_RESULTS_LIMIT', 'MONITOR_LOOKBACK', 'MONITOR_LOOKBACK_MAX', 'MONITOR_MIN_WINDOW', 'MONITOR_ACCOUNT_LIMIT', 'MONITOR_HASHTAG_LIMIT', 'MONITOR_RESULTS_LIMIT', 'SEARCH_WAIT_MS']) {
  delete process.env[name];
}

const escribirConfig = (instagram, x = { accounts: [], keywords: [] }) =>
  fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [], ...instagram }, x }, null, 2) + '\n');
escribirConfig({ searches: ['macri', 'gcba'] });

const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 'título', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'habla de la Ciudad' });

const db = require('../src/db');
const monitor = require('../src/monitor');
const rs = require('../src/runStatus');
const { runWithContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const x = getPlatform('x');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-16T15:00:00.000Z');
const RED = 'detection_last_success:instagram';
const FLAG = 'detection_por_fuente:instagram';
const marca = (term, tipo = 'busqueda', red = 'instagram') => monitor.sourceMarkKey(red, tipo, term);
const hace = (ms, desde = Date.now()) => new Date(desde - ms).toISOString();
// "Hace casi N días": la ventana redondea para arriba a días enteros, así que una marca de hace
// N días justos, unos milisegundos después, ya pide N + 1.
const casi = (dias) => hace(dias * DAY_MS - HOUR_MS);
const cerca = (iso, ms, tolerancia = 5000) => Math.abs(Date.parse(iso) - ms) <= tolerancia;

/** Deja la red como si el código nuevo ya hubiera migrado: la marca de la red y su testigo coinciden. */
function alDia(iso = hace(4 * HOUR_MS)) {
  db.setRefreshState(RED, iso);
  db.setRefreshState(FLAG, iso);
}
function borrarMarcas() {
  for (const { key } of db.listRefreshStateByPrefix('detection_')) db.deleteRefreshState(key);
}

const ERROR_502 = () => Object.assign(new Error('Apify respondió 502: Bad Gateway'), { status: 502 });
const pedidos = [];
/** Stub del adapter de Instagram: `buscar[term]` es una lista de posteos o una función. */
function stubInstagram(buscar = {}, extra = {}) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeSearch', 'fetchPostDetails', 'recoverSearchRun']) originals[key] = instagram[key];
  pedidos.length = 0;
  instagram.isConfigured = () => true;
  instagram.fetchPostDetails = async () => [];
  instagram.recoverSearchRun = async () => ({ estado: 'desconocido', error: new Error('sin simular') });
  instagram.scrapeSearch = async (term, options = {}) => {
    pedidos.push({ term, lookback: options.lookback, resultsLimit: options.resultsLimit, sinceIso: options.sinceIso });
    const r = buscar[term];
    if (typeof r === 'function') return r(options);
    return r || [];
  };
  Object.assign(instagram, extra);
  return () => Object.assign(instagram, originals);
}
const pedido = (term) => pedidos.find((p) => p.term === term);

const ciclo = async (opciones = { plataformas: ['instagram'], trigger: 'cron' }) => {
  const runId = db.startMonitoringRun({ trigger: 'cron', plataforma: (opciones.plataformas || ['todas']).join(',') });
  const result = await runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle(opciones));
  db.finishMonitoringRun(runId, { newPosts: result.newPosts.length });
  return { runId, result };
};

let consola;
beforeEach(() => {
  consola = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  borrarMarcas();
  for (const f of db.listPendingRunSources('instagram')) db.updateRunSource(f.id, { estado: 'fallo', motivo: 'TEST' });
  escribirConfig({ searches: ['macri', 'gcba'] });
});
afterEach(() => {
  Object.assign(console, consola);
  for (const name of ['MONITOR_LOOKBACK', 'MONITOR_LOOKBACK_MAX', 'MONITOR_MIN_WINDOW']) delete process.env[name];
});

describe('detectionWindowFor por fuente (reloj fijo)', { concurrency: false }, () => {
  const ventana = (fuente, extra = {}) => monitor.detectionWindowFor('instagram', { tipo: 'busqueda', fuente, now: NOW, ...extra });

  test('sin marca (fuente nueva): MONITOR_LOOKBACK; con marca vieja, desde la marca; con marca reciente, el mínimo de 1 día', () => {
    let w = ventana('macri');
    assert.deepEqual(w, { lookback: '1 day', windowDays: 1, isDefault: true, sinceIso: new Date(NOW - DAY_MS).toISOString(), origen: 'primera', huecoDesde: null });

    const tresDias = new Date(NOW - 3 * DAY_MS).toISOString();
    db.setRefreshState(marca('macri'), tresDias);
    w = ventana('macri');
    assert.deepEqual(w, { lookback: '3 days', windowDays: 3, isDefault: false, sinceIso: tresDias, origen: 'marca', huecoDesde: null });

    db.setRefreshState(marca('macri'), new Date(NOW - 4 * HOUR_MS).toISOString());
    w = ventana('macri');
    assert.equal(w.lookback, '1 day');
    assert.equal(w.origen, 'minimo');
    assert.equal(w.sinceIso, new Date(NOW - DAY_MS).toISOString(), 'aunque la marca sea de hace 4 h, mira 24 h: como siempre');
  });

  test('cada fuente tiene su marca: una caída de "macri" no cambia la ventana de "gcba", ni la de otra red', () => {
    db.setRefreshState(marca('macri'), new Date(NOW - 12 * DAY_MS).toISOString());
    db.setRefreshState(marca('gcba'), new Date(NOW - 4 * HOUR_MS).toISOString());
    assert.equal(ventana('macri').windowDays, 12);
    assert.equal(ventana('gcba').windowDays, 1);
    assert.equal(monitor.detectionWindowFor('x', { tipo: 'keyword', fuente: 'macri', now: NOW }).origen, 'primera');
    assert.equal(monitor.detectionWindowFor('instagram', { tipo: 'cuenta', fuente: 'macri', now: NOW }).origen, 'primera', 'el tipo es parte de la clave');
  });

  test('la clave se normaliza como la config: espacios, mayúsculas, "@" y "#"', () => {
    assert.equal(monitor.sourceMarkKey('instagram', 'busqueda', '  Gobierno Porteño '), 'detection_last_success:instagram:busqueda:gobierno porteño');
    assert.equal(monitor.sourceMarkKey('x', 'cuenta', '@JorgeMacri'), 'detection_last_success:x:cuenta:jorgemacri');
    assert.equal(monitor.sourceMarkKey('x', 'hashtag', '#CABA'), 'detection_last_success:x:hashtag:caba');
    db.setRefreshState(marca('gcba'), new Date(NOW - 5 * DAY_MS).toISOString());
    assert.equal(ventana(' GCBA ').windowDays, 5);
  });

  test('techo MONITOR_LOOKBACK_MAX: una marca de hace 45 días pide 30 y dice desde dónde quedó el hueco', () => {
    const vieja = new Date(NOW - 45 * DAY_MS).toISOString();
    db.setRefreshState(marca('macri'), vieja);
    let w = ventana('macri');
    assert.equal(w.windowDays, 30);
    assert.equal(w.origen, 'techo');
    assert.equal(w.huecoDesde, vieja);
    assert.equal(w.sinceIso, new Date(NOW - 30 * DAY_MS).toISOString());

    process.env.MONITOR_LOOKBACK_MAX = '3 days';
    w = ventana('macri');
    assert.equal(w.windowDays, 3);
    // La primera corrida de una fuente también respeta el techo, sin hueco que anotar.
    process.env.MONITOR_LOOKBACK = '10 days';
    w = ventana('nueva');
    assert.equal(w.windowDays, 3);
    assert.equal(w.huecoDesde, null);
  });

  test('MONITOR_MIN_WINDOW: lo mínimo que mira cada consulta, aunque la marca sea reciente', () => {
    db.setRefreshState(marca('macri'), new Date(NOW - 4 * HOUR_MS).toISOString());
    process.env.MONITOR_MIN_WINDOW = '7 days';
    let w = ventana('macri');
    assert.equal(w.lookback, '7 days');
    assert.equal(w.origen, 'minimo');
    assert.equal(w.sinceIso, new Date(NOW - 7 * DAY_MS).toISOString());
    // Una marca más vieja que el mínimo manda igual.
    db.setRefreshState(marca('macri'), new Date(NOW - 9 * DAY_MS).toISOString());
    assert.equal(ventana('macri').windowDays, 9);
    process.env.MONITOR_MIN_WINDOW = 'cualquiera';
    db.setRefreshState(marca('macri'), new Date(NOW - 4 * HOUR_MS).toISOString());
    assert.equal(ventana('macri').lookback, '1 day', 'un valor que no se entiende vale 1 día');
  });

  test('cubiertoHasta: una corrida levantada cubre hasta su lanzamiento, si es posterior a la marca', () => {
    db.setRefreshState(marca('macri'), new Date(NOW - 12 * DAY_MS).toISOString());
    const lanzada = new Date(NOW - 2 * DAY_MS).toISOString();
    assert.equal(ventana('macri', { cubiertoHasta: lanzada }).sinceIso, lanzada);
    assert.equal(ventana('macri', { cubiertoHasta: new Date(NOW - 20 * DAY_MS).toISOString() }).windowDays, 12, 'una anterior a la marca no la retrocede');
    assert.equal(ventana('sin-marca', { cubiertoHasta: lanzada }).origen, 'marca');
  });
});

describe('el ciclo: cada búsqueda retoma desde su última detección exitosa', { concurrency: false }, () => {
  test('las corridas #55 y #56: "macri" falla y "gcba" responde; la marca de macri no avanza y la siguiente corrida le pide los días que faltan', async () => {
    alDia();
    const tresDias = casi(3);
    db.setRefreshState(marca('macri'), tresDias);
    db.setRefreshState(marca('gcba'), hace(4 * HOUR_MS));
    const redAntes = db.getRefreshState(RED);

    let restore = stubInstagram({
      macri: () => {
        throw ERROR_502();
      },
      gcba: [],
    });
    try {
      const antes = Date.now();
      await ciclo();
      assert.deepEqual(pedido('macri'), { term: 'macri', lookback: '3 days', resultsLimit: 300, sinceIso: tresDias });
      assert.equal(pedido('gcba').lookback, '1 day');
      assert.equal(pedido('gcba').resultsLimit, 100);
      assert.equal(db.getRefreshState(marca('macri')), tresDias, 'falló: su marca no avanza');
      assert.ok(cerca(db.getRefreshState(marca('gcba')), antes), 'respondió: su marca pasa al inicio del ciclo');
      assert.equal(db.getRefreshState(RED), redAntes, 'la marca de la red no avanza si alguna fuente no avanzó');
    } finally {
      restore();
    }

    // Al día siguiente macri responde: se le piden los días que faltaban.
    restore = stubInstagram({ macri: [], gcba: [] });
    try {
      const antes = Date.now();
      await ciclo();
      assert.equal(pedido('macri').lookback, '3 days');
      assert.equal(pedido('macri').sinceIso, tresDias);
      assert.ok(cerca(db.getRefreshState(marca('macri')), antes));
      assert.ok(cerca(db.getRefreshState(RED), antes), 'todas respondieron: avanza también la marca de la red');
      assert.equal(db.getRefreshState(FLAG), db.getRefreshState(RED));
    } finally {
      restore();
    }
  });

  test('una búsqueda nueva que falla queda con la marca en el inicio de lo que se intentó: el reintento pide más, no arranca de cero', async () => {
    alDia();
    escribirConfig({ searches: ['nueva'] });
    const restore = stubInstagram({
      nueva: () => {
        throw ERROR_502();
      },
    });
    try {
      const antes = Date.now();
      await ciclo();
      const guardada = db.getRefreshState(marca('nueva'));
      assert.ok(cerca(guardada, antes - DAY_MS));
      const manana = monitor.detectionWindowFor('instagram', { tipo: 'busqueda', fuente: 'nueva', now: antes + DAY_MS });
      assert.equal(manana.lookback, '2 days');
      // Y si vuelve a fallar, la marca no se mueve.
      await ciclo();
      assert.equal(db.getRefreshState(marca('nueva')), guardada);
    } finally {
      restore();
    }
  });

  test('error de plataforma en el cron (cuota): avanzan las que respondieron, no la que falló ni la marca de la red', async () => {
    alDia();
    const vieja = hace(2 * DAY_MS);
    db.setRefreshState(marca('macri'), vieja);
    db.setRefreshState(marca('gcba'), vieja);
    const redAntes = db.getRefreshState(RED);
    const restore = stubInstagram({
      macri: () => {
        throw Object.assign(new Error('Apify respondió 403: Monthly usage hard limit exceeded'), { code: 'QUOTA_EXCEEDED', userMessage: 'Se agotó la cuota mensual de Apify.' });
      },
      gcba: [],
    });
    try {
      const antes = Date.now();
      const { result } = await ciclo();
      assert.equal(result.porPlataforma.instagram.error.code, 'QUOTA_EXCEEDED');
      assert.equal(db.getRefreshState(marca('macri')), vieja);
      assert.ok(cerca(db.getRefreshState(marca('gcba')), antes));
      assert.equal(db.getRefreshState(RED), redAntes);
    } finally {
      restore();
    }
  });

  test('una búsqueda que queda esperando no avanza; cuando se levanta, la marca llega al lanzamiento de esa corrida y este ciclo busca desde ahí', async () => {
    alDia();
    const cincoDias = hace(5 * DAY_MS);
    db.setRefreshState(marca('macri'), cincoDias);
    db.setRefreshState(marca('gcba'), hace(4 * HOUR_MS));
    let restore = stubInstagram({
      macri: (options) => {
        options.onRunStarted({ id: 'run-espera' });
        throw Object.assign(new Error('Apify: se superó la espera'), { code: 'TIMEOUT', runPending: true, apifyRunId: 'run-espera' });
      },
      gcba: [],
    });
    let lanzada;
    try {
      const { runId } = await ciclo();
      assert.equal(db.getRefreshState(marca('macri')), cincoDias, 'esperando: no avanza');
      lanzada = db.listRunSources({ runId, plataforma: 'instagram' }).find((f) => f.fuente === 'macri');
      assert.equal(lanzada.estado, 'esperando');
      // Como si esa corrida se hubiera lanzado hace dos días.
      db.updateRunSource(lanzada.id, { finishedAt: hace(2 * DAY_MS) });
    } finally {
      restore();
    }
    const raw = new (require('node:sqlite').DatabaseSync)(process.env.MONITORING_DB_PATH);
    const dosDias = casi(2);
    raw.prepare('UPDATE monitoring_run_sources SET started_at = ? WHERE id = ?').run(dosDias, lanzada.id);
    raw.close();

    restore = stubInstagram({ macri: [], gcba: [] }, { recoverSearchRun: async () => ({ estado: 'ok', posts: [], rawItems: 0, runStatus: 'SUCCEEDED' }) });
    try {
      const antes = Date.now();
      await ciclo();
      assert.equal(pedido('macri').sinceIso, dosDias, 'lo anterior ya lo cubrió la corrida levantada');
      assert.equal(pedido('macri').lookback, '2 days');
      assert.ok(cerca(db.getRefreshState(marca('macri')), antes), 'y como este ciclo respondió, la marca queda al día');
      assert.equal(db.getRunSource(lanzada.id).estado, 'recuperada');
    } finally {
      restore();
    }
  });

  test('una corrida cortada por Apify (parcial): la primera vez la marca no avanza; la segunda seguida sí, y queda registrado', async () => {
    alDia();
    const dosDias = hace(2 * DAY_MS);
    db.setRefreshState(marca('macri'), dosDias);
    db.setRefreshState(marca('gcba'), hace(4 * HOUR_MS));
    const restore = stubInstagram({
      macri: (options) => {
        options.onMeta({ rawItems: 0, maxItems: 200, until: '2026-11-14', parcial: true, runStatus: 'TIMED-OUT' });
        return [];
      },
      gcba: [],
    });
    try {
      let { runId } = await ciclo();
      assert.equal(db.getRefreshState(marca('macri')), dosDias, 'primera parcial: se vuelve a pedir todo');
      assert.equal(db.listRunSources({ runId, plataforma: 'instagram' }).find((f) => f.fuente === 'macri').estado, 'parcial');
      const antes = Date.now();
      ({ runId } = await ciclo());
      assert.ok(cerca(db.getRefreshState(marca('macri')), antes), 'segunda seguida: avanza, para que la ventana no crezca sin fin');
      const fila = db.listRunSources({ runId, plataforma: 'instagram' }).find((f) => f.fuente === 'macri');
      assert.equal(fila.estado, 'parcial', 'la pérdida queda registrada en su fila');
    } finally {
      restore();
    }
  });

  test('si el techo recorta la ventana, la fila registra el hueco y la corrida queda incompleta', async () => {
    alDia();
    const vieja = hace(45 * DAY_MS);
    db.setRefreshState(marca('macri'), vieja);
    db.setRefreshState(marca('gcba'), hace(4 * HOUR_MS));
    const restore = stubInstagram({ macri: [], gcba: [] });
    try {
      const { runId } = await ciclo();
      assert.equal(pedido('macri').lookback, '30 days');
      assert.equal(pedido('macri').resultsLimit, 1000, 'el tope sube con la ventana, hasta 10 veces');
      const filas = db.listRunSources({ runId, plataforma: 'instagram' });
      assert.equal(filas.find((f) => f.fuente === 'macri').huecoDesde, vieja);
      assert.equal(rs.estadoCorrida(db.getMonitoringRun(runId), filas), 'incompleta');
    } finally {
      restore();
    }
  });
});

describe('migración desde la marca de la red', { concurrency: false }, () => {
  test('la primera vez cada búsqueda arranca en la marca de la red: la primera corrida no pide más atrás que la que habría corrido el código anterior', async () => {
    // El piloto al día (la marca de la red es de hace 4 h) con búsquedas que
    // no respondían hace diez días: NO se dispara una búsqueda de diez días.
    db.setRefreshState(RED, hace(4 * HOUR_MS));
    const restore = stubInstagram({ macri: [], gcba: [] });
    try {
      await ciclo();
      assert.deepEqual(pedidos.map((p) => [p.term, p.lookback, p.resultsLimit]).sort(), [['gcba', '1 day', 100], ['macri', '1 day', 100]]);
      assert.equal(db.getRefreshState(FLAG), db.getRefreshState(RED));
    } finally {
      restore();
    }
  });

  test('si el piloto estuvo apagado, la marca de la red es vieja y todas piden desde ahí (lo mismo que el código anterior)', async () => {
    const tresDias = casi(3);
    db.setRefreshState(RED, tresDias);
    const restore = stubInstagram({ macri: [], gcba: [] });
    try {
      await ciclo();
      assert.deepEqual(pedidos.map((p) => [p.lookback, p.sinceIso]), [['3 days', tresDias], ['3 days', tresDias]]);
    } finally {
      restore();
    }
  });

  test('sin marca de la red (base nueva): cada búsqueda es una fuente nueva, y la migración no se repite', async () => {
    const restore = stubInstagram({ macri: [], gcba: [] });
    try {
      await ciclo();
      assert.deepEqual(pedidos.map((p) => p.lookback), ['1 day', '1 day']);
      assert.ok(db.getRefreshState(FLAG) !== null);
    } finally {
      restore();
    }
  });

  test('si corrió código anterior en el medio (la marca de la red cambió por fuera), cada fuente queda en el máximo entre su marca y la de la red', async () => {
    alDia(hace(6 * DAY_MS));
    const cincoDias = hace(5 * DAY_MS);
    db.setRefreshState(marca('macri'), cincoDias); // falló con el código nuevo
    db.setRefreshState(marca('gcba'), hace(1 * HOUR_MS)); // más nueva que la red
    // Se volvió a main: el código anterior corrió y avanzó la marca de la red.
    const porFuera = hace(2 * DAY_MS);
    db.setRefreshState(RED, porFuera);
    const restore = stubInstagram({ macri: [], gcba: [] });
    try {
      await ciclo();
      assert.equal(pedido('macri').sinceIso, porFuera, 'no vuelve a pedir lo que el código anterior ya dio por detectado');
      assert.equal(pedido('gcba').lookback, '1 day', 'una marca más nueva que la de la red no retrocede');
    } finally {
      restore();
    }
  });

  test('marcas huérfanas: sacar una búsqueda borra su marca; darla de alta de nuevo la deja como nueva; lo que ya no está configurado se limpia en el ciclo', async () => {
    alDia();
    db.setRefreshState(marca('macri'), hace(9 * DAY_MS));
    db.setRefreshState(marca('gcba'), casi(9));
    db.setRefreshState(marca('pdlc'), hace(9 * DAY_MS));
    db.setRefreshState(marca('algo', 'keyword', 'x'), hace(9 * DAY_MS));

    monitor.removeSearch('MACRI', 'instagram');
    assert.equal(db.getRefreshState(marca('macri')), null);
    monitor.addSearch('macri', 'instagram');
    assert.equal(monitor.detectionWindowFor('instagram', { tipo: 'busqueda', fuente: 'macri' }).origen, 'primera');

    const restore = stubInstagram({ macri: [], gcba: [] });
    try {
      await ciclo();
      assert.equal(db.getRefreshState(marca('pdlc')), null, 'un término que ya no está en la config');
      assert.ok(db.getRefreshState(marca('algo', 'keyword', 'x')), 'las marcas de otra red no se tocan');
      assert.equal(pedido('gcba').lookback, '9 days');
    } finally {
      restore();
    }
  });
});

describe('X: cuentas, hashtags y keywords con su propia marca', { concurrency: false }, () => {
  test('cada fuente de X recibe su ventana; la que falla no avanza y las demás sí', async () => {
    escribirConfig({ searches: [] }, { accounts: ['jorgemacri'], keywords: ['#caba', 'macri'] });
    db.setRefreshState('detection_last_success:x', hace(4 * HOUR_MS));
    db.setRefreshState('detection_por_fuente:x', db.getRefreshState('detection_last_success:x'));
    const cuatroDias = casi(4);
    db.setRefreshState(marca('jorgemacri', 'cuenta', 'x'), cuatroDias);
    db.setRefreshState(marca('caba', 'hashtag', 'x'), hace(2 * HOUR_MS));
    const originals = { isConfigured: x.isConfigured, scrapeAccount: x.scrapeAccount, scrapeHashtag: x.scrapeHashtag, scrapeKeyword: x.scrapeKeyword };
    const vistos = {};
    x.isConfigured = () => true;
    x.scrapeAccount = async (cuenta, { lookback, resultsLimit }) => {
      vistos.cuenta = { lookback, resultsLimit };
      throw new Error('X no respondió');
    };
    x.scrapeHashtag = async (tag, { lookback }) => {
      vistos.hashtag = lookback;
      return [];
    };
    x.scrapeKeyword = async (keyword, { lookback }) => {
      vistos.keyword = lookback;
      return [];
    };
    try {
      const antes = Date.now();
      const base = monitor.monitorLimits().account;
      await ciclo({ plataformas: ['x'], trigger: 'cron' });
      assert.deepEqual(vistos.cuenta, { lookback: '4 days', resultsLimit: base * 4 });
      assert.equal(vistos.hashtag, '1 day');
      assert.equal(vistos.keyword, '1 day', 'una keyword sin marca: la ventana de una fuente nueva');
      assert.equal(db.getRefreshState(marca('jorgemacri', 'cuenta', 'x')), cuatroDias);
      assert.ok(cerca(db.getRefreshState(marca('caba', 'hashtag', 'x')), antes));
      assert.ok(cerca(db.getRefreshState(marca('macri', 'keyword', 'x')), antes));
    } finally {
      Object.assign(x, originals);
    }
  });
});

describe('db: marcas en refresh_state', { concurrency: false }, () => {
  test('advanceRefreshState solo avanza (nunca retrocede ni guarda una fecha del futuro); initRefreshState no pisa una fecha válida', () => {
    const k = 'detection_test:a';
    assert.equal(db.advanceRefreshState(k, '2026-11-10T00:00:00.000Z'), true);
    assert.equal(db.advanceRefreshState(k, '2026-11-09T00:00:00.000Z'), false);
    assert.equal(db.getRefreshState(k), '2026-11-10T00:00:00.000Z');
    assert.equal(db.advanceRefreshState(k, 'no es una fecha'), false);
    assert.equal(db.advanceRefreshState(k, '2026-11-12T00:00:00.000Z', { now: Date.parse('2026-11-11T00:00:00.000Z') }), true);
    assert.equal(db.getRefreshState(k), '2026-11-11T00:00:00.000Z', 'recortada a ahora');
    db.setRefreshState(k, '');
    assert.equal(db.advanceRefreshState(k, '2026-11-01T00:00:00.000Z'), true, 'un valor guardado que no es fecha no frena');

    const j = 'detection_test:b';
    assert.equal(db.initRefreshState(j, '2026-11-05T00:00:00.000Z'), true);
    assert.equal(db.initRefreshState(j, '2026-11-08T00:00:00.000Z'), false);
    assert.equal(db.getRefreshState(j), '2026-11-05T00:00:00.000Z');
    assert.equal(db.initRefreshState('detection_test:c', 'nada'), false);
  });

  test('listRefreshStateByPrefix compara exacto (un "%" o un "_" del término no es un comodín) y deleteRefreshState borra una clave', () => {
    db.setRefreshState('detection_test:x:100%', 'a');
    db.setRefreshState('detection_test:x:100a', 'b');
    db.setRefreshState('detection_test:x_y', 'c');
    assert.deepEqual(db.listRefreshStateByPrefix('detection_test:x:100%').map((r) => r.key), ['detection_test:x:100%']);
    assert.deepEqual(db.listRefreshStateByPrefix('detection_test:x_').map((r) => r.key), ['detection_test:x_y']);
    assert.equal(db.deleteRefreshState('detection_test:x_y'), 1);
    assert.equal(db.deleteRefreshState('detection_test:x_y'), 0);
    assert.equal(db.getRefreshState('detection_test:x_y'), null);
  });
});
