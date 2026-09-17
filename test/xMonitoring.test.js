'use strict';

// Adapter de X (src/platforms/x.js) y su integración con el orquestador:
// contrato, normalización, absorción del config viejo (monitoring-x.json),
// altas por sección, relevancia de posteos llegados por búsqueda de keyword
// y un ciclo completo con el adapter stubeado (sin Grok ni Apify). Corre
// contra tempfiles: nunca toca config/monitoring.json ni data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-xmon-'));
const CONFIG_PATH = path.join(tmp, 'monitoring.json');
const LEGACY_X_PATH = path.join(tmp, 'monitoring-x.json');
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = CONFIG_PATH;
process.env.MONITORING_X_CONFIG_PATH = LEGACY_X_PATH;

// Config por secciones sin X todavía, y el archivo viejo de X para absorber.
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [] } }, null, 2) + '\n');
fs.writeFileSync(LEGACY_X_PATH, JSON.stringify({ accounts: ['vecino'], keywords: ['Jorge Macri'] }, null, 2) + '\n');

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura al
// hacer require): nada de acá llama a un LLM.
const classifier = require('../src/classifier');
const classifierCalls = { post: 0, relevance: 0 };
classifier.classifyPost = async (caption) => {
  classifierCalls.post += 1;
  return { title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' };
};
classifier.classifyRelevance = async () => {
  classifierCalls.relevance += 1;
  return { relevant: false };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const { getPlatform, listPlatformIds } = require('../src/platforms');
// El adapter de X llama a grokFetch.callGrokJson por el objeto del módulo:
// stubearlo acá ejercita scrapeAccount/scrapeHashtag/scrapeKeyword reales.
const grokFetch = require('../src/x/grokFetch');
const x = getPlatform('x');
const instagram = getPlatform('instagram');

function samplePost(overrides = {}) {
  return {
    id: 'ig:aaa',
    account: 'gcba',
    url: 'https://www.instagram.com/p/AAA/',
    caption: 'hola',
    matchedReason: 'test',
    likes: 10,
    comments: 2,
    postedAt: new Date().toISOString(),
    title: 'titulo',
    sentiment: 'neutral',
    postType: 'imagen',
    followers: 100,
    plataforma: 'instagram',
    ...overrides,
  };
}

function rawTweet(overrides = {}) {
  return {
    id: '1234567890',
    url: 'https://x.com/vecino/status/1234567890',
    authorHandle: '@Vecino',
    text: 'bache en salta',
    likes: 4,
    retweets: 1,
    replies: 7,
    views: 90,
    createdAt: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}

describe('adapter X', { concurrency: false }, () => {
  test('está en el registro con el contrato del adapter', () => {
    assert.deepEqual(listPlatformIds(), ['instagram', 'x']);
    assert.equal(x.id, 'x');
    assert.equal(x.label, 'X');
    assert.deepEqual(x.capabilities, { benchmark: false, followers: false, metricsRefresh: false });
    for (const fn of ['isConfigured', 'validateAccount', 'validateHashtag', 'scrapeAccount', 'scrapeHashtag', 'scrapeKeyword', 'normalizePost', 'buildProfileUrl', 'fetchAccountFollowers']) {
      assert.equal(typeof x[fn], 'function', fn);
    }
    assert.deepEqual(x.metrics.map((m) => m.key), ['likes', 'comments', 'retweets', 'views']);
    assert.equal(x.metrics.filter((m) => m.primary).length, 1);
    assert.equal(x.buildProfileUrl('vecino'), 'https://x.com/vecino');
    // Instagram no ofrece búsqueda por keyword: para el orquestador es opcional.
    assert.equal(typeof instagram.scrapeKeyword, 'undefined');
  });

  test('normalizePost arma id x:{tweetId}, mapea replies a comments y no fija la plataforma', () => {
    const post = x.normalizePost(rawTweet(), { account: 'vecino', sourceType: 'account' });
    assert.equal(post.id, 'x:1234567890');
    assert.equal(post.account, 'Vecino');
    assert.equal(post.comments, 7);
    assert.equal(post.retweets, 1);
    assert.equal(post.views, 90);
    assert.equal(post.hashtagsText, '');
    assert.equal(post.postType, null);
    assert.equal(post.plataforma, undefined); // la pone el orquestador con el id del registro
    assert.match(post.url, /x\.com\/Vecino\/status\/1234567890/i);
  });

  test('normalizePost descarta sin tweet id', () => {
    assert.equal(x.normalizePost({ text: 'sin url' }, { sourceType: 'keyword' }), null);
  });

  test('resultsLimit capea en 50 y el prompt traduce el lookback', () => {
    const prev = process.env.X_MONITOR_RESULTS_LIMIT;
    process.env.X_MONITOR_RESULTS_LIMIT = '200';
    assert.equal(x.resultsLimit(), 50);
    process.env.X_MONITOR_RESULTS_LIMIT = '0';
    assert.equal(x.resultsLimit(), 30);
    if (prev === undefined) delete process.env.X_MONITOR_RESULTS_LIMIT;
    else process.env.X_MONITOR_RESULTS_LIMIT = prev;

    assert.match(x.buildSearchPrompt('Jorge Macri', 30, '1 day'), /hasta 30 posteos.*últimas 24 horas/);
    assert.match(x.buildSearchPrompt('from:vecino', 30, undefined), /sin restricción de fecha/);
  });

  test('scrapeAccount/scrapeHashtag/scrapeKeyword buscan el término en Grok; hashtag y keyword salen como resultado de búsqueda', async () => {
    const original = grokFetch.callGrokJson;
    const prompts = [];
    grokFetch.callGrokJson = async (prompt, opts) => {
      prompts.push(prompt);
      assert.equal(opts.maxTokens, 8000);
      return { parsed: { posts: [rawTweet(), { text: 'sin id: se descarta' }] } };
    };
    try {
      const byAccount = await x.scrapeAccount('@vecino', { lookback: '1 day' });
      assert.equal(byAccount.length, 1);
      assert.equal(byAccount[0].sourceType, 'account');
      assert.equal(byAccount[0].sourceQuery, null);
      assert.match(prompts[0], /Búsqueda: from:vecino\n/);
      assert.match(prompts[0], /últimas 24 horas/);

      // En X el hashtag es una búsqueda más: mismo sourceType que una keyword,
      // con el "#" en sourceQuery para que el motivo lo diga.
      const byHashtag = await x.scrapeHashtag('CABA');
      assert.equal(byHashtag[0].sourceType, 'keyword');
      assert.equal(byHashtag[0].sourceQuery, '#CABA');
      assert.match(prompts[1], /Búsqueda: #CABA\n/);

      const byKeyword = await x.scrapeKeyword(' Jorge Macri ');
      assert.equal(byKeyword[0].sourceType, 'keyword');
      assert.equal(byKeyword[0].sourceQuery, 'Jorge Macri');
      assert.match(prompts[2], /Búsqueda: Jorge Macri\n/);
    } finally {
      grokFetch.callGrokJson = original;
    }
  });

  test('el config viejo de X se absorbe una sola vez como sección x', () => {
    const all = monitor.loadConfigAll();
    assert.deepEqual(all.x, { accounts: ['vecino'], keywords: ['Jorge Macri'] });
    assert.deepEqual(all.instagram, { accounts: [], keywords: [] });
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.deepEqual(onDisk.x, { accounts: ['vecino'], keywords: ['Jorge Macri'] });
    assert.equal(fs.existsSync(LEGACY_X_PATH), false);
    assert.equal(fs.existsSync(`${LEGACY_X_PATH}.migrado`), true);
    // Idempotente: sin archivo viejo, la segunda lectura devuelve lo mismo.
    assert.deepEqual(monitor.loadConfigAll().x, all.x);
  });

  test('altas y bajas de X escriben la sección x sin tocar la de instagram', async () => {
    await assert.rejects(monitor.addAccount('no vale!!', 'x'), /inválido/i);
    assert.deepEqual(monitor.loadConfig('x').accounts, ['vecino']);

    const cfg = await monitor.addAccount('@JorgeMacri', 'x');
    assert.deepEqual(cfg.accounts, ['vecino', 'JorgeMacri']);
    await monitor.addKeyword('#CABA', 'x');
    let onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.deepEqual(onDisk.instagram, { accounts: [], keywords: [] });
    assert.deepEqual(onDisk.x.keywords, ['Jorge Macri', '#CABA']);

    monitor.removeAccount('JorgeMacri', 'x');
    monitor.removeKeyword('#CABA', 'x');
    onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.deepEqual(onDisk.x, { accounts: ['vecino'], keywords: ['Jorge Macri'] });
    assert.deepEqual(onDisk.instagram, { accounts: [], keywords: [] });
  });

  test('db por plataforma: listados, conteos y universo de benchmark no mezclan IG y X', () => {
    assert.equal(db.saveDetectedPost(samplePost()), true);
    assert.equal(
      db.saveDetectedPost(
        samplePost({
          id: 'x:99',
          account: 'otrovecino',
          url: 'https://x.com/otrovecino/status/99',
          plataforma: 'x',
          retweets: 3,
          views: 40,
          followers: null,
          postType: null,
        })
      ),
      true
    );

    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 20 }).total, 2);
    const onlyX = db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'x' });
    assert.equal(onlyX.total, 1);
    assert.equal(onlyX.posts[0].id, 'x:99');
    assert.equal(onlyX.posts[0].retweets, 3);
    const onlyIg = db.listDetectedPosts({ page: 1, pageSize: 20, plataforma: 'instagram' });
    assert.equal(onlyIg.total, 1);
    assert.equal(onlyIg.posts[0].id, 'ig:aaa');

    assert.equal(db.countRecentPosts(7, 'instagram'), 1);
    assert.equal(db.countRecentPosts(7, 'x'), 1);
    assert.equal(db.countRecentPosts(7), 2);

    assert.deepEqual(db.listDistinctPostAccounts('instagram'), ['gcba']);
    assert.deepEqual(db.listDistinctPostAccounts('x'), ['otrovecino']);
    assert.deepEqual(db.listDistinctPostAccounts(), ['gcba']); // default instagram

    // Seguidores por plataforma: no pisa la fila de X con el mismo handle.
    assert.equal(db.saveDetectedPost(samplePost({ id: 'x:100', account: 'gcba', url: 'https://x.com/gcba/status/100', plataforma: 'x', followers: null })), true);
    db.updateFollowersForAccount('gcba', 555, 'instagram');
    assert.equal(db.listDetectedPosts({ plataforma: 'instagram' }).posts[0].followers, 555);
    assert.equal(db.listDetectedPosts({ plataforma: 'x' }).posts.find((p) => p.id === 'x:100').followers, null);
  });

  test('evaluateRelevance: llegado por búsqueda (keyword o hashtag de X) es relevante sin classifyRelevance; el hashtag de descubrimiento de Instagram sí pregunta', async () => {
    const before = { ...classifierCalls };
    const byKeyword = await monitor.evaluateRelevance(
      { caption: 'texto que no nombra a nadie', hashtagsText: '', sourceType: 'keyword', sourceQuery: 'Jorge Macri', account: 'alguien' },
      ['jorge macri'],
      { platform: x }
    );
    assert.equal(byKeyword.relevant, true);
    assert.equal(byKeyword.matchedReason, 'Búsqueda por palabra clave: "Jorge Macri"');
    assert.match(byKeyword.title, /^titulo:/);
    assert.equal(classifierCalls.relevance, before.relevance);
    assert.equal(classifierCalls.post, before.post + 1);

    // Hashtag de X, tal cual lo devuelve x.scrapeHashtag: una búsqueda más.
    const byXHashtag = await monitor.evaluateRelevance(
      x.normalizePost(rawTweet({ text: 'texto que no nombra a nadie' }), { account: null, sourceType: 'keyword', sourceQuery: '#CABA' }),
      ['jorge macri'],
      { platform: x }
    );
    assert.equal(byXHashtag.relevant, true);
    assert.equal(byXHashtag.matchedReason, 'Búsqueda por hashtag: "#CABA"');
    assert.match(byXHashtag.title, /^titulo:/);
    assert.equal(classifierCalls.relevance, before.relevance);
    assert.equal(classifierCalls.post, before.post + 2);

    // Hashtag de Instagram (sourceType 'hashtag'): página de descubrimiento,
    // sin coincidencia literal hay que preguntarle al clasificador.
    const byIgHashtag = await monitor.evaluateRelevance(
      { caption: 'texto que no nombra a nadie', sourceType: 'hashtag', account: null },
      ['jorge macri'],
      { platform: instagram }
    );
    assert.equal(byIgHashtag.relevant, false);
    assert.equal(classifierCalls.relevance, before.relevance + 1);

    // Sin caption, una búsqueda no alcanza: no hay nada que evaluar.
    const empty = await monitor.evaluateRelevance({ caption: '', sourceType: 'keyword', sourceQuery: '#CABA' }, [], { platform: x });
    assert.equal(empty.relevant, false);
  });

  test('pickMetrics respeta lo que declara cada adapter', () => {
    const post = { likes: 1, comments: 2, retweets: 3, views: 4, otra: 5 };
    assert.deepEqual(monitor.pickMetrics(instagram, post), { likes: 1, comments: 2 });
    assert.deepEqual(monitor.pickMetrics(x, post), { likes: 1, comments: 2, retweets: 3, views: 4 });
  });

  test('runMonitoringCycle recorre el registro: X guarda plataforma, RTs y vistas; sin credenciales se saltea o avisa', async () => {
    // Adapter de X stubeado: sin Grok. Instagram sin credenciales.
    const originals = { scrapeAccount: x.scrapeAccount, scrapeHashtag: x.scrapeHashtag, scrapeKeyword: x.scrapeKeyword, isConfigured: x.isConfigured, igConfigured: instagram.isConfigured };
    let retweets = 3;
    x.isConfigured = () => true;
    x.scrapeAccount = async () => [];
    // La config de X de este archivo no tiene hashtags: si uno se colara,
    // que falle acá y no llegue a Grok.
    x.scrapeHashtag = async (tag) => { throw new Error(`scrapeHashtag(${tag}) no debería llamarse en este test`); };
    x.scrapeKeyword = async (keyword) => [
      x.normalizePost(rawTweet({ id: '555', url: 'https://x.com/vecino/status/555', text: 'hablan de la ciudad', retweets, views: 40 }), {
        account: null,
        sourceType: 'keyword',
        sourceQuery: keyword,
      }),
    ];
    instagram.isConfigured = () => false;
    try {
      // Solo Instagram, sin credenciales: el error llega (botón de esa solapa).
      await assert.rejects(monitor.runMonitoringCycle({ plataformas: ['instagram'] }), (err) => {
        assert.equal(err.code, 'NOT_CONFIGURED');
        assert.match(err.userMessage, /Falta configurar Instagram/);
        return true;
      });

      // Todo el registro (cron): Instagram se saltea con aviso, X corre.
      const first = await monitor.runMonitoringCycle();
      assert.equal(first.porPlataforma.instagram.skipped, true);
      assert.equal(first.porPlataforma.x.checked, 1);
      assert.equal(first.porPlataforma.x.newCount, 1);
      assert.deepEqual(first.scrapedAccounts, { x: ['vecino'] });
      const saved = db.listDetectedPosts({ plataforma: 'x' }).posts.find((p) => p.id === 'x:555');
      assert.ok(saved, 'la fila de X quedó guardada');
      assert.equal(saved.plataforma, 'x');
      assert.equal(saved.retweets, 3);
      assert.equal(saved.views, 40);
      assert.equal(saved.followers, null);
      assert.match(saved.matched_reason, /Búsqueda por palabra clave: "Jorge Macri"/);
      assert.match(saved.title, /^titulo:/);

      // Segunda corrida, mismo posteo con más RTs: no es nuevo, se refrescan
      // las métricas propias de X.
      retweets = 5;
      const second = await monitor.runMonitoringCycle({ plataformas: ['x'] });
      assert.equal(second.porPlataforma.x.newCount, 0);
      assert.equal(second.porPlataforma.instagram, undefined);
      assert.equal(db.listDetectedPosts({ plataforma: 'x' }).posts.find((p) => p.id === 'x:555').retweets, 5);
    } finally {
      x.scrapeAccount = originals.scrapeAccount;
      x.scrapeHashtag = originals.scrapeHashtag;
      x.scrapeKeyword = originals.scrapeKeyword;
      x.isConfigured = originals.isConfigured;
      instagram.isConfigured = originals.igConfigured;
    }
  });

  test('errores de plataforma en X: "Actualizar ahora" los recibe como error (guardando lo que sí llegó); el cron los anota y sigue', async () => {
    const originals = { callGrokJson: grokFetch.callGrokJson, isConfigured: x.isConfigured, igConfigured: instagram.isConfigured };
    await monitor.addKeyword('#CABA', 'x'); // fuentes de X: from:vecino, #CABA y "Jorge Macri"
    let keywordFailure = null; // lo que tira la búsqueda "Jorge Macri" en cada escenario
    grokFetch.callGrokJson = async (prompt) => {
      if (/Búsqueda: from:vecino\n/.test(prompt)) {
        return { parsed: { posts: [rawTweet({ id: '556', url: 'https://x.com/vecino/status/556', text: 'Jorge Macri inauguró la obra' })] } };
      }
      if (/Búsqueda: #CABA\n/.test(prompt)) {
        return { parsed: { posts: [rawTweet({ id: '557', url: 'https://x.com/otro/status/557', authorHandle: 'otro', text: 'texto que no nombra a nadie' })] } };
      }
      if (keywordFailure) throw keywordFailure;
      return { parsed: { posts: [] } };
    };
    x.isConfigured = () => true;
    instagram.isConfigured = () => false;
    const typed = (code, userMessage) => Object.assign(new Error(`Grok: ${code}`), { code, userMessage });
    try {
      // Clave inválida en la corrida de esa sola solapa: falla con el mensaje
      // de la clave, pero lo que trajeron las otras dos fuentes queda guardado
      // y el mensaje lo aclara.
      const relevanceBefore = classifierCalls.relevance;
      keywordFailure = typed('AUTH_INVALID', 'La clave de OpenRouter (OPENROUTER_API_KEY) es inválida. Revisá Infisical.');
      await assert.rejects(monitor.runMonitoringCycle({ plataformas: ['x'] }), (err) => {
        assert.equal(err.code, 'AUTH_INVALID');
        assert.equal(
          err.userMessage,
          'La clave de OpenRouter (OPENROUTER_API_KEY) es inválida. Revisá Infisical. Igual se guardaron 2 posteo(s) nuevo(s) de las fuentes que sí respondieron.'
        );
        return true;
      });
      const xPosts = db.listDetectedPosts({ plataforma: 'x' }).posts;
      assert.ok(xPosts.find((p) => p.id === 'x:556'), 'el posteo de la cuenta quedó guardado');
      const byHashtag = xPosts.find((p) => p.id === 'x:557');
      assert.ok(byHashtag, 'el posteo del hashtag quedó guardado');
      assert.equal(byHashtag.matched_reason, 'Búsqueda por hashtag: "#CABA"');
      assert.equal(classifierCalls.relevance, relevanceBefore); // ninguno pasó por classifyRelevance

      // Cuota agotada y nada nuevo: el mensaje del adapter va tal cual.
      keywordFailure = typed('QUOTA_EXCEEDED', 'OpenRouter no tiene créditos suficientes para Grok (cuota agotada).');
      await assert.rejects(monitor.runMonitoringCycle({ plataformas: ['x'] }), (err) => {
        assert.equal(err.code, 'QUOTA_EXCEEDED');
        assert.equal(err.userMessage, 'OpenRouter no tiene créditos suficientes para Grok (cuota agotada).');
        return true;
      });

      // Cron (todo el registro): no tira, deja el error anotado y sigue.
      keywordFailure = typed('RATE_LIMITED', 'OpenRouter/Grok rechazó el pedido por rate limit.');
      const cron = await monitor.runMonitoringCycle();
      assert.equal(cron.porPlataforma.instagram.skipped, true);
      assert.deepEqual(cron.porPlataforma.x.error, { code: 'RATE_LIMITED', message: 'OpenRouter/Grok rechazó el pedido por rate limit.' });
      assert.equal(cron.porPlataforma.x.checked, 2);
      assert.equal(cron.porPlataforma.x.newCount, 0);

      // Un fallo sin código es de esa fuente nomás: la corrida termina bien.
      keywordFailure = new Error('Grok no devolvió JSON');
      const partial = await monitor.runMonitoringCycle({ plataformas: ['x'] });
      assert.equal(partial.porPlataforma.x.error, undefined);
      assert.equal(partial.porPlataforma.x.checked, 2);
    } finally {
      grokFetch.callGrokJson = originals.callGrokJson;
      x.isConfigured = originals.isConfigured;
      instagram.isConfigured = originals.igConfigured;
      monitor.removeKeyword('#CABA', 'x');
    }
  });

  test('el mismo tweet por cuenta trackeada y por hashtag: gana la versión de la búsqueda (relevante sin classifyRelevance)', async () => {
    const originals = { callGrokJson: grokFetch.callGrokJson, isConfigured: x.isConfigured };
    await monitor.addKeyword('#Obras', 'x'); // fuentes: from:vecino, #Obras, "Jorge Macri"
    const same = () => rawTweet({ id: '777', url: 'https://x.com/vecino/status/777', text: 'obra nueva en el barrio' }); // sin keyword literal
    grokFetch.callGrokJson = async (prompt) => {
      if (/Búsqueda: from:vecino\n/.test(prompt)) return { parsed: { posts: [same()] } };
      if (/Búsqueda: #Obras\n/.test(prompt)) return { parsed: { posts: [same()] } };
      return { parsed: { posts: [] } };
    };
    x.isConfigured = () => true;
    try {
      const before = { ...classifierCalls };
      const run = await monitor.runMonitoringCycle({ plataformas: ['x'] });
      assert.equal(run.porPlataforma.x.checked, 1); // dedupeado
      assert.equal(run.porPlataforma.x.newCount, 1);
      const saved = db.listDetectedPosts({ plataforma: 'x' }).posts.find((p) => p.id === 'x:777');
      assert.ok(saved, 'el tweet que trajo la búsqueda #Obras quedó guardado');
      assert.equal(saved.account, 'Vecino');
      assert.equal(saved.matched_reason, 'Búsqueda por hashtag: "#Obras"');
      assert.equal(classifierCalls.relevance, before.relevance); // la versión 'account' no llegó a classifyRelevance
      assert.equal(classifierCalls.post, before.post + 1);
    } finally {
      grokFetch.callGrokJson = originals.callGrokJson;
      x.isConfigured = originals.isConfigured;
      monitor.removeKeyword('#Obras', 'x');
    }
  });

  test('cron con Instagram caído por cuota (error de Apify sin code): se anota y X sigue corriendo', async () => {
    const originals = { callGrokJson: grokFetch.callGrokJson, xConfigured: x.isConfigured, igConfigured: instagram.isConfigured, igScrapeAccount: instagram.scrapeAccount };
    const rawConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    // Directo al archivo: addAccount('gcba', 'instagram') validaría contra Apify.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ instagram: { accounts: ['gcba'], keywords: [] }, x: JSON.parse(rawConfig).x }, null, 2) + '\n');
    instagram.isConfigured = () => true;
    instagram.scrapeAccount = async () => {
      // Como lo tira apify.js si la cuota vence por texto y sin `code`.
      throw Object.assign(new Error('Apify respondió 403: {"error":{"type":"actor-disabled","message":"Monthly usage hard limit exceeded"}}'), { userMessage: 'Se agotó la cuota mensual de Apify.' });
    };
    x.isConfigured = () => true;
    grokFetch.callGrokJson = async () => ({ parsed: { posts: [rawTweet({ id: '558', url: 'https://x.com/vecino/status/558', text: 'Jorge Macri en el barrio' })] } });
    try {
      const cron = await monitor.runMonitoringCycle();
      assert.deepEqual(cron.porPlataforma.instagram, {
        checked: 0, newCount: 0, skipped: false,
        error: { code: 'QUOTA_EXCEEDED', message: 'Se agotó la cuota mensual de Apify.' },
      });
      assert.equal(cron.porPlataforma.x.checked, 1);
      assert.equal(cron.porPlataforma.x.newCount, 1);

      // Solo la solapa de Instagram: el mismo error, ya con code.
      await assert.rejects(monitor.runMonitoringCycle({ plataformas: ['instagram'] }), (err) => {
        assert.equal(err.code, 'QUOTA_EXCEEDED');
        assert.equal(err.userMessage, 'Se agotó la cuota mensual de Apify.');
        return true;
      });
    } finally {
      fs.writeFileSync(CONFIG_PATH, rawConfig);
      grokFetch.callGrokJson = originals.callGrokJson;
      x.isConfigured = originals.xConfigured;
      instagram.isConfigured = originals.igConfigured;
      instagram.scrapeAccount = originals.igScrapeAccount;
    }
  });
});
