'use strict';

// Criterio de recálculo del benchmark por cuenta (src/accountStats.js +
// db.listAccountBenchmarkActivity): una cuenta se recalcula SOLO si apareció
// con un posteo nuevo en detected_posts y nunca se calculó, o ese posteo se
// detectó BENCHMARK_RECALC_DAYS o más después del último cálculo. Tope por
// ciclo con cola FIFO derivada de la base, intento sin datos que conserva la
// referencia anterior, y el mismo ciclo del scheduler (posteos -> benchmark
// -> métricas). Corre contra tempfiles con el adapter de Instagram y el
// clasificador stubeados: nunca toca Apify, un LLM, config/monitoring.json
// ni data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-benchmark-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
const CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = CONFIG_PATH;
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

// Config escrita directo (nunca por addAccount): una cuenta trackeada que
// no va a traer nada, y una keyword literal para que los posteos de hashtag
// entren sin pasar por el clasificador de relevancia.
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: ['trackeada'], keywords: ['obras', '#caba'] } }, null, 2) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
classifier.classifyPost = async (caption) => ({ title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' });
classifier.classifyRelevance = async () => ({ relevant: false });

const db = require('../src/db');
const accountStats = require('../src/accountStats');
const scheduler = require('../src/scheduler');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

// Segunda conexión al mismo archivo para fijar detected_at a mano (db.js lo
// pone siempre en "ahora" al guardar).
const raw = new DatabaseSync(DB_PATH);

// Adapter de Instagram stubeado. La llamada del benchmark (y del refresco de
// métricas) va sin lookback; la del ciclo de monitoreo, con lookback.
const calls = { benchmark: [], monitor: [], followers: [] };
let benchmarkPosts = {}; // cuenta (minúscula) -> posteos que devuelve la pasada del benchmark
let monitorPosts = {}; // cuenta (minúscula) -> posteos que devuelve el ciclo de monitoreo
let hashtagPosts = {}; // tag -> posteos
instagram.isConfigured = () => true;
instagram.scrapeAccount = async (account, { lookback } = {}) => {
  const key = String(account).toLowerCase();
  if (lookback === undefined) {
    calls.benchmark.push(key);
    return benchmarkPosts[key] || [];
  }
  calls.monitor.push(key);
  return monitorPosts[key] || [];
};
instagram.scrapeHashtag = async (tag) => hashtagPosts[tag] || [];
instagram.fetchAccountFollowers = async (account) => {
  calls.followers.push(String(account).toLowerCase());
  return 1234;
};

const benchmarkCalls = (account) => calls.benchmark.filter((a) => a === account.toLowerCase()).length;

/** Posteo guardado en detected_posts con detected_at controlado. posted_at viejo (70 días) para que el refresco de métricas lo deje congelado. */
function insertPost({ id, account, detectedDaysAgo = 0, postedDaysAgo = 70, ignored = false, plataforma = 'instagram' }) {
  const inserted = db.saveDetectedPost({
    id,
    account,
    url: `https://www.instagram.com/p/${id}/`,
    caption: 'obras',
    matchedReason: 'test',
    likes: 10,
    comments: 2,
    postedAt: iso(postedDaysAgo),
    title: 't',
    sentiment: 'neutral',
    postType: null,
    followers: null,
    plataforma,
  });
  assert.equal(inserted, true, `insert ${id}`);
  raw.prepare('UPDATE detected_posts SET detected_at = ?, ignored = ? WHERE id = ?').run(iso(detectedDaysAgo), ignored ? 1 : 0, id);
}

function setStats(account, { computedDaysAgo, postType = null, nPosts = 12, medianLikes = 100, medianComments = 10 }) {
  db.upsertAccountStats({ account, plataforma: 'instagram', postType, nPosts, medianLikes, medianComments, computedAt: iso(computedDaysAgo) });
}

/** Muestra que devuelve la pasada del benchmark: n posteos recientes del mismo tipo con likes 100.. y comments 10.. */
function benchmarkSample(account, n = 6, { postType = 'imagen' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${account}-b${i}`,
    account,
    url: `https://www.instagram.com/p/${account}-b${i}/`,
    caption: 'muestra',
    hashtagsText: '',
    likes: 100 + i,
    comments: 10 + i,
    postedAt: iso(i + 1),
    postType,
    sourceType: 'account',
    sourceQuery: null,
  }));
}

function activityByAccount(recalcDays = 90) {
  return new Map(db.listAccountBenchmarkActivity('instagram', recalcDays).map((row) => [row.account.toLowerCase(), row]));
}

function statsRowsOf(account) {
  return db.listAllAccountStats().filter((r) => r.account.toLowerCase() === account.toLowerCase() && r.plataforma === 'instagram');
}

