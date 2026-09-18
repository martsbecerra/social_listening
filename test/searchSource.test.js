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

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    { instagram: { accounts: ['trackeada'], keywords: ['obras', 'jorge macri'] }, x: { accounts: [], keywords: ['Jorge Macri'] } },
    null,
    2
  ) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
const classifierCalls = { post: 0, relevance: 0 };
let relevanceMode = 'normal'; // 'normal' | 'unclassified'
classifier.classifyPost = async (caption) => {
  classifierCalls.post += 1;
  return { title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' };
};
classifier.classifyRelevance = async (caption) => {
  classifierCalls.relevance += 1;
  if (relevanceMode === 'unclassified') return { relevant: true, unclassified: true };
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
      assert.deepEqual(searchCalls, [{ term: 'jorge macri', resultsLimit: 50, lookback: '1 day', phase: 'busqueda' }]);
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
      assert.equal(classifierCalls.post - before.post, 1, 'clasificación directa solo para la coincidencia literal');
      assert.equal(classifierCalls.relevance - before.relevance, 2, 'semántica para los dos sin coincidencia literal');
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
    } finally {
      Object.assign(instagram, originals);
    }
  });

  test('el mismo posteo por cuenta trackeada y por búsqueda en el mismo ciclo queda como cuenta trackeada', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, scrapeSearch: instagram.scrapeSearch, isConfigured: instagram.isConfigured };
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async (account) => [post({ id: 'dup1', caption: 'obras en marcha', account, sourceType: 'account', sourceQuery: null })];
    instagram.scrapeSearch = async () => [post({ id: 'dup1', caption: 'obras en marcha', account: 'trackeada' })];
    try {
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(result.checked, 1, 'un solo candidato después del dedupe');
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      assert.equal(savedPost('dup1').matched_reason, 'Cuenta trackeada: @trackeada (coincidencia: "obras")');
      assert.equal(savedPost('dup1').account, 'trackeada');
    } finally {
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
    instagram.scrapeAccount = async (account) => [post({ id: 'a9', caption: 'obras del subte', account, sourceType: 'account', sourceQuery: null })];
    let searchCalls = 0;
    instagram.scrapeSearch = async () => {
      searchCalls += 1;
      throw new Error('Instagram no respondió la búsqueda');
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(searchCalls, 1);
      assert.equal(result.porPlataforma.instagram.newCount, 1, 'lo de la cuenta entró igual');
      assert.equal(result.porPlataforma.instagram.error, undefined, 'un fallo puntual de una fuente no es error de plataforma');

      monitor.removeSearch('jorge macri', 'instagram');
      assert.deepEqual(readDisk().instagram.searches, []);
      await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(searchCalls, 1, 'sin términos, ninguna búsqueda');
    } finally {
      console.error = originalError;
      Object.assign(instagram, originals);
    }
  });
});
