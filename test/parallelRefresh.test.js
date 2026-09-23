'use strict';

// Cambio C: refreshStaleAccountStats (accountStats.js) y refreshPostMetrics
// (metricsRefresh.js) lanzan sus cuentas con Promise.allSettled a través de
// SU PROPIO limitador (benchmarkLimiter, refreshLimiter — nunca el
// apifyLimiter de src/apify.js, ver Cambio G / concurrencyLimiter.js) en vez
// de un for secuencial. Se prueba acá, con la fuente mockeada (sin red, sin
// Apify):
//   1. con el limitador en 2 y 6 cuentas, nunca más de 2 en vuelo a la vez.
//   2. los resultados guardados son los mismos que en modo secuencial.
//   3. el corte por cuota frena los LANZAMIENTOS pendientes (las cuentas ya
//      en vuelo terminan igual).
// APIFY_MAX_CONCURRENT se fija ANTES del require de accountStats/metricsRefresh
// (cada uno crea su limitador al cargar, con ese valor).

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_MAX_CONCURRENT = '2';
process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-parallel-refresh-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [] } }, null, 2) + '\n');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
classifier.classifyPost = async (caption) => ({ title: `titulo: ${String(caption).slice(0, 12)}`, sentiment: 'neutral' });
classifier.classifyRelevance = async () => ({ relevant: false });

const db = require('../src/db');
const accountStats = require('../src/accountStats');
const metricsRefresh = require('../src/metricsRefresh');
const { benchmarkLimiter } = accountStats;
const { refreshLimiter } = metricsRefresh;
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
const raw = new DatabaseSync(process.env.MONITORING_DB_PATH);

instagram.isConfigured = () => true;
// Sin esto, con IG_ACTOR=apify computeAccountStats cae al fetchAccountFollowers
// real (los posteos mock de abajo no traen `followers`) e intenta pegarle a
// Apify de verdad. apidojo en cambio lo resuelve gratis desde el posteo, por
// eso el problema no se veía con el actor default.
instagram.fetchAccountFollowers = async () => 1234;

/** Posteo guardado con detected_at controlado, para que quede elegible para benchmark. */
function insertDetected(id, account, detectedDaysAgo = 1) {
  const inserted = db.saveDetectedPost({
    id,
    account,
    url: `https://www.instagram.com/p/${id}/`,
    caption: 'obras',
    matchedReason: 'test',
    likes: 10,
    comments: 2,
    postedAt: iso(50),
    title: 't',
    sentiment: 'neutral',
    postType: null,
    followers: null,
    plataforma: 'instagram',
  });
  assert.equal(inserted, true, `insert ${id}`);
  raw.prepare('UPDATE detected_posts SET detected_at = ? WHERE id = ?').run(iso(detectedDaysAgo), id);
}

/** Muestra determinística de posteos "recientes" para el benchmark de una cuenta (siempre la misma dada la cuenta). */
function sampleFor(account) {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `${account}-b${i}`,
    account,
    url: `https://www.instagram.com/p/${account}-b${i}/`,
    caption: 'muestra',
    hashtagsText: '',
    likes: 100 + i,
    comments: 10 + i,
    postedAt: iso(i + 1),
    postType: 'imagen',
    sourceType: 'account',
    sourceQuery: null,
  }));
}

const ACCOUNTS = ['cuenta1', 'cuenta2', 'cuenta3', 'cuenta4', 'cuenta5', 'cuenta6'];

function clearBenchmarkState() {
  raw.prepare('DELETE FROM account_stats').run();
  for (const account of ACCOUNTS) raw.prepare('DELETE FROM detected_posts WHERE account = ?').run(account);
  // selectAccountsForRecalc procesa por eligibleSince ASCENDENTE (el detectado
  // hace más tiempo primero): cuenta1 con el detected_at más viejo para que
  // sea de las dos primeras en arrancar (limitador en 2), cuenta6 la última.
  ACCOUNTS.forEach((account, i) => insertDetected(`${account}-nuevo`, account, ACCOUNTS.length - i));
}

/** account_stats de las 6 cuentas, sin computed_at (varía entre corridas), para comparar contenido. */
function snapshotStats() {
  return db
    .listAllAccountStats()
    .filter((r) => ACCOUNTS.includes(r.account.toLowerCase()))
    .map(({ account, plataforma, postType, nPosts, medianLikes, medianComments }) => ({
      account: account.toLowerCase(),
      plataforma,
      postType,
      nPosts,
      medianLikes,
      medianComments,
    }))
    .sort((a, b) => a.account.localeCompare(b.account) || String(a.postType).localeCompare(String(b.postType)));
}

