'use strict';

// Cola global de runs simultáneos de Apify (src/concurrencyLimiter.js +
// runActorSync en src/apify.js): nunca más de APIFY_MAX_CONCURRENT llamadas
// en vuelo, orden de llegada, resultados que corresponden a su input, y el
// único reintento del 402 concurrent-runs-limit-exceeded. Sin red: fetch
// stubeado. Los env se fijan ANTES del require porque apify.js los lee al
// cargar (cada archivo de test es un proceso aparte).

process.env.APIFY_MAX_CONCURRENT = '2';
process.env.APIFY_RETRY_DELAY_MS = '20';
process.env.APIFY_API_TOKEN = 'token-de-test';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter } = require('../src/concurrencyLimiter');
const { runActorSync, apifyLimiter, APIFY_MAX_CONCURRENT } = require('../src/apify');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const respond = (status, text = '', items = []) => ({
  ok: status < 400,
  status,
  text: async () => text,
  json: async () => items,
});
const BODY_CONCURRENT = JSON.stringify({
  error: { type: 'concurrent-runs-limit-exceeded', message: 'You have exceeded the maximum number of concurrent runs' },
});

describe('apify: cola de runs simultáneos', { concurrency: false }, () => {
  test('createLimiter: nunca más de max en vuelo, arranque en orden de llegada, cada resultado en su lugar, un fallo libera el lugar', async () => {
    const limiter = createLimiter(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const started = [];
    // Las primeras tardan más que las últimas: el resultado de cada una tiene
    // que quedar en su posición aunque terminen en otro orden.
    const task = (i, fail = false) => async () => {
      started.push(i);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15 + (5 - i) * 4);
      inFlight -= 1;
      if (fail) throw new Error(`falló ${i}`);
      return `r${i}`;
    };

    const results = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => limiter.run(task(i, i === 2))));
    assert.equal(maxInFlight, 2);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value : `rechazado: ${r.reason.message}`)),
      ['r0', 'r1', 'rechazado: falló 2', 'r3', 'r4', 'r5']
    );
    assert.equal(limiter.inFlight(), 0);
    assert.equal(limiter.pending(), 0);
    assert.equal(limiter.limit, 2);
    // Un tope inválido nunca significa "sin límite".
    assert.equal(createLimiter(0).limit, 1);
    assert.equal(createLimiter('nada').limit, 1);
    assert.equal(createLimiter(2.9).limit, 2);
  });

  test('runActorSync: con el tope en 2 y 6 llamadas, nunca hay más de 2 en vuelo y cada resultado es el de su input', async () => {
    assert.equal(APIFY_MAX_CONCURRENT, 2);
    assert.equal(apifyLimiter.limit, 2);
    const originalFetch = global.fetch;
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    global.fetch = async (url, { body }) => {
      assert.match(url, /run-sync-get-dataset-items\?token=token-de-test$/);
      const { n } = JSON.parse(body);
      order.push(n);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10 + (6 - n) * 5); // las primeras tardan más
      inFlight -= 1;
      return respond(200, '', [{ n }]);
    };
    try {
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => runActorSync({ n }, { actorId: 'apify~instagram-scraper' })));
      assert.equal(maxInFlight, 2);
      assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
      assert.deepEqual(results.map((items) => items[0].n), [1, 2, 3, 4, 5, 6]);
      assert.equal(apifyLimiter.inFlight(), 0);
      assert.equal(apifyLimiter.pending(), 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('402 concurrent-runs-limit-exceeded: se reintenta una vez; si persiste, RATE_LIMITED; otros 402 no reintentan; la cola sigue viva', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    try {
      // Una vez 402 y después 200: resuelve, con exactamente dos intentos y la espera en el medio.
      calls = 0;
      global.fetch = async () => (calls++ === 0 ? respond(402, BODY_CONCURRENT) : respond(200, '', [{ ok: true }]));
      const t0 = Date.now();
      assert.deepEqual(await runActorSync({}, { actorId: 'apify~instagram-scraper' }), [{ ok: true }]);
      assert.equal(calls, 2);
      assert.ok(Date.now() - t0 >= 15, 'esperó APIFY_RETRY_DELAY_MS antes de reintentar');

      // 402 las dos veces: rechaza con code y mensaje propios, y no sigue intentando.
      calls = 0;
      global.fetch = async () => {
        calls += 1;
        return respond(402, BODY_CONCURRENT);
      };
      await assert.rejects(runActorSync({}, { actorId: 'apify~instagram-scraper' }), (err) => {
        assert.equal(err.code, 'RATE_LIMITED');
        assert.match(err.userMessage, /runs simultáneos/);
        assert.match(err.message, /Apify respondió 402/);
        return true;
      });
      assert.equal(calls, 2);

      // 402 de otro tipo: sin reintento, sin code, mensaje del 402 genérico.
      calls = 0;
      global.fetch = async () => {
        calls += 1;
        return respond(402, '{"error":{"type":"actor-memory-limit-exceeded","message":"Memory limit exceeded"}}');
      };
      await assert.rejects(runActorSync({}, { actorId: 'apify~instagram-scraper' }), (err) => {
        assert.equal(err.code, undefined);
        assert.match(err.userMessage, /límites del plan \(402\)/);
        return true;
      });
      assert.equal(calls, 1);

      // Después de errores la cola quedó libre y sigue atendiendo.
      global.fetch = async () => respond(200, '', [1]);
      assert.deepEqual(await runActorSync({}, { actorId: 'apify~instagram-scraper' }), [1]);
      assert.equal(apifyLimiter.inFlight(), 0);
      assert.equal(apifyLimiter.pending(), 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
