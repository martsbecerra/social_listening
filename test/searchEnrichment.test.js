'use strict';

// Detalle de los resultados de búsqueda que llegan sin caption
// (enrichSearchResults en src/monitor.js): la búsqueda por palabra clave de
// apidojo devuelve objetos recortados, así que a los resultados NUEVOS se les
// pide el detalle al actor oficial (fetchPostDetails: un run por ciclo con
// todas las URLs, fase 'busqueda'), con tope por ciclo (SEARCH_ENRICH_LIMIT)
// y una tabla de vistos (search_seen) para no pagar dos veces por lo mismo.
// Fixtures REALES: test/fixtures/apidojo/search.json (lo que devuelve la
// búsqueda), test/fixtures/apify/post-detail.json (el detalle del mismo
// reel por el actor oficial) y post-details-2urls.json (un run con las dos
// URLs). Base y config temporales; nada llama a Apify.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
process.env.APIFY_PLAN = 'starter';
delete process.env.APIFY_RATE_STARTER;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-enrich-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
const CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = CONFIG_PATH;
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
delete process.env.SEARCH_ENRICH_LIMIT;
delete process.env.SEARCH_RESULTS_LIMIT;
delete process.env.MONITOR_LOOKBACK;

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: ['jorge macri'], searches: ['jorge macri'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
// Una sola función: coincidencia literal en la pista → relevante; sin ella,
// decide por el texto. Una llamada por posteo evaluado.
const classifierCalls = { llamadas: 0 };
classifier.clasificarPosteo = async (caption, { pista } = {}) => {
  classifierCalls.llamadas += 1;
  if (pista && pista.termino) return { relevant: true, title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' };
  return /gestión/i.test(caption) ? { relevant: true, title: 'gestión', sentiment: 'positivo' } : { relevant: false };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const { runWithContext, getContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const apidojo = require('../src/platforms/instagramApidojo');
const apifyProvider = require('../src/platforms/instagramApify');
const instagram = getPlatform('instagram');

const SEARCH_FIXTURE = require('./fixtures/apidojo/search.json');
const DETAIL_FIXTURE = require('./fixtures/apify/post-detail.json');
const DETAILS_2URLS_FIXTURE = require('./fixtures/apify/post-details-2urls.json');
const REEL_ID = '3988633620029857812';
const REEL_URL = 'https://www.instagram.com/p/DdaeSUND2AU/';
const OTHER_ID = '3987834510674106895';
const OTHER_URL = 'https://www.instagram.com/p/DdXolvnxhoP/';

const raw = new DatabaseSync(DB_PATH, { readOnly: true });
const lastCall = () => raw.prepare('SELECT * FROM apify_calls ORDER BY id').all().at(-1);
const countCalls = () => raw.prepare('SELECT COUNT(*) AS n FROM apify_calls').get().n;
const savedPost = (id) => db.listDetectedPosts({ page: 1, pageSize: 100, plataforma: 'instagram' }).posts.find((p) => p.id === id);
const respond = (status, text = '', body = []) => ({ ok: status < 400, status, text: async () => text, json: async () => body });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ≈ ${b}`);

/** Los dos resultados reales de la búsqueda "jorge macri", normalizados como los entrega el adapter (sin caption ni contadores). */
function fixtureSearchPosts() {
  return SEARCH_FIXTURE.map((item) => apidojo.normalizePost(item, { sourceType: 'search', sourceQuery: 'jorge macri' }));
}

/** Resultado de búsqueda recortado, ya normalizado. */
function bare({ id, minutesAgo = 0, caption = '', sourceQuery = 'jorge macri' }) {
  return {
    id: String(id),
    account: 'alguien',
    url: `https://www.instagram.com/p/${id}/`,
    caption,
    hashtagsText: '',
    likes: null,
    comments: null,
    postedAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    postType: 'reel',
    followers: null,
    sourceType: 'search',
    sourceQuery,
  };
}

/** Detalle normalizado, como lo devuelve fetchPostDetails. */
function detail({ id, caption, likes = 10, comments = 3 }) {
  return {
    id: String(id),
    account: 'alguien',
    url: `https://www.instagram.com/p/${id}/`,
    caption,
    hashtagsText: '',
    likes,
    comments,
    postedAt: new Date().toISOString(),
    postType: 'reel',
    followers: null,
    sourceType: 'search',
    sourceQuery: null,
  };
}

function stubInstagram(overrides) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeAccount', 'scrapeHashtag', 'scrapeSearch', 'fetchPostDetails']) originals[key] = instagram[key];
  instagram.isConfigured = () => true;
  instagram.scrapeAccount = async () => [];
  instagram.scrapeHashtag = async () => [];
  Object.assign(instagram, overrides);
  return () => Object.assign(instagram, originals);
}

const cycle = () => monitor.runMonitoringCycle({ plataformas: ['instagram'] });

describe('detalle de los resultados de búsqueda sin caption', { concurrency: false }, () => {
  test('fixtures reales: un run del actor oficial con las URLs nuevas (fase busqueda), el posteo entra con el texto y los contadores del detalle, y lo que no vuelve queda anotado', async () => {
    const restore = stubInstagram({ scrapeSearch: async () => fixtureSearchPosts() });
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return respond(200, '', DETAIL_FIXTURE);
    };
    try {
      assert.equal(fixtureSearchPosts().every((p) => p.caption === '' && p.likes === null && p.comments === null), true, 'así llega la búsqueda');

      const result = await runWithContext({ runId: 7, phase: 'monitoreo' }, cycle);

      assert.equal(requests.length, 1, 'un solo run para todas las URLs');
      assert.match(requests[0].url, /\/acts\/apify~instagram-scraper\/run-sync-get-dataset-items\?token=token-de-test$/);
      assert.deepEqual(requests[0].body, { directUrls: [REEL_URL, OTHER_URL], resultsType: 'posts', resultsLimit: 1 }, 'los más nuevos primero');

      assert.equal(result.checked, 2);
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      assert.deepEqual(result.porPlataforma.instagram.searchEnrichment, {
        candidates: 2, alreadySeen: 0, requested: 2, enriched: 1, noCaption: 0, noDetail: 1, deferred: 0, failed: false,
      });

      const saved = savedPost(REEL_ID);
      assert.equal(saved.matched_reason, 'Búsqueda: jorge macri (coincidencia: "jorge macri")');
      assert.equal(saved.caption, 'Jorge Macri impulsa darle un FIN AL KIRCHNERISMO #jorgemacri2027 #buenosaires #caba');
      assert.equal(saved.url, REEL_URL);
      assert.equal(saved.account, 'jorge2027macri');
      assert.equal(saved.likes, 2);
      assert.equal(saved.comments, 0);
      assert.equal(saved.post_type, 'reel');
      assert.equal(saved.followers, null);
      assert.equal(saved.posted_at, '2026-09-18T03:30:29.000Z');
      assert.equal(savedPost(OTHER_ID), undefined, 'sin detalle no hay texto que evaluar');

      assert.equal(db.getSearchSeen(REEL_ID, 'instagram').outcome, 'guardado');
      const other = db.getSearchSeen(OTHER_ID, 'instagram');
      assert.equal(other.outcome, 'sin_detalle');
      assert.equal(other.url, OTHER_URL);
      assert.equal(other.term, 'jorge macri');

      // La llamada queda en el registro de gasto como una consulta de posteo
      // del actor oficial, en la fase busqueda del mismo ciclo.
      const row = lastCall();
      assert.equal(row.run_id, 7);
      assert.equal(row.phase, 'busqueda');
      assert.equal(row.actor, 'apify~instagram-scraper');
      assert.equal(row.query_type, 'post');
      assert.equal(row.items, 1);
      assert.equal(row.ok, 1);
      near(row.usd, 0.0023);
    } finally {
      global.fetch = originalFetch;
      restore();
    }
  });

  test('el ciclo siguiente no vuelve a pagar: el guardado ya está en detected_posts y el otro en search_seen', async () => {
    const restore = stubInstagram({ scrapeSearch: async () => fixtureSearchPosts() });
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('no debería pedirse ningún detalle');
    };
    try {
      const callsBefore = countCalls();
      const before = { ...classifierCalls };
      const result = await cycle();
      assert.equal(result.porPlataforma.instagram.newCount, 0);
      assert.deepEqual(result.porPlataforma.instagram.searchEnrichment, {
        candidates: 0, alreadySeen: 1, requested: 0, enriched: 0, noCaption: 0, noDetail: 0, deferred: 0, failed: false,
      });
      assert.equal(countCalls(), callsBefore, 'ninguna llamada a Apify');
      assert.deepEqual(classifierCalls, before, 'nada que clasificar');
      assert.equal(savedPost(REEL_ID).likes, 2, 'la búsqueda sin contadores no pisa las métricas guardadas');
    } finally {
      global.fetch = originalFetch;
      restore();
    }
  });

  test('tope por ciclo: van los más nuevos, el resto queda para el próximo ciclo; lo descartado no se vuelve a consultar ni a evaluar; sin caption en el detalle se descarta', async () => {
    const detailCalls = [];
    const results = [bare({ id: 'viejo', minutesAgo: 300 }), bare({ id: 'nuevo', minutesAgo: 5 }), bare({ id: 'medio', minutesAgo: 60 })];
    const details = {
      nuevo: detail({ id: 'nuevo', caption: 'Jorge Macri recorrió el barrio' }),
      medio: detail({ id: 'medio', caption: 'receta de pan casero' }),
      viejo: detail({ id: 'viejo', caption: '' }),
    };
    const restore = stubInstagram({
      scrapeSearch: async () => results.map((p) => ({ ...p })),
      fetchPostDetails: async (urls) => {
        detailCalls.push({ urls, phase: (getContext() || {}).phase });
        // El actor no devuelve los items en el orden de las URLs (visto en la
        // corrida real): el cruce es por id, no por posición.
        return urls.map((url) => details[url.split('/p/')[1].replace('/', '')]).reverse();
      },
    });
    process.env.SEARCH_ENRICH_LIMIT = '2';
    try {
      assert.equal(monitor.searchEnrichLimit(), 2);
      let before = { ...classifierCalls };
      let result = await cycle();
      assert.deepEqual(detailCalls, [
        { urls: ['https://www.instagram.com/p/nuevo/', 'https://www.instagram.com/p/medio/'], phase: 'busqueda' },
      ]);
      assert.deepEqual(result.porPlataforma.instagram.searchEnrichment, {
        candidates: 3, alreadySeen: 0, requested: 2, enriched: 2, noCaption: 0, noDetail: 0, deferred: 1, failed: false,
      });
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      assert.equal(savedPost('nuevo').matched_reason, 'Búsqueda: jorge macri (coincidencia: "jorge macri")');
      assert.equal(savedPost('nuevo').likes, 10);
      assert.equal(savedPost('medio'), undefined, 'el clasificador dijo que no');
      assert.equal(db.getSearchSeen('nuevo', 'instagram').outcome, 'guardado');
      assert.equal(db.getSearchSeen('medio', 'instagram').outcome, 'descartado');
      assert.equal(db.getSearchSeen('viejo', 'instagram'), null, 'lo que no entró en el tope no se anota');
      assert.equal(classifierCalls.llamadas - before.llamadas, 2, 'una llamada por posteo evaluado (el diferido, sin texto, no)');

      // Próximo ciclo: solo el que había quedado afuera; su detalle tampoco
      // trae texto, así que se descarta y queda anotado.
      before = { ...classifierCalls };
      result = await cycle();
      assert.equal(detailCalls.length, 2);
      assert.deepEqual(detailCalls[1].urls, ['https://www.instagram.com/p/viejo/']);
      assert.deepEqual(result.porPlataforma.instagram.searchEnrichment, {
        candidates: 1, alreadySeen: 1, requested: 1, enriched: 0, noCaption: 1, noDetail: 0, deferred: 0, failed: false,
      });
      assert.equal(savedPost('viejo'), undefined);
      assert.equal(db.getSearchSeen('viejo', 'instagram').outcome, 'sin_caption');
      assert.deepEqual(classifierCalls, before, 'el descartado no se re-evalúa y el sin caption no se clasifica');

      // Tercer ciclo: todo visto o guardado, ningún detalle.
      result = await cycle();
      assert.equal(detailCalls.length, 2);
      assert.equal(result.porPlataforma.instagram.searchEnrichment.alreadySeen, 2);
    } finally {
      delete process.env.SEARCH_ENRICH_LIMIT;
      restore();
    }
  });

  test('si el run de detalle falla no se anota nada y se reintenta en el próximo ciclo; un error de plataforma llega al usuario', async () => {
    let mode = 'falla';
    let detailCalls = 0;
    const restore = stubInstagram({
      scrapeSearch: async () => [bare({ id: 'reintento' })],
      fetchPostDetails: async () => {
        detailCalls += 1;
        if (mode === 'falla') throw new Error('Apify respondió 500');
        if (mode === 'cuota') {
          const e = new Error('Monthly usage hard limit exceeded');
          e.code = 'QUOTA_EXCEEDED';
          e.userMessage = 'Se agotó la cuota de Apify.';
          throw e;
        }
        return [detail({ id: 'reintento', caption: 'Jorge Macri anunció obras' })];
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      let result = await cycle();
      assert.equal(detailCalls, 1);
      assert.equal(result.porPlataforma.instagram.newCount, 0);
      assert.equal(result.porPlataforma.instagram.error, undefined, 'un fallo puntual no es error de plataforma');
      assert.equal(result.porPlataforma.instagram.searchEnrichment.failed, true);
      assert.equal(db.getSearchSeen('reintento', 'instagram'), null);

      mode = 'cuota';
      await assert.rejects(cycle(), (err) => {
        assert.equal(err.code, 'QUOTA_EXCEEDED');
        assert.match(err.userMessage, /cuota de Apify/);
        return true;
      });
      assert.equal(db.getSearchSeen('reintento', 'instagram'), null);

      mode = 'ok';
      result = await cycle();
      assert.equal(detailCalls, 3);
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      assert.equal(db.getSearchSeen('reintento', 'instagram').outcome, 'guardado');
    } finally {
      console.error = originalError;
      restore();
    }
  });

  test('SEARCH_ENRICH_LIMIT=0 apaga el detalle; con caption no se pide nada; las cuentas trackeadas no se consultan', async () => {
    let detailCalls = 0;
    const restore = stubInstagram({
      scrapeSearch: async () => [bare({ id: 'apagado' })],
      fetchPostDetails: async () => {
        detailCalls += 1;
        return [];
      },
    });
    try {
      process.env.SEARCH_ENRICH_LIMIT = '0';
      assert.equal(monitor.searchEnrichLimit(), 0);
      let result = await cycle();
      assert.equal(detailCalls, 0);
      assert.equal(savedPost('apagado'), undefined);
      assert.equal(db.getSearchSeen('apagado', 'instagram'), null, 'apagado no anota: al prenderlo se consulta');
      assert.equal(result.porPlataforma.instagram.searchEnrichment.requested, 0);

      delete process.env.SEARCH_ENRICH_LIMIT;
      assert.equal(monitor.searchEnrichLimit(), 20, 'default');
      process.env.SEARCH_ENRICH_LIMIT = 'muchos';
      assert.equal(monitor.searchEnrichLimit(), 20, 'un valor inválido vale el default');
      delete process.env.SEARCH_ENRICH_LIMIT;

      // Un resultado que ya trae texto: ningún detalle. Las cuentas
      // trackeadas del config no se consultan en la detección (son guía):
      // aunque el stub tenga algo para dar, nadie se lo pide.
      instagram.scrapeSearch = async () => [bare({ id: 'contexto', caption: 'Jorge Macri habló de seguridad' })];
      instagram.scrapeAccount = async () => {
        throw new Error('la detección de Instagram no consulta cuentas trackeadas');
      };
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ instagram: { accounts: ['trackeada'], keywords: ['jorge macri'], searches: ['jorge macri'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
      );
      result = await cycle();
      assert.equal(detailCalls, 0);
      assert.equal(result.porPlataforma.instagram.searchEnrichment, undefined, 'no había resultados de búsqueda sin texto');
      assert.equal(savedPost('contexto').matched_reason, 'Búsqueda: jorge macri (coincidencia: "jorge macri")');
      assert.equal(savedPost('trackeado'), undefined, 'nada llegó por la cuenta trackeada');
    } finally {
      delete process.env.SEARCH_ENRICH_LIMIT;
      restore();
    }
  });

  test('search_seen: el alta conserva la fecha del primer detalle y el ciclo purga lo de más de 30 días', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - 31 * DAY_MS).toISOString();
    const recent = new Date(Date.now() - 29 * DAY_MS).toISOString();
    db.markSearchSeen({ postId: 'purga-vieja', plataforma: 'instagram', url: 'https://www.instagram.com/p/purga-vieja/', term: 'jorge macri', outcome: 'descartado', firstSeenAt: old });
    db.markSearchSeen({ postId: 'purga-reciente', plataforma: 'instagram', outcome: 'sin_detalle', firstSeenAt: recent });
    db.markSearchSeen({ postId: 'purga-reciente', plataforma: 'instagram', outcome: 'descartado' });
    assert.deepEqual(db.getSearchSeen('purga-reciente', 'instagram'), {
      postId: 'purga-reciente', plataforma: 'instagram', url: null, term: null, outcome: 'descartado', firstSeenAt: recent,
    });
    assert.equal(db.isSearchSeen('purga-vieja', 'instagram'), true);
    assert.equal(db.isSearchSeen('purga-vieja', 'x'), false, 'por plataforma');

    const restore = stubInstagram({ scrapeSearch: async () => [] });
    try {
      await cycle();
      assert.equal(db.isSearchSeen('purga-vieja', 'instagram'), false);
      assert.equal(db.isSearchSeen('purga-reciente', 'instagram'), true);
    } finally {
      restore();
    }
  });

  test('fetchPostDetails (actor oficial): URLs sin repetir en un solo run, items de error afuera, lista vacía sin llamar; la fachada lo expone con cualquier IG_ACTOR', async () => {
    const originalFetch = global.fetch;
    const bodies = [];
    global.fetch = async (url, options = {}) => {
      bodies.push(JSON.parse(options.body));
      return respond(200, '', [{ error: 'not_found', errorDescription: 'Post does not exist', url: OTHER_URL }, ...DETAIL_FIXTURE]);
    };
    try {
      assert.equal(instagram.provider, 'apidojo');
      assert.equal(typeof instagram.fetchPostDetails, 'function');
      assert.deepEqual(await instagram.fetchPostDetails([]), []);
      assert.deepEqual(await apifyProvider.fetchPostDetails(null), []);
      assert.equal(bodies.length, 0, 'sin URLs no se llama a Apify');

      const posts = await instagram.fetchPostDetails([REEL_URL, OTHER_URL, ` ${REEL_URL} `, '']);
      assert.deepEqual(bodies, [{ directUrls: [REEL_URL, OTHER_URL], resultsType: 'posts', resultsLimit: 1 }]);
      assert.equal(posts.length, 1, 'el item de error se descarta');
      assert.equal(posts[0].id, REEL_ID);
      assert.equal(posts[0].url, REEL_URL);
      assert.equal(posts[0].likes, 2);
      assert.equal(posts[0].comments, 0);
      assert.equal(posts[0].postType, 'reel');
      assert.equal(posts[0].hashtagsText, 'jorgemacri2027 buenosaires caba');
      assert.equal(posts[0].sourceType, 'search');

      // El item de error se cobra igual: dos resultados.
      const row = lastCall();
      assert.equal(row.actor, 'apify~instagram-scraper');
      assert.equal(row.query_type, 'post');
      assert.equal(row.items, 2);
      near(row.usd, 0.0046);

      // Corrida real con las dos URLs de la búsqueda: un item POR URL con
      // resultsLimit 1, en otro orden que el pedido, con los mismos ids que
      // devuelve la búsqueda de apidojo.
      global.fetch = async () => respond(200, '', DETAILS_2URLS_FIXTURE);
      const both = await instagram.fetchPostDetails([REEL_URL, OTHER_URL]);
      assert.deepEqual(both.map((p) => p.id), [OTHER_ID, REEL_ID]);
      assert.deepEqual(both.map((p) => p.id).sort(), fixtureSearchPosts().map((p) => p.id).sort());
      assert.deepEqual(both.map((p) => p.url), [OTHER_URL, REEL_URL]);
      assert.equal(both.every((p) => p.caption.trim() && p.postType === 'reel' && p.comments === 0), true);
      assert.equal(both[0].account, 'jorgemacrifans');
      assert.equal(both[0].likes, 3);
      assert.equal(both[0].hashtagsText, 'jorgemacri milei gobierno pro');

      global.fetch = async () => respond(500, 'boom');
      await assert.rejects(instagram.fetchPostDetails([REEL_URL]), /Apify respondió 500/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