describe('Cambio C: benchmark en paralelo (accountStats.refreshStaleAccountStats)', { concurrency: false }, () => {
  test('con el limitador en 2 y 6 cuentas, nunca más de 2 en vuelo a la vez', async () => {
    assert.equal(benchmarkLimiter.limit, 2);
    clearBenchmarkState();

    let inFlight = 0;
    let maxInFlight = 0;
    instagram.scrapeAccount = async (account) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight -= 1;
      return sampleFor(account);
    };

    const result = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 10 });
    assert.equal(maxInFlight, 2, 'nunca más de 2 llamadas de benchmark en vuelo a la vez');
    assert.equal(result.recalculated, 6);
    assert.equal(benchmarkLimiter.inFlight(), 0);
  });

  test('los resultados guardados son iguales que en modo secuencial', async () => {
    // Corrida en paralelo (la real, vía refreshStaleAccountStats).
    clearBenchmarkState();
    instagram.scrapeAccount = async (account) => {
      await sleep(Math.random() * 10); // orden de resolución no determinístico a propósito
      return sampleFor(account);
    };
    await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 10 });
    const parallelSnapshot = snapshotStats();
    // Una fila por tipo ('imagen', 6 posteos >= BENCHMARK_MIN_POSTS) más la
    // fila global (post_type null) por cada una de las 6 cuentas.
    assert.equal(parallelSnapshot.length, 12);

    // Referencia: las mismas 6 cuentas, computadas una por una a mano, sin
    // Promise.allSettled ni limitador de por medio.
    clearBenchmarkState();
    for (const account of ACCOUNTS) {
      await accountStats.computeAccountStats(account, 'instagram');
    }
    const sequentialSnapshot = snapshotStats();

    assert.deepEqual(parallelSnapshot, sequentialSnapshot);
  });

  test('corte por cuota: no se lanzan más benchmarks pendientes, los ya en vuelo terminan', async () => {
    clearBenchmarkState();
    const attempted = [];
    let released = 0;
    instagram.scrapeAccount = async (account) => {
      attempted.push(account);
      if (account === 'cuenta1') {
        await sleep(20);
        const err = new Error('cuota agotada');
        err.code = 'QUOTA_EXCEEDED';
        throw err;
      }
      // El resto tarda más que cuenta1: si el corte funciona, ninguna cuenta
      // que todavía no había arrancado cuando cuenta1 avisó debería llegar a
      // llamar a la fuente.
      await sleep(60);
      released += 1;
      return sampleFor(account);
    };

    const result = await accountStats.refreshStaleAccountStats({ plataformas: ['instagram'], maxPerCycle: 10 });
    assert.equal(result.quotaExceeded, true);
    // Con tope 2: arrancan cuenta1+cuenta2 de entrada; cuenta1 corta la cuota
    // antes de que el resto del pool (cuenta3..6) llegue a lanzarse.
    assert.ok(attempted.length <= 3, `se lanzaron de más tras la cuota: ${attempted.join(', ')}`);
    assert.ok(!attempted.includes('cuenta6'), 'una cuenta al final de la cola no debería haberse lanzado');
  });
});

describe('Cambio C: refresco de métricas en paralelo (metricsRefresh.refreshPostMetrics)', { concurrency: false }, () => {
  function seedRefreshables() {
    raw.prepare('DELETE FROM account_stats').run();
    for (const account of ACCOUNTS) raw.prepare('DELETE FROM detected_posts WHERE account = ?').run(account);
    // posted_at reciente (tramo caliente): siempre elegible para refresco, sin gate de tramo.
    ACCOUNTS.forEach((account, i) => {
      db.saveDetectedPost({
        id: `${account}-hot`,
        account,
        url: `https://www.instagram.com/p/${account}-hot/`,
        caption: 'obras',
        matchedReason: 'test',
        likes: 1,
        comments: 1,
        postedAt: new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(),
        title: 't',
        sentiment: 'neutral',
        postType: null,
        followers: null,
        plataforma: 'instagram',
      });
    });
  }

  test('con el limitador en 2 y 6 cuentas, nunca más de 2 en vuelo a la vez', async () => {
    seedRefreshables();
    let inFlight = 0;
    let maxInFlight = 0;
    instagram.scrapeAccount = async (account) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight -= 1;
      return [{ id: `${account}-hot`, account, likes: 5, comments: 5, postType: null }];
    };

    const result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.equal(maxInFlight, 2, 'nunca más de 2 llamadas de refresco en vuelo a la vez');
    assert.equal(result.accountsChecked, 6);
    assert.equal(refreshLimiter.inFlight(), 0);
  });

  test('corte por cuota: no se lanzan más refrescos pendientes', async () => {
    seedRefreshables();
    const attempted = [];
    instagram.scrapeAccount = async (account) => {
      attempted.push(account);
      if (account === 'cuenta1') {
        await sleep(20);
        const err = new Error('cuota agotada');
        err.code = 'QUOTA_EXCEEDED';
        throw err;
      }
      await sleep(60);
      return [{ id: `${account}-hot`, account, likes: 5, comments: 5, postType: null }];
    };

    const result = await metricsRefresh.refreshPostMetrics({ plataformas: ['instagram'] });
    assert.equal(result.quotaExceeded, true);
    assert.ok(attempted.length <= 3, `se lanzaron de más tras la cuota: ${attempted.join(', ')}`);
    assert.ok(!attempted.includes('cuenta6'), 'una cuenta al final de la cola no debería haberse lanzado');
  });
});
