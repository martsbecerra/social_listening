'use strict';

// Proveedor apidojo/instagram-scraper-api del adapter de Instagram
// (src/platforms/instagramApidojo.js, detrás de la fachada
// src/platforms/instagram.js con IG_ACTOR=apidojo): normalización contra las
// fixtures REALES de test/fixtures/apidojo/ (ver su README), mapeo de
// post_type a los valores de account_stats, ventana de fecha (until +
// descarte del lado nuestro), forma del input de cada consulta, validación
// con maxItems 1, seguidores que vienen en los posteos (caché en cualquier
// fase, benchmark sin consulta aparte) y los topes por tipo de fuente. Sin
// red: fetch stubeado. Base y config temporales; clasificador stubeado.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_RETRY_DELAY_MS = '5';
// El transporte asincrónico con costo real se prueba en apifyCosts.test.js;
// acá el stub de fetch simula el endpoint sincrónico.
process.env.APIFY_REAL_COST = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-apidojo-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
delete process.env.MONITOR_RESULTS_LIMIT;
delete process.env.MONITOR_ACCOUNT_LIMIT;
delete process.env.MONITOR_HASHTAG_LIMIT;
delete process.env.SEARCH_RESULTS_LIMIT;

fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: ['cuenta_prueba'], keywords: ['obras'] } }, null, 2) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
// Una sola función, con el criterio de siempre para estos tests:
// coincidencia literal en la pista → relevante; sin ella, no.
classifier.clasificarPosteo = async (caption, { pista } = {}) => ({
  relevant: Boolean(pista && pista.termino),
  title: `titulo: ${String(caption).slice(0, 12)}`,
  sentiment: 'neutral',
});

const db = require('../src/db');
const monitor = require('../src/monitor');
const accountStats = require('../src/accountStats');
const { getPlatform } = require('../src/platforms');
const provider = require('../src/platforms/instagramApidojo');
const instagram = getPlatform('instagram');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'apidojo', `${name}.json`), 'utf8'));
const respond = (items) => ({ ok: true, status: 200, text: async () => '', json: async () => items });
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Stub de fetch que captura URL y body de cada llamada y responde con lo que devuelva `reply(body)`. */
function stubFetch(reply) {
  const calls = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return respond(await reply(body, calls.length));
  };
  return calls;
}

/** Item con la forma real del actor y fecha relativa a ahora. */
function rawPost({ id, hoursAgo = 1, username = 'cuenta_prueba', followerCount = 123456, caption = 'obras nuevas', ...rest }) {
  return {
    type: 'post',
    id: String(id),
    code: `C${id}`,
    url: `https://www.instagram.com/p/C${id}/`,
    createdAt: new Date(Date.now() - hoursAgo * HOUR_MS).toISOString(),
    caption,
    likeCount: 10,
    commentCount: 2,
    isPinned: false,
    isCarousel: false,
    isVideo: false,
    owner: { username, fullName: username, isVerified: false, ...(followerCount == null ? {} : { followerCount }) },
    ...rest,
  };
}

