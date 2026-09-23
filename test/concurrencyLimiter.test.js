'use strict';

// Cambio G: diagnóstico del cuelgue real de ~30 min en "Actualizar ahora".
//
//   1. createLimiter libera el cupo aunque la tarea tire SINCRÓNICAMENTE
//      (antes de devolver una promesa), no solo si rechaza.
//   2. La causa real del cuelgue: benchmark/refresco (Cambio C) envolvían
//      cada cuenta en el MISMO apifyLimiter que usa runActorSync más
//      adentro. Con maxPerCycle cuentas en vuelo ocupando TODOS los cupos
//      del limitador, ninguna llega a conseguir un cupo para su propia
//      llamada real: deadlock. Se prueba acá reproduciendo ese anidamiento
//      directo sobre createLimiter (sin Apify real) y confirmando que con
//      capas SEPARADAS (el arreglo en accountStats.js/metricsRefresh.js) no
//      pasa.
//   3. El timeout de seguridad de runActorSync (APIFY_CALL_TIMEOUT_MS):
//      libera el cupo y registra 'TIMEOUT' sin colgar el resto.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-concurrency-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter } = require('../src/concurrencyLimiter');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('concurrencyLimiter: liberación de cupo', () => {
  test('una tarea que tira SINCRÓNICAMENTE (antes de devolver una promesa) libera el cupo igual', async () => {
    const limiter = createLimiter(1, 'sync-throw');
    const throwing = () => {
      throw new Error('explota antes de devolver nada');
    };

    await assert.rejects(limiter.run(throwing), /explota antes de devolver nada/);

    // Prueba real de que el cupo se liberó: con límite 1, esta segunda
    // tarea SOLO puede terminar si el cupo de la que tiró ya se soltó — si
    // hubiera quedado tomado para siempre, este await nunca resolvería
    // (leer inFlight() en el instante exacto después del await anterior es
    // frágil: el .finally() que descuenta el cupo puede correr un tick de
    // microtareas después de que se resuelva el await de quien llama).
    const result = await limiter.run(async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(limiter.inFlight(), 0);
    assert.equal(limiter.pending(), 0);
  });

  test('varias tareas sincrónicas que tiran seguidas no dejan cupos tomados', async () => {
    const limiter = createLimiter(2, 'sync-throw-multi');
    const tasks = [0, 1, 2, 3, 4].map((i) =>
      limiter.run(() => {
        if (i % 2 === 0) throw new Error(`sync ${i}`);
        return i;
      })
    );
    const settled = await Promise.allSettled(tasks);
    assert.deepEqual(
      settled.map((s) => (s.status === 'fulfilled' ? s.value : 'rejected')),
      ['rejected', 1, 'rejected', 3, 'rejected']
    );
    assert.equal(limiter.inFlight(), 0);
    assert.equal(limiter.pending(), 0);
  });
});

describe('concurrencyLimiter: deadlock por anidamiento (la causa real del cuelgue de ~30 min)', () => {
  // Simula lo que hacía benchmark/refresco: envolver la tarea de "cuenta"
  // en un limitador, cuando la propia tarea (más adentro, en la fuente
  // real) TAMBIÉN pide un cupo — la pregunta es si es el MISMO limitador o
  // uno separado.
  function innerRealCall(sharedLimiter, target) {
    return sharedLimiter.run(() => sleep(10).then(() => `inner:${target}`), target);
  }

  test('reproduce el bug: la MISMA instancia en las dos capas cuelga (nunca termina)', async () => {
    const sharedLimiter = createLimiter(2, 'shared-buggy');
    const accounts = ['a', 'b', 'c', 'd', 'e', 'f'];

    // Cada "tarea de cuenta" ocupa un cupo de sharedLimiter y, adentro,
    // vuelve a pedir OTRO cupo del mismo limitador para su llamada real.
    const allDone = Promise.all(
      accounts.map((account) => sharedLimiter.run(() => innerRealCall(sharedLimiter, account), account))
    );

    const raced = await Promise.race([allDone.then(() => 'completó'), sleep(300).then(() => 'seguía colgado')]);
    assert.equal(raced, 'seguía colgado', 'con la MISMA instancia anidada, el deadlock es real y no se destraba solo');
  });

  test('el arreglo: capas SEPARADAS (una para la cuenta, otra para la llamada real) no cuelga', async () => {
    const taskLimiter = createLimiter(2, 'task-fixed'); // equivalente a benchmarkLimiter/refreshLimiter
    const apiLimiter = createLimiter(2, 'api-fixed'); // equivalente al apifyLimiter de runActorSync
    const accounts = ['a', 'b', 'c', 'd', 'e', 'f'];

    const allDone = Promise.all(accounts.map((account) => taskLimiter.run(() => innerRealCall(apiLimiter, account), account)));

    const raced = await Promise.race([allDone.then((r) => r), sleep(300).then(() => 'seguía colgado')]);
    assert.notEqual(raced, 'seguía colgado', 'con limitadores separados termina bien, no cuelga');
    assert.deepEqual(new Set(raced), new Set(accounts.map((a) => `inner:${a}`)));
    assert.equal(taskLimiter.inFlight(), 0);
    assert.equal(apiLimiter.inFlight(), 0);
  });
});

