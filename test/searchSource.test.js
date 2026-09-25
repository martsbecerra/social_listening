'use strict';

// Búsqueda por palabra clave como cuarta fuente de detección (lista
// `searches` de config/monitoring.json, scrapeSearch del adapter de
// Instagram con IG_ACTOR=apidojo): altas y bajas sin Apify y solo en la
// sección de Instagram, una llamada por término en la fase 'busqueda',
// relevancia literal o semántica con el motivo "Búsqueda: <término>",
// descarte sin caption, prioridad de la cuenta trackeada sobre la búsqueda,
// refresco gratis de los posteos ya conocidos y el clasificador caído. El
// adapter va stubeado sobre la fachada; el clasificador también. Base y
// config temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-search-'));
const CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = CONFIG_PATH;
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
delete process.env.SEARCH_RESULTS_LIMIT;
delete process.env.MONITOR_LOOKBACK;
// Acá se prueba la fuente sola: el detalle de los resultados sin caption
// (enrichSearchResults) va apagado y se prueba en searchEnrichment.test.js.
process.env.SEARCH_ENRICH_LIMIT = '0';

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    { instagram: { accounts: ['trackeada'], keywords: ['obras', 'jorge macri'] }, x: { accounts: [], keywords: ['Jorge Macri'] } },
    null,
    2
  ) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