describe('benchmark: criterio de recálculo', { concurrency: false }, () => {
  test('selectAccountsForRecalc: solo elegibles, FIFO por eligibleSince, tope', () => {
    const rows = [
      { account: 'zeta', lastDetectedAt: iso(0), lastComputedAt: null, eligibleSince: '2026-01-05T00:00:00.000Z' },
      { account: 'alfa', lastDetectedAt: iso(0), lastComputedAt: iso(100), eligibleSince: '2026-01-01T00:00:00.000Z' },
      { account: 'beta', lastDetectedAt: iso(0), lastComputedAt: iso(10), eligibleSince: null },
      { account: 'gama', lastDetectedAt: iso(0), lastComputedAt: null, eligibleSince: '2026-01-05T00:00:00.000Z' },
    ];
    const capped = accountStats.selectAccountsForRecalc(rows, 2);
    // alfa se volvió elegible primero aunque ya tenga cálculo; gama y zeta
    // empatan y desempatan por nombre.
    assert.deepEqual(capped.toProcess.map((r) => r.account), ['alfa', 'gama']);
    assert.equal(capped.deferred, 1);
    assert.equal(capped.upToDate, 1);
    assert.deepEqual(accountStats.selectAccountsForRecalc(rows, 10).toProcess.map((r) => r.account), ['alfa', 'gama', 'zeta']);
    assert.deepEqual(accountStats.selectAccountsForRecalc(rows, 0).toProcess, []);
    assert.deepEqual(accountStats.selectAccountsForRecalc([], 5), { toProcess: [], deferred: 0, upToDate: 0 });
    assert.equal(accountStats.BENCHMARK_RECALC_DAYS, 90);
  });

  test('listAccountBenchmarkActivity: la condición sale de detected_at vs. computed_at de la fila global', () => {
    insertPost({ id: 'nueva-1', account: 'nueva', detectedDaysAgo: 3 }); // nunca calculada
    setStats('aldia', { computedDaysAgo: 10 });
    insertPost({ id: 'aldia-1', account: 'aldia', detectedDaysAgo: 30 }); // posteo anterior al cálculo
    setStats('reciente', { computedDaysAgo: 20 });
    insertPost({ id: 'reciente-1', account: 'reciente', detectedDaysAgo: 10 }); // 10 días después: no
    setStats('vieja', { computedDaysAgo: 100 });
    insertPost({ id: 'vieja-1', account: 'vieja', detectedDaysAgo: 95 }); // 5 días después: no cuenta
    insertPost({ id: 'vieja-2', account: 'vieja', detectedDaysAgo: 5 }); // 95 días después: sí
    insertPost({ id: 'ignorada-1', account: 'ignorada', detectedDaysAgo: 1, ignored: true });
    insertPost({ id: 'nd-1', account: 'N/D', detectedDaysAgo: 1 });
    setStats('MayUscula', { computedDaysAgo: 100 });
    insertPost({ id: 'may-1', account: 'mayuscula', detectedDaysAgo: 2 });
    setStats('soloportipo', { computedDaysAgo: 5, postType: 'reel' }); // sin fila global: cuenta como nunca calculada
    insertPost({ id: 'tipo-1', account: 'soloportipo', detectedDaysAgo: 1 });
    insertPost({ id: 'x-1', account: 'nueva', detectedDaysAgo: 1, plataforma: 'x' }); // otra plataforma: no cuenta

    const byAccount = activityByAccount();
    assert.deepEqual(
      [...byAccount.keys()].sort(),
      ['aldia', 'mayuscula', 'nueva', 'reciente', 'soloportipo', 'vieja'],
      'ni ignorados, ni N/D, ni la trackeada sin posteos, ni la fila de X'
    );

    const nueva = byAccount.get('nueva');
    assert.equal(nueva.lastComputedAt, null);
    assert.equal(nueva.eligibleSince, nueva.lastDetectedAt);
    assert.equal(byAccount.get('aldia').eligibleSince, null);
    assert.equal(byAccount.get('reciente').eligibleSince, null);

    const vieja = byAccount.get('vieja');
    assert.ok(vieja.lastComputedAt);
    assert.equal(vieja.eligibleSince, vieja.lastDetectedAt, 'elegible desde el posteo que sí supera los 90 días, no desde el anterior');
    assert.ok(new Date(vieja.lastDetectedAt) > new Date(iso(6)));

    // Join case-insensitive: una sola fila, con el nombre de account_stats.
    assert.equal(byAccount.get('mayuscula').account, 'MayUscula');
    assert.ok(byAccount.get('mayuscula').eligibleSince);

    // Filas por tipo sin fila global (bases anteriores al fallback global):
    // el último cálculo es desconocido -> nunca calculada.
    assert.equal(byAccount.get('soloportipo').lastComputedAt, null);
    assert.ok(byAccount.get('soloportipo').eligibleSince);

    // El plazo es un parámetro: con 5 días, "reciente" (10 días después) entra.
    assert.ok(activityByAccount(5).get('reciente').eligibleSince);
    assert.equal(activityByAccount(5).get('aldia').eligibleSince, null, 'un posteo anterior al cálculo nunca dispara');
  });

  test('intento sin datos suficientes: deja marca, conserva la referencia previa y no se repite', async () => {
    benchmarkPosts = {}; // la fuente no devuelve nada para nadie
    const result = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 100 });
    assert.equal(result.recalculated, 4, 'nueva, vieja, MayUscula y soloportipo');
    assert.equal(result.attemptsOnly, 4);
    assert.equal(result.deferred, 0);
    assert.deepEqual(result.recalculatedAccounts.instagram.map((a) => a.toLowerCase()).sort(), ['mayuscula', 'nueva', 'soloportipo', 'vieja']);
    for (const account of ['nueva', 'vieja', 'mayuscula', 'soloportipo']) assert.equal(benchmarkCalls(account), 1, account);
    for (const account of ['trackeada', 'aldia', 'reciente', 'ignorada']) assert.equal(benchmarkCalls(account), 0, account);

    // Con referencia previa: medianas intactas, computed_at avanzó.
    const vieja = db.getAccountStats('vieja', 'instagram', null);
    assert.equal(vieja.nPosts, 12);
    assert.equal(vieja.medianLikes, 100);
    assert.ok(new Date(vieja.computedAt) > new Date(iso(1)));
    assert.equal(accountStats.classifyPostAgainstBenchmark({ account: 'vieja', likes: 100, comments: 10 }).likes.level, 'normal');

    // Sin referencia previa: fila global con n_posts real (0) como marca; sigue "sin referencia".
    const nueva = db.getAccountStats('nueva', 'instagram', null);
    assert.equal(nueva.nPosts, 0);
    assert.equal(nueva.medianLikes, null);
    assert.equal(accountStats.classifyPostAgainstBenchmark({ account: 'nueva', likes: 5, comments: 1 }).likes.level, 'sin-referencia');

    // Capitalización: se tocó la fila existente, no se creó otra.
    assert.equal(statsRowsOf('mayuscula').length, 1);
    assert.equal(statsRowsOf('mayuscula')[0].account, 'MayUscula');
    // Solo por tipo: ahora también tiene la global (marca), la de reel sigue.
    assert.deepEqual(statsRowsOf('soloportipo').map((r) => r.postType).sort(), [null, 'reel']);

    // Nada quedó pendiente: el ciclo siguiente no consulta a nadie.
    const again = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] });
    assert.equal(again.recalculated, 0);
    assert.equal(again.upToDate, 6);
    assert.equal(calls.benchmark.length, 4);
  });

  test('cuenta nueva con posteo: se calcula (con seguidores) y el ciclo siguiente no la repite', async () => {
    insertPost({ id: 'nueva2-1', account: 'nueva2' });
    benchmarkPosts = { nueva2: benchmarkSample('nueva2') };
    const result = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] });
    assert.equal(result.recalculated, 1);
    assert.equal(result.attemptsOnly, 0);
    assert.equal(benchmarkCalls('nueva2'), 1);
    assert.deepEqual(statsRowsOf('nueva2').map((r) => [r.postType, r.nPosts]).sort(), [[null, 6], ['imagen', 6]]);
    const benchmark = accountStats.classifyPostAgainstBenchmark({ account: 'nueva2', postType: 'imagen', likes: 100, comments: 10 });
    assert.equal(benchmark.likes.level, 'normal');
    assert.equal(benchmark.likes.basis, 'tipo');
    // La misma pasada propagó los seguidores al posteo guardado.
    assert.equal(calls.followers.filter((a) => a === 'nueva2').length, 1);
    assert.equal(db.getAccountFollowers('nueva2', 'instagram'), 1234);
    assert.equal(db.listDetectedPosts({ page: 1, pageSize: 100, plataforma: 'instagram' }).posts.find((p) => p.id === 'nueva2-1').followers, 1234);

    const again = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] });
    assert.equal(again.recalculated, 0);
    assert.equal(benchmarkCalls('nueva2'), 1);
  });

  test('cálculo de menos de 90 días: un posteo nuevo no recalcula; con 90 o más, sí', async () => {
    insertPost({ id: 'nueva2-2', account: 'nueva2' }); // posteo nuevo, cálculo de recién
    assert.equal((await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] })).recalculated, 0);

    db.touchAccountStatsComputedAt('nueva2', 'instagram', iso(60)); // último cálculo hace 60 días, posteo de hoy
    assert.equal((await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] })).recalculated, 0);
    assert.equal(benchmarkCalls('nueva2'), 1);

    db.touchAccountStatsComputedAt('nueva2', 'instagram', iso(91)); // 91 días: el posteo de hoy dispara
    assert.equal((await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] })).recalculated, 1);
    assert.equal(benchmarkCalls('nueva2'), 2);
    assert.ok(new Date(db.getAccountStats('nueva2', 'instagram', null).computedAt) > new Date(iso(1)));
    assert.equal((await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'] })).recalculated, 0);
  });

  test('tope por ciclo: las que quedan afuera salen en los ciclos siguientes, en orden de llegada', async () => {
    insertPost({ id: 'cola1-1', account: 'cola1', detectedDaysAgo: 3 });
    insertPost({ id: 'cola2-1', account: 'cola2', detectedDaysAgo: 2 });
    insertPost({ id: 'cola3-1', account: 'cola3', detectedDaysAgo: 1 });
    benchmarkPosts = { cola1: benchmarkSample('cola1'), cola2: benchmarkSample('cola2'), cola3: benchmarkSample('cola3'), cola4: benchmarkSample('cola4') };

    const first = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 2 });
    assert.equal(first.recalculated, 2);
    assert.equal(first.deferred, 1);
    assert.deepEqual(first.recalculatedAccounts.instagram, ['cola1', 'cola2']);
    assert.equal(benchmarkCalls('cola3'), 0);

    // Entre un ciclo y otro aparece una cuenta nueva: la diferida sigue
    // primera en la cola (se volvió elegible antes), sin estado en memoria.
    insertPost({ id: 'cola4-1', account: 'cola4' });
    const second = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 1 });
    assert.deepEqual(second.recalculatedAccounts.instagram, ['cola3']);
    assert.equal(second.deferred, 1);
    const third = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 1 });
    assert.deepEqual(third.recalculatedAccounts.instagram, ['cola4']);
    assert.equal(third.deferred, 0);
    const fourth = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 1 });
    assert.equal(fourth.recalculated, 0);
    for (const account of ['cola1', 'cola2', 'cola3', 'cola4']) assert.equal(benchmarkCalls(account), 1, account);
  });

  test('mismo ciclo (scheduler): el posteo de una cuenta nueva sale con benchmark; la trackeada sin posteos no se calcula; el refresco no repite el scrape', async () => {
    monitorPosts = { trackeada: [] }; // se scrapea, no trae nada relevante
    hashtagPosts = {
      caba: [
        {
          id: 'aparecida-1',
          account: 'aparecida',
          url: 'https://www.instagram.com/p/aparecida-1/',
          caption: 'obras en la ciudad',
          hashtagsText: '#caba',
          likes: 30,
          comments: 3,
          postedAt: iso(0),
          postType: 'imagen',
          sourceType: 'hashtag',
          sourceQuery: '#caba',
        },
      ],
    };
    benchmarkPosts = { aparecida: benchmarkSample('aparecida') };
    const before = calls.benchmark.length;

    const result = await scheduler.runCycle({ plataforma: 'instagram' });
    assert.equal(result.newCount, 1);
    assert.ok(calls.monitor.includes('trackeada'), 'la trackeada se scrapeó en el ciclo');
    assert.equal(benchmarkCalls('trackeada'), 0, 'sin posteo guardado no hay recálculo');
    assert.equal(benchmarkCalls('aparecida'), 1, 'una sola pasada: el refresco de métricas no la repite');
    assert.equal(calls.benchmark.length, before + 1);

    const saved = db.listDetectedPosts({ page: 1, pageSize: 100, plataforma: 'instagram' }).posts.find((p) => p.id === 'aparecida-1');
    assert.ok(saved);
    assert.equal(saved.followers, 1234);
    // Lo mismo que arma /api/monitoring/posts para la tabla, en el mismo ciclo.
    const statsMap = accountStats.buildAccountStatsMap();
    const benchmark = accountStats.classifyPostAgainstBenchmark({
      account: saved.account,
      plataforma: 'instagram',
      postType: saved.post_type,
      likes: saved.likes,
      comments: saved.comments,
      statsMap,
    });
    assert.equal(benchmark.likes.level, 'bajo');
    assert.equal(benchmark.likes.basis, 'tipo');
    assert.equal(benchmark.comments.level, 'bajo');
    assert.ok(scheduler.getLastRunAt());
  });
});