describe('concurrencyLimiter: activeTargets (para el heartbeat del ciclo)', () => {
  test('lista las tareas en vuelo con su target y tiempo transcurrido', async () => {
    const limiter = createLimiter(2, 'heartbeat-demo');
    const p1 = limiter.run(() => sleep(60), '@cuenta1');
    const p2 = limiter.run(() => sleep(60), '@cuenta2');
    await sleep(10);
    const activeAtStart = limiter.activeTargets();
    assert.equal(activeAtStart.length, 2);
    assert.deepEqual(
      activeAtStart.map((a) => a.target).sort(),
      ['@cuenta1', '@cuenta2']
    );
    assert.ok(activeAtStart.every((a) => a.elapsedMs >= 0));
    await Promise.all([p1, p2]);
    assert.deepEqual(limiter.activeTargets(), []);
  });
});

describe('runActorSync: timeout de seguridad (APIFY_CALL_TIMEOUT_MS)', () => {
  // APIFY_CALL_TIMEOUT_MS tiene un piso de 1000ms (ver apify.js: nunca
  // "todas las llamadas fallan solas" por un .env mal puesto), así que el
  // mock de fetch tarda un poco MÁS que eso en resolver — igual demuestra
  // que runActorSync no espera ese fetch, corta antes por su cuenta — y
  // JAMÁS queda sin resolver del todo: dejarlo colgado para siempre deja
  // vivo el AbortController/setTimeout de 5 minutos de apifyRequest (su
  // finally, que lo limpia, no llega a correr nunca), lo que mantiene el
  // proceso de test abierto de más aunque las aserciones ya hayan pasado.
  test('un fetch lento corta a los ms configurados, libera el cupo y registra TIMEOUT; la cola sigue viva', async () => {
    process.env.APIFY_CALL_TIMEOUT_MS = '1000';
    delete require.cache[require.resolve('../src/apify')];
    const { runActorSync, apifyLimiter } = require('../src/apify');

    const originalFetch = global.fetch;
    global.fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => '', json: async () => [] }), 1400));
    try {
      const t0 = Date.now();
      await assert.rejects(runActorSync({ directUrls: ['https://x/p/1/'] }, { actorId: 'apify~instagram-scraper' }), (err) => {
        assert.equal(err.code, 'TIMEOUT');
        return true;
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 1400, `cortó antes de que el fetch lento resolviera (tardó ${elapsed}ms)`);
      assert.equal(apifyLimiter.inFlight(), 0, 'el cupo se liberó pese al timeout');
      await sleep(500); // deja que el fetch lento de arriba termine de resolver en paz, sin handles sueltos
    } finally {
      global.fetch = originalFetch;
    }

    // La cola sigue viva: una llamada normal después del timeout funciona.
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '', json: async () => [{ ok: true }] });
    try {
      const items = await runActorSync({ directUrls: ['https://x/p/2/'] }, { actorId: 'apify~instagram-scraper' });
      assert.deepEqual(items, [{ ok: true }]);
    } finally {
      global.fetch = originalFetch;
      delete process.env.APIFY_CALL_TIMEOUT_MS;
    }
  });
});