describe('proveedor apidojo del adapter de Instagram', { concurrency: false }, () => {
  test('normalizePost: la fixture real de perfil queda en la forma del orquestador (id numérico, url /p/, tipo, seguidores del autor, del más nuevo al más viejo)', () => {
    const posts = provider.normalizeItems(fixture('profile'), { account: 'clavescom', sourceType: 'account' });
    assert.equal(posts.length, 10);
    const [reel, carrusel] = posts;

    assert.deepEqual(
      { ...reel, caption: reel.caption.length, hashtagsText: typeof reel.hashtagsText },
      {
        id: '3988493567591356014',
        account: 'clavescom',
        url: 'https://www.instagram.com/p/DdZ-cSNNpZu/',
        caption: 64,
        hashtagsText: 'string',
        likes: 103,
        comments: 96,
        postedAt: '2026-09-17T22:54:00.000Z',
        postType: 'reel',
        followers: 209424,
        sourceType: 'account',
        sourceQuery: null,
      }
    );
    assert.equal(carrusel.postType, 'carrusel', 'isCarousel + carouselMedia(3)');
    assert.equal(carrusel.likes, 121);
    assert.equal(carrusel.comments, 23);
    assert.equal(posts[3].postType, 'carrusel');
    assert.equal(posts[3].likes, 5565);
    assert.equal(posts[3].comments, 834);
    for (const post of posts) {
      assert.match(post.id, /^\d+$/, 'id numérico de Instagram, como string');
      assert.match(post.url, /^https:\/\/www\.instagram\.com\/p\/[\w-]+\/$/);
      assert.equal(post.account, 'clavescom');
      assert.equal(post.followers, 209424);
      assert.ok(['reel', 'carrusel', 'imagen'].includes(post.postType), post.postType);
    }
    const dates = posts.map((p) => p.postedAt);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'del más nuevo al más viejo');
    // El id y la url coinciden con lo que guardó el actor oficial (verificado
    // contra data/monitoring.db el 2026-09-18): el último de la lista ya
    // estaba en detected_posts con ese mismo id y esa misma url.
    assert.equal(posts[9].id, '3988358856337888982');
    assert.equal(posts[9].url, 'https://www.instagram.com/p/DdZfz-kzZbW/');
  });

  test('normalizePost: hashtag y búsqueda toman la cuenta del autor (sin seguidores: el actor no los manda ahí), 0 real se conserva, null queda null', () => {
    const hashtag = provider.normalizeItems(fixture('hashtag'), { account: null, sourceType: 'hashtag' });
    assert.equal(hashtag.length, 7);
    assert.equal(hashtag[0].id, '3988529580284673536');
    assert.equal(hashtag[0].account, 'tecontamoslapostaok');
    assert.equal(hashtag[0].followers, null, 'owner sin followerCount en consultas de hashtag');
    assert.equal(hashtag[0].sourceType, 'hashtag');
    assert.equal(hashtag[0].postType, 'imagen');
    assert.equal(hashtag[0].likes, 49);
    assert.equal(hashtag[0].comments, 13);
    assert.match(hashtag[0].hashtagsText, /#JorgeMacri/);
    assert.equal(hashtag[1].likes, 0, 'un 0 real se conserva');
    assert.equal(hashtag[1].comments, 0);
    assert.equal(hashtag[2].postType, 'carrusel');
    assert.ok(hashtag.every((p) => p.followers === null));

    const search = provider.normalizeItems(fixture('search'), { account: null, sourceType: 'search', sourceQuery: 'jorge macri' });
    assert.equal(search.length, 2);
    assert.equal(search[0].id, '3988633620029857812');
    assert.equal(search[0].account, 'jorge2027macri');
    assert.equal(search[0].sourceType, 'search');
    assert.equal(search[0].sourceQuery, 'jorge macri');
    assert.equal(search[0].postType, 'reel');
    assert.equal(search[0].caption, '', 'caption null -> vacío (el orquestador lo descarta por no tener texto)');
    assert.equal(search[0].likes, null, 'likeCount null = sin dato, nunca 0');
    assert.equal(search[0].comments, null);
    assert.equal(search[0].followers, null);
  });

  test('posteo en colaboración en la respuesta de un perfil: owner.followerCount es del perfil consultado, así que no se le atribuye al autor del item', () => {
    // Visto en el ciclo real del 2026-09-18: la consulta de @somoslupaa (54
    // seguidores) trajo dos posteos cuyo owner es @somos100barrios (19.276),
    // los dos con followerCount 54.
    const items = [
      rawPost({ id: 301, username: 'cuenta_prueba', followerCount: 19276 }),
      rawPost({ id: 302, username: 'colaboradora', followerCount: 19276 }),
    ];
    const posts = provider.normalizeItems(items, { account: 'Cuenta_Prueba', sourceType: 'account' });
    assert.equal(posts[0].followers, 19276, 'mismo owner, sin distinguir mayúsculas');
    assert.equal(posts[1].account, 'colaboradora', 'la cuenta sigue siendo la del autor');
    assert.equal(posts[1].followers, null, 'los seguidores del perfil consultado no son los del autor');
    assert.equal(monitor.rememberFollowers(posts, 'instagram'), 1);
    assert.equal(db.getAccountFollowers('cuenta_prueba', 'instagram'), 19276);
    assert.equal(db.getAccountFollowers('colaboradora', 'instagram'), null);
    // Sin cuenta consultada (hashtag, búsqueda) el dato, si viniera, es del owner.
    assert.equal(provider.normalizePost(items[1], { account: null, sourceType: 'hashtag' }).followers, 19276);
  });

  test('descarta lo que no es un posteo: lista vacía (perfil inexistente), noResults, error, sin id, sin url ni code, basura', () => {
    const ctx = { account: 'x', sourceType: 'account' };
    assert.deepEqual(fixture('not-found'), [], 'un perfil inexistente devuelve lista vacía');
    assert.deepEqual(provider.normalizeItems(fixture('not-found'), ctx), []);
    assert.equal(provider.normalizePost({ noResults: true, url: 'https://www.instagram.com/nadie/' }, ctx), null);
    assert.equal(provider.normalizePost({ error: 'not_found', id: '1', url: 'u' }, ctx), null);
    assert.equal(provider.normalizePost({ code: 'abc', url: 'https://www.instagram.com/p/abc/' }, ctx), null, 'sin id');
    assert.equal(provider.normalizePost({ id: '', url: 'https://www.instagram.com/p/abc/' }, ctx), null, 'id vacío');
    assert.equal(provider.normalizePost({ id: '5', caption: 'sin url ni code' }, ctx), null);
    assert.equal(provider.normalizePost(null, ctx), null);
    assert.equal(provider.normalizePost(undefined, ctx), null);
    assert.equal(provider.normalizePost('texto', ctx), null);
    // Con code pero sin url, la url se arma; con id numérico también.
    const armado = provider.normalizePost({ id: 77, code: 'Cod77', createdAt: 1758150000 }, ctx);
    assert.equal(armado.url, 'https://www.instagram.com/p/Cod77/');
    assert.equal(armado.id, '77');
    assert.equal(armado.postedAt, new Date(1758150000 * 1000).toISOString(), 'epoch en segundos');
    assert.equal(armado.likes, null);
    assert.equal(armado.followers, null);
    assert.equal(armado.postType, null);
    assert.equal(provider.normalizeItems([null, { noResults: true }, ...fixture('search')], ctx).length, 2);
    assert.deepEqual(provider.normalizeItems(undefined, ctx), []);
  });

  test('derivePostType: mismos valores que account_stats; el carrusel se mira antes que el video; sin indicadores, null', () => {
    const t = provider.derivePostType;
    assert.equal(t({ type: 'post', isVideo: true, isCarousel: false }), 'reel');
    assert.equal(t({ type: 'post', isVideo: false, isCarousel: false }), 'imagen');
    assert.equal(t({ type: 'post', isVideo: false, isCarousel: true, carouselMedia: [{}, {}, {}] }), 'carrusel');
    assert.equal(t({ isVideo: true, isCarousel: true }), 'carrusel', 'carrusel con video adentro');
    assert.equal(t({ isVideo: false, carouselMedia: [{}, {}] }), 'carrusel', 'carouselMedia sin el booleano');
    assert.equal(t({ isVideo: false, carouselMedia: [{}] }), 'imagen', 'un solo hijo no es carrusel');
    assert.equal(t({ video: { url: 'v', playCount: 1 } }), 'reel');
    // Respaldo con los nombres del actor oficial.
    assert.equal(t({ productType: 'clips' }), 'reel');
    assert.equal(t({ productType: 'carousel_container' }), 'carrusel');
    assert.equal(t({ type: 'Sidecar' }), 'carrusel');
    assert.equal(t({ type: 'Image' }), 'imagen');
    assert.equal(t({ type: 'post' }), null);
    assert.equal(t({}), null);
  });

  test('parseLookbackMs / untilDateFor / applyWindow: until es el día UTC en que arranca la ventana; lo anterior a la ventana real se descarta', () => {
    const now = Date.UTC(2026, 8, 18, 3, 0, 0); // 2026-09-18 03:00 UTC
    assert.equal(provider.parseLookbackMs('1 day'), DAY_MS);
    assert.equal(provider.parseLookbackMs('6 hours'), 6 * HOUR_MS);
    assert.equal(provider.parseLookbackMs('2 weeks'), 14 * DAY_MS);
    assert.equal(provider.parseLookbackMs('30 minutes'), 30 * 60 * 1000);
    assert.equal(provider.parseLookbackMs('  3 days '), 3 * DAY_MS);
    assert.equal(provider.parseLookbackMs('ayer'), null);
    assert.equal(provider.parseLookbackMs('0 days'), null);
    assert.equal(provider.parseLookbackMs(undefined), null);
    assert.equal(provider.parseLookbackMs(''), null);

    assert.equal(provider.untilDateFor('1 day', now), '2026-09-17', 'con "1 day" es la fecha UTC de ayer');
    assert.equal(provider.untilDateFor('6 hours', now), '2026-09-17', 'cruza la medianoche UTC hacia atrás');
    assert.equal(provider.untilDateFor('2 weeks', now), '2026-09-04');
    assert.equal(provider.untilDateFor(undefined, now), undefined, 'sin lookback no hay until (benchmark, refresco)');
    assert.equal(provider.untilDateFor('ayer', now), undefined);

    const posts = [
      { id: 'a', postedAt: new Date(now - 2 * HOUR_MS).toISOString() },
      { id: 'b', postedAt: new Date(now - 23 * HOUR_MS).toISOString() },
      { id: 'c', postedAt: new Date(now - 25 * HOUR_MS).toISOString() }, // mismo día UTC que until, fuera de la ventana real
      { id: 'd', postedAt: '2026-06-01T10:00:00.000Z' }, // fijado viejo
      { id: 'e', postedAt: null },
    ];
    assert.deepEqual(provider.applyWindow(posts, '1 day', now).map((p) => p.id), ['a', 'b']);
    assert.deepEqual(provider.applyWindow(posts, '3 hours', now).map((p) => p.id), ['a']);
    assert.equal(provider.applyWindow(posts, undefined, now).length, 5, 'sin lookback pasa todo');
  });

  test('scrapeAccount: una URL de perfil por run, maxItems = resultsLimit, until solo con lookback, ventana aplicada del lado nuestro', async () => {
    const originalFetch = global.fetch;
    try {
      const calls = stubFetch(() => [rawPost({ id: 1, hoursAgo: 1 }), rawPost({ id: 2, hoursAgo: 72 }), { noResults: true }]);
      const posts = await instagram.scrapeAccount('cuenta_prueba', { resultsLimit: 10, lookback: '1 day' });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/acts\/apidojo~instagram-scraper-api\/run-sync-get-dataset-items\?token=token-de-test$/);
      assert.deepEqual(calls[0].body, {
        startUrls: ['https://www.instagram.com/cuenta_prueba/'],
        maxItems: 10,
        until: provider.untilDateFor('1 day'),
      });
      assert.deepEqual(posts.map((p) => p.id), ['1'], 'el de hace 3 días y el item sin resultados quedan afuera');
      assert.equal(posts[0].sourceType, 'account');
      assert.equal(posts[0].account, 'cuenta_prueba');

      // Sin lookback (benchmark / refresco): sin until y sin ventana.
      const all = await instagram.scrapeAccount('cuenta_prueba', { resultsLimit: 15 });
      assert.deepEqual(calls[1].body, { startUrls: ['https://www.instagram.com/cuenta_prueba/'], maxItems: 15 });
      assert.deepEqual(all.map((p) => p.id), ['1', '2']);

      // resultsLimit inválido: nunca un run sin maxItems.
      const originalWarn = console.warn;
      const warned = [];
      console.warn = (...args) => warned.push(args.join(' '));
      try {
        await instagram.scrapeAccount('cuenta_prueba', { resultsLimit: undefined });
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(calls[2].body.maxItems, 10);
      assert.ok(warned.some((w) => w.includes('maxItems=10')));
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('scrapeHashtag y scrapeSearch: URL de hashtag o keywords, sourceType propio, mismo until y ventana', async () => {
    const originalFetch = global.fetch;
    try {
      const calls = stubFetch((body) =>
        body.keywords
          ? fixture('search').map((r, i) => ({ ...r, createdAt: new Date(Date.now() - (i + 1) * HOUR_MS).toISOString() }))
          : [rawPost({ id: 9, username: 'otra_cuenta', followerCount: null })]
      );
      const hashtag = await instagram.scrapeHashtag('JorgeMacri', { resultsLimit: 30, lookback: '1 day' });
      assert.deepEqual(calls[0].body, {
        startUrls: ['https://www.instagram.com/explore/tags/JorgeMacri/'],
        maxItems: 30,
        until: provider.untilDateFor('1 day'),
      });
      assert.equal(hashtag.length, 1);
      assert.equal(hashtag[0].sourceType, 'hashtag');
      assert.equal(hashtag[0].account, 'otra_cuenta');
      assert.equal(hashtag[0].followers, null);

      assert.equal(typeof instagram.scrapeSearch, 'function', 'la fachada expone scrapeSearch con apidojo');
      const search = await instagram.scrapeSearch('  jorge macri ', { resultsLimit: 50, lookback: '1 day' });
      assert.deepEqual(calls[1].body, { keywords: ['jorge macri'], maxItems: 50, until: provider.untilDateFor('1 day') });
      assert.equal(search.length, 2);
      assert.equal(search[0].sourceType, 'search');
      assert.equal(search[0].sourceQuery, 'jorge macri');
      assert.equal(search[1].caption, '');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('validateAccount / validateHashtag: una consulta con maxItems 1; lista vacía o item sin resultados rechazan con userMessage', async () => {
    const originalFetch = global.fetch;
    try {
      let reply = () => fixture('not-found'); // []
      const calls = stubFetch(() => reply());
      await assert.rejects(instagram.validateAccount('cuenta_que_no_existe_123456'), (err) => {
        assert.match(err.userMessage, /No encontramos la cuenta @cuenta_que_no_existe_123456/);
        return true;
      });
      assert.deepEqual(calls[0].body, { startUrls: ['https://www.instagram.com/cuenta_que_no_existe_123456/'], maxItems: 1 });

      reply = () => [{ noResults: true }];
      await assert.rejects(instagram.validateAccount('vacia'), /Cuenta no encontrada/);
      reply = () => [{ error: 'not_found' }];
      await assert.rejects(instagram.validateHashtag('nadadenada'), (err) => {
        assert.match(err.userMessage, /No encontramos contenido para el hashtag #nadadenada/);
        return true;
      });
      assert.deepEqual(calls.at(-1).body, { startUrls: ['https://www.instagram.com/explore/tags/nadadenada/'], maxItems: 1 });

      reply = () => fixture('profile').slice(0, 1);
      await instagram.validateAccount('clavescom');
      await instagram.validateHashtag('JorgeMacri');
      assert.equal(calls.length, 5);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('fetchAccountFollowers no llama a Apify: los seguidores vienen en los posteos', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('no debería llamarse');
    };
    try {
      assert.equal(await instagram.fetchAccountFollowers('cuenta_prueba'), null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('fachada: proveedor apidojo activo, actor y delegación de normalizePost', () => {
    assert.equal(instagram.provider, 'apidojo');
    assert.equal(instagram.actorId, 'apidojo~instagram-scraper-api');
    assert.equal(instagram.id, 'instagram');
    assert.deepEqual(instagram.capabilities, { benchmark: true, followers: true, metricsRefresh: true });
    const raw = fixture('profile')[0];
    assert.deepEqual(instagram.normalizePost(raw, { account: 'x', sourceType: 'account' }), provider.normalizePost(raw, { account: 'x', sourceType: 'account' }));
    assert.equal(instagram.buildProfileUrl('pepe'), 'https://www.instagram.com/pepe/');
  });

  test('rememberFollowers: la caché account_followers se actualiza con lo que trajo cada respuesta, una vez por cuenta; sin capability no hace nada', () => {
    const posts = [
      { id: '1', account: 'cuenta_prueba', followers: 100 },
      { id: '2', account: 'Cuenta_Prueba', followers: 200 }, // misma cuenta, otra capitalización: gana la primera
      { id: '3', account: 'otra_cuenta', followers: null }, // sin dato (posteo de hashtag o búsqueda): no toca
      { id: '4', account: 'N/D', followers: 5 },
      { id: '5', account: 'medio_local', followers: 45000 },
      null,
    ];
    assert.equal(monitor.rememberFollowers(posts, 'instagram'), 2);
    assert.equal(db.getAccountFollowers('cuenta_prueba', 'instagram'), 100);
    assert.equal(db.getAccountFollowers('medio_local', 'instagram'), 45000);
    assert.equal(db.getAccountFollowers('otra_cuenta', 'instagram'), null);
    assert.equal(monitor.rememberFollowers([{ id: '9', account: 'vecino', followers: 7 }], 'x'), 0, 'X no tiene seguidores');
    assert.equal(db.getAccountFollowers('vecino', 'x'), null);
    assert.equal(monitor.rememberFollowers([], 'instagram'), 0);
    assert.equal(monitor.rememberFollowers(undefined, 'instagram'), 0);
  });

  test('computeAccountStats: seguidores desde los posteos sin consulta aparte; si ningún posteo los trae, la consulta de respaldo', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, fetchAccountFollowers: instagram.fetchAccountFollowers };
    try {
      instagram.scrapeAccount = async () =>
        Array.from({ length: 6 }, (_, i) =>
          provider.normalizePost(rawPost({ id: 100 + i, hoursAgo: 24 * (i + 1), username: 'cuentax', followerCount: 555 }), { account: 'cuentax', sourceType: 'account' })
        );
      instagram.fetchAccountFollowers = async () => {
        throw new Error('no debería consultarse: los posteos traen seguidores');
      };
      const result = await accountStats.computeAccountStats('cuentax', 'instagram');
      assert.equal(result.followersChecked, 0);
      assert.equal(result.followersFound, true);
      assert.equal(result.groupsSaved > 0, true);
      assert.equal(db.getAccountFollowers('cuentax', 'instagram'), 555);

      // Sin posteos (o sin el dato): consulta de respaldo del adapter.
      instagram.scrapeAccount = async () => [];
      instagram.fetchAccountFollowers = async () => 777;
      const fallback = await accountStats.computeAccountStats('cuentax', 'instagram');
      assert.equal(fallback.followersChecked, 1);
      assert.equal(fallback.followersFound, true);
      assert.equal(db.getAccountFollowers('cuentax', 'instagram'), 777);
      assert.equal(fallback.referenceKept, true, 'la referencia anterior se conserva');
    } finally {
      instagram.scrapeAccount = originals.scrapeAccount;
      instagram.fetchAccountFollowers = originals.fetchAccountFollowers;
    }
  });

  test('ciclo de monitoreo: el posteo nuevo sale con los seguidores que vinieron en el posteo y la caché queda al día', async () => {
    const originals = { scrapeAccount: instagram.scrapeAccount, isConfigured: instagram.isConfigured };
    try {
      instagram.isConfigured = () => true;
      // Cambio D: cuentas/hashtags usan la ventana dinámica de
      // detectionWindowFor (no ya el MONITOR_LOOKBACK fijo) — se recalcula
      // acá para no atarse a un valor fijo (depende de si otro test de este
      // archivo ya dejó una marca de detección exitosa).
      instagram.scrapeAccount = async (account, { resultsLimit, lookback }) => {
        const window = monitor.detectionWindowFor('instagram');
        assert.equal(resultsLimit, window.isDefault ? 10 : monitor.raiseLimitForWindow(10, window.windowDays), 'tope por cuenta (según ventana)');
        assert.equal(lookback, window.lookback);
        return [provider.normalizePost(rawPost({ id: 500, caption: 'arrancan las obras del bajo', followerCount: 4321 }), { account, sourceType: 'account' })];
      };
      const result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.equal(result.newPosts.length, 1);
      assert.equal(result.newPosts[0].followers, 4321);
      const saved = db.listDetectedPosts({ page: 1, pageSize: 10, plataforma: 'instagram' }).posts.find((p) => p.id === '500');
      assert.equal(saved.followers, 4321);
      assert.equal(saved.post_type, 'imagen');
      assert.equal(db.getAccountFollowers('cuenta_prueba', 'instagram'), 4321);
    } finally {
      instagram.scrapeAccount = originals.scrapeAccount;
      instagram.isConfigured = originals.isConfigured;
    }
  });

  test('monitorLimits: defaults por tipo de fuente, topes nuevos, y MONITOR_RESULTS_LIMIT solo como respaldo con aviso', () => {
    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      assert.deepEqual(monitor.monitorLimits(), { account: 10, hashtag: 30, search: 50 });
      process.env.MONITOR_RESULTS_LIMIT = '15';
      assert.deepEqual(monitor.monitorLimits(), { account: 15, hashtag: 15, search: 50 }, 'un .env viejo sigue igual que antes');
      assert.equal(warned.filter((w) => w.includes('MONITOR_RESULTS_LIMIT=15')).length, 1);
      monitor.monitorLimits();
      assert.equal(warned.length, 1, 'avisa una sola vez');
      process.env.MONITOR_ACCOUNT_LIMIT = '8';
      process.env.MONITOR_HASHTAG_LIMIT = '20';
      process.env.SEARCH_RESULTS_LIMIT = '40';
      assert.deepEqual(monitor.monitorLimits(), { account: 8, hashtag: 20, search: 40 }, 'los topes nuevos ganan');
      process.env.MONITOR_ACCOUNT_LIMIT = 'nada';
      process.env.SEARCH_RESULTS_LIMIT = '0';
      assert.deepEqual(monitor.monitorLimits(), { account: 15, hashtag: 20, search: 50 }, 'inválidos: respaldo o default');
    } finally {
      console.warn = originalWarn;
      delete process.env.MONITOR_RESULTS_LIMIT;
      delete process.env.MONITOR_ACCOUNT_LIMIT;
      delete process.env.MONITOR_HASHTAG_LIMIT;
      delete process.env.SEARCH_RESULTS_LIMIT;
    }
  });
});