// Una sola función: reproduce el criterio viejo para estos tests (con
// coincidencia literal en la pista → relevante; sin ella, decide por el
// texto) y cuenta una llamada por posteo evaluado.
const classifier = require('../src/classifier');
const classifierCalls = { llamadas: 0 };
let relevanceMode = 'normal'; // 'normal' | 'unclassified' (solo sin coincidencia literal)
classifier.clasificarPosteo = async (caption, { pista } = {}) => {
  classifierCalls.llamadas += 1;
  if (pista && pista.termino) return { relevant: true, title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' };
  if (relevanceMode === 'unclassified') return { relevant: true, title: null, sentiment: null, unclassified: true };
  return /gestión/i.test(caption) ? { relevant: true, title: 'gestión', sentiment: 'positivo' } : { relevant: false };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const { getContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const readDisk = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const savedPost = (id) => db.listDetectedPosts({ page: 1, pageSize: 100, plataforma: 'instagram' }).posts.find((p) => p.id === id);

/** Posteo ya normalizado, como lo devuelve el adapter. */
function post({ id, caption, account = 'alguien', sourceType = 'search', sourceQuery = 'jorge macri', likes = 5 }) {
  return {
    id: String(id),
    account,
    url: `https://www.instagram.com/p/${id}/`,
    caption,
    hashtagsText: '',
    likes,
    comments: 1,
    postedAt: new Date().toISOString(),
    postType: 'imagen',
    followers: null,
    sourceType,
    sourceQuery,
  };
}

describe('búsqueda por palabra clave (fuente search)', { concurrency: false }, () => {
  test('addSearch / removeSearch: sin llamar a Apify, sin duplicados, solo en la sección de Instagram; loadConfig siempre devuelve searches', () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('agregar una búsqueda no debe llamar a Apify');
    };
    try {
      assert.deepEqual(monitor.loadConfig('instagram').searches, []);
      assert.equal('searches' in readDisk().instagram, false, 'no existe en el archivo hasta el primer alta');

      const config = monitor.addSearch('  jorge macri ', 'instagram');
      assert.deepEqual(config.searches, ['jorge macri']);
      assert.deepEqual(config.accounts, ['trackeada']);
      assert.deepEqual(readDisk().instagram.searches, ['jorge macri']);
      assert.deepEqual(readDisk().x, { accounts: [], keywords: ['Jorge Macri'] }, 'la sección de X no se toca');

      assert.deepEqual(monitor.addSearch('Jorge Macri', 'instagram').searches, ['jorge macri'], 'dedupe sin distinguir mayúsculas');
      assert.throws(() => monitor.addSearch('   ', 'instagram'), (err) => {
        assert.match(err.userMessage, /término de búsqueda/);
        return true;
      });
      assert.throws(() => monitor.addSearch('jorge macri', 'x'), (err) => {
        assert.match(err.userMessage, /no tiene búsqueda por palabra clave aparte/);
        return true;
      });

      assert.deepEqual(monitor.addSearch('larreta', 'instagram').searches, ['jorge macri', 'larreta']);
      assert.deepEqual(monitor.removeSearch('LARRETA', 'instagram').searches, ['jorge macri']);
      assert.deepEqual(monitor.removeSearch('nada', 'x').searches, [], 'quitar en una sección sin lista no rompe ni escribe');
      assert.deepEqual(readDisk().x, { accounts: [], keywords: ['Jorge Macri'] });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('el ciclo consulta cada término con el tope de búsqueda dentro de la fase busqueda; relevancia literal o semántica, sin caption o no relevante se descarta', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, scrapeHashtag: instagram.scrapeHashtag, scrapeSearch: instagram.scrapeSearch, isConfigured: instagram.isConfigured };
    const searchCalls = [];
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async () => [];
    instagram.scrapeHashtag = async (tag) => {
      throw new Error(`scrapeHashtag(${tag}) no debería llamarse: no hay hashtags configurados`);
    };
    instagram.scrapeSearch = async (term, options) => {
      searchCalls.push({ term, ...options, phase: (getContext() || {}).phase });
      return [
        post({ id: 's1', caption: 'Jorge Macri inauguró el túnel' }), // literal
        post({ id: 's2', caption: 'La gestión porteña avanza con las veredas' }), // semántica (sin keyword literal)
        post({ id: 's3', caption: '' }), // sin texto: se descarta
        post({ id: 's4', caption: 'receta de pan casero' }), // no relevante
      ];
    };
    try {
      const before = { ...classifierCalls };
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.deepEqual(searchCalls, [{ term: 'jorge macri', resultsLimit: 100, lookback: '1 day', phase: 'busqueda' }]);
      assert.equal(result.checked, 4);
      assert.equal(result.porPlataforma.instagram.newCount, 2);

      const s1 = savedPost('s1');
      assert.equal(s1.matched_reason, 'Búsqueda: jorge macri (coincidencia: "jorge macri")');
      assert.match(s1.title, /^titulo:/);
      assert.equal(s1.account, 'alguien');
      assert.equal(s1.followers, null);
      const s2 = savedPost('s2');
      assert.equal(s2.matched_reason, 'Búsqueda: jorge macri (relacionado por contenido)');
      assert.equal(s2.title, 'gestión');
      assert.equal(savedPost('s3'), undefined, 'sin caption no entra');
      assert.equal(savedPost('s4'), undefined, 'el clasificador dijo que no');
      assert.equal(classifierCalls.llamadas - before.llamadas, 3, 'una llamada por posteo con texto (el sin caption no se clasifica)');
    } finally {
      Object.assign(instagram, originals);
    }
  });

  test('un posteo ya conocido que vuelve por búsqueda no se reclasifica: solo refresca las métricas', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, scrapeSearch: instagram.scrapeSearch, isConfigured: instagram.isConfigured };
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async () => [];
    instagram.scrapeSearch = async () => [post({ id: 's1', caption: 'Jorge Macri inauguró el túnel', likes: 99 })];
    try {
      const before = { ...classifierCalls };
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(result.porPlataforma.instagram.newCount, 0);
      assert.equal(savedPost('s1').likes, 99);
      assert.deepEqual(classifierCalls, before, 'nada que clasificar');

      // Así llega de verdad un resultado de búsqueda: contadores en null. No
      // puede pisar con NULL las métricas ya guardadas.
      instagram.scrapeSearch = async () => [{ ...post({ id: 's1', caption: '' }), likes: null, comments: null }];
      const updatedAtBefore = savedPost('s1').metrics_updated_at;
      await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(savedPost('s1').likes, 99, 'los likes guardados se conservan');
      assert.equal(savedPost('s1').comments, 1);
      assert.equal(savedPost('s1').metrics_updated_at, updatedAtBefore, 'sin métricas no cuenta como refresco');
    } finally {
      Object.assign(instagram, originals);
    }
  });

  test('las cuentas trackeadas de Instagram no se consultan en la detección: son guía para el clasificador', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, scrapeSearch: instagram.scrapeSearch, isConfigured: instagram.isConfigured };
    instagram.isConfigured = () => true;
    let accountCalls = 0;
    instagram.scrapeAccount = async (account) => {
      accountCalls += 1;
      return [post({ id: 'dup1', caption: 'obras en marcha', account, sourceType: 'account', sourceQuery: null })];
    };
    instagram.scrapeSearch = async () => [post({ id: 'dup1', caption: 'obras en marcha', account: 'trackeada' })];
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(accountCalls, 0, 'scrapeAccount no se llama aunque haya cuentas configuradas');
      assert.equal(result.checked, 1);
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      assert.deepEqual(result.scrapedAccounts, { instagram: [] });
      assert.equal(savedPost('dup1').matched_reason, 'Búsqueda: jorge macri (coincidencia: "obras")');
      assert.equal(savedPost('dup1').account, 'trackeada');
      assert.ok(logs.some((l) => /1 cuenta\(s\) trackeada\(s\) y 0 hashtag\(s\) configurados son solo guía/.test(l)), logs.join('\n'));
    } finally {
      console.log = originalLog;
      Object.assign(instagram, originals);
    }
  });

  test('clasificador caído con un resultado de búsqueda sin coincidencia literal: se guarda marcado, sin título', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, scrapeSearch: instagram.scrapeSearch, isConfigured: instagram.isConfigured };
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async () => [];
    instagram.scrapeSearch = async () => [post({ id: 's5', caption: 'texto que no menciona nada literal' })];
    relevanceMode = 'unclassified';
    try {
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      const s5 = savedPost('s5');
      assert.equal(s5.matched_reason, 'Búsqueda: jorge macri — sin clasificar (falló el clasificador, relevancia sin verificar)');
      assert.equal(s5.title, null);
      assert.equal(s5.sentiment, null);
    } finally {
      relevanceMode = 'normal';
      Object.assign(instagram, originals);
    }
  });

  test('una búsqueda que falla sola no tira abajo el ciclo; sin términos no se busca', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, scrapeSearch: instagram.scrapeSearch, isConfigured: instagram.isConfigured };
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async () => {
      throw new Error('la detección de Instagram no consulta cuentas trackeadas');
    };
    monitor.addSearch('obras', 'instagram'); // segunda búsqueda: la que sí responde
    let searchCalls = 0;
    instagram.scrapeSearch = async (term) => {
      searchCalls += 1;
      if (term === 'obras') return [post({ id: 'a9', caption: 'obras del subte', sourceQuery: 'obras' })];
      throw new Error('Instagram no respondió la búsqueda');
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(searchCalls, 2);
      assert.equal(result.porPlataforma.instagram.newCount, 1, 'lo de la otra búsqueda entró igual');
      assert.equal(result.porPlataforma.instagram.error, undefined, 'un fallo puntual de una fuente no es error de plataforma');

      monitor.removeSearch('jorge macri', 'instagram');
      monitor.removeSearch('obras', 'instagram');
      assert.deepEqual(readDisk().instagram.searches, []);
      await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(searchCalls, 2, 'sin términos, ninguna búsqueda');
    } finally {
      console.error = originalError;
      Object.assign(instagram, originals);
    }
  });
});
