'use strict';

// Timeout por request y reintento único ante fallos transitorios del LLM
// (src/llm/openrouterProvider.js), sin red: global.fetch stubeado. Un 503 o
// un corte de red se reintenta una vez; un 401 no; una respuesta que no
// llega en timeoutMs se aborta y cuenta como transitoria. Y el clasificador
// del monitoreo pide su timeout de 60 s.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LLM_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'clave-de-test';
process.env.LLM_RETRY_DELAY_MS = '5'; // que el reintento no espere 3 s en los tests
process.env.APIFY_API_TOKEN = 'token-de-test';
delete process.env.OPENROUTER_MODEL;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-llm-reintento-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const openrouter = require('../src/llm/openrouterProvider');
const llm = require('../src/llm');
const classifier = require('../src/classifier');

const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
const CONTENIDO_OK = { choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };

function respuesta(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** fetch stubeado con una secuencia de respuestas; cada entrada es un objeto respuesta, un Error para tirar, o 'colgado' (nunca responde, respeta el abort). */
function stubFetch(secuencia) {
  const llamadas = [];
  global.fetch = (url, opts) => {
    llamadas.push({ url, opts });
    const paso = secuencia[llamadas.length - 1] ?? secuencia[secuencia.length - 1];
    if (paso === 'colgado') {
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    if (paso instanceof Error) return Promise.reject(paso);
    return Promise.resolve(paso);
  };
  return llamadas;
}

function pedir(extra = {}) {
  return openrouter.requestStructuredAnalysis({ system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'test', timeoutMs: 1000, ...extra });
}

describe('OpenRouter: timeout y reintento ante fallos transitorios', { concurrency: false }, () => {
  const originales = { fetch: global.fetch, warn: console.warn, error: console.error };
  let avisos;
  beforeEach(() => {
    avisos = [];
    console.warn = (...args) => avisos.push(args.join(' '));
    console.error = () => {};
  });
  afterEach(() => {
    global.fetch = originales.fetch;
    console.warn = originales.warn;
    console.error = originales.error;
  });

  test('un 503 y después OK: reintenta una vez y devuelve el resultado', async () => {
    const llamadas = stubFetch([respuesta(503, { error: { message: 'upstream caído' } }), respuesta(200, CONTENIDO_OK)]);
    const { parsed } = await pedir();
    assert.deepEqual(parsed, { ok: true });
    assert.equal(llamadas.length, 2);
    assert.ok(avisos.some((a) => /fallo transitorio \(503\)/.test(a)), 'avisa del reintento');
  });

  test('dos 503 seguidos: falla después del único reintento', async () => {
    const llamadas = stubFetch([respuesta(503, {}), respuesta(503, {})]);
    await assert.rejects(pedir(), (err) => {
      assert.equal(err.isApiFailure, true);
      assert.equal(err.status, 503);
      return true;
    });
    assert.equal(llamadas.length, 2, 'un reintento, no más');
  });

  test('un 429 se reintenta; un 401 no', async () => {
    let llamadas = stubFetch([respuesta(429, { error: { message: 'rate limited' } }), respuesta(200, CONTENIDO_OK)]);
    await pedir();
    assert.equal(llamadas.length, 2);

    llamadas = stubFetch([respuesta(401, { error: { message: 'bad key' } })]);
    await assert.rejects(pedir(), (err) => {
      assert.match(err.userMessage, /OPENROUTER_API_KEY/);
      return true;
    });
    assert.equal(llamadas.length, 1, 'la clave no va a cambiar en tres segundos');
  });

  test('corte de red (fetch tira) se reintenta una vez', async () => {
    const llamadas = stubFetch([new TypeError('fetch failed'), respuesta(200, CONTENIDO_OK)]);
    const { parsed } = await pedir();
    assert.deepEqual(parsed, { ok: true });
    assert.equal(llamadas.length, 2);
  });

  test('sin respuesta en timeoutMs: aborta la request, reintenta una vez y falla con mensaje claro', async () => {
    const llamadas = stubFetch(['colgado']);
    await assert.rejects(pedir({ timeoutMs: 30 }), (err) => {
      assert.equal(err.isApiFailure, true);
      assert.match(err.message, /no respondió en 30 ms/);
      assert.match(err.userMessage, /tardó demasiado/);
      return true;
    });
    assert.equal(llamadas.length, 2);
    assert.ok(llamadas.every((l) => l.opts.signal && l.opts.signal.aborted), 'cada intento se abortó por su propio timer');
  });

  test('requestText también lleva timeout y reintento', async () => {
    const llamadas = stubFetch([respuesta(502, {}), respuesta(200, { choices: [{ message: { content: 'hola' } }] })]);
    const { text } = await openrouter.requestText({ system: 's', userPrompt: 'u', timeoutMs: 1000 });
    assert.equal(text, 'hola');
    assert.equal(llamadas.length, 2);
  });

  test('requestText de la fachada trae el costo estimado, como el análisis (la subcategoría de los reclamos)', async () => {
    process.env.LLM_INPUT_USD_PER_MTOK = '2';
    process.env.LLM_OUTPUT_USD_PER_MTOK = '8';
    try {
      stubFetch([respuesta(200, { choices: [{ message: { content: 'hola' } }], usage: { prompt_tokens: 1000000, completion_tokens: 1000000, total_tokens: 2000000 } })]);
      const { usage } = await llm.requestText({ system: 's', userPrompt: 'u', timeoutMs: 1000 });
      assert.equal(usage.costSource, 'estimate_env');
      assert.ok(Math.abs(usage.costUsd - 10) < 1e-9);
    } finally {
      delete process.env.LLM_INPUT_USD_PER_MTOK;
      delete process.env.LLM_OUTPUT_USD_PER_MTOK;
    }
  });
});

describe('OpenRouter: respuesta cortada por el tope de salida y lo gastado en los errores', { concurrency: false }, () => {
  const originales = { fetch: global.fetch, warn: console.warn, error: console.error };
  beforeEach(() => {
    console.warn = () => {};
    console.error = () => {};
  });
  afterEach(() => {
    global.fetch = originales.fetch;
    console.warn = originales.warn;
    console.error = originales.error;
  });
  // Como en la corrida real del 24/10/2026: el razonamiento llenó el tope y el contenido vino vacío.
  const CORTADA = { choices: [{ finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', message: { content: '' } }], usage: { prompt_tokens: 6000, completion_tokens: 12000, total_tokens: 18000 } };
  const INVALIDA = { choices: [{ finish_reason: 'stop', message: { content: '{"ok": tr' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };

  test('cortada: no se reintenta igual, tira SALIDA_CORTADA con lo gastado', async () => {
    const llamadas = stubFetch([respuesta(200, CORTADA), respuesta(200, CONTENIDO_OK)]);
    await assert.rejects(pedir({ maxTokens: 12000 }), (err) => {
      assert.equal(err.code, 'SALIDA_CORTADA');
      assert.match(err.message, /12000 tokens/);
      assert.ok(err.userMessage);
      assert.equal(err.tokenUsage.totalTokens, 18000);
      return true;
    });
    assert.equal(llamadas.length, 1, 'otro intento igual se cortaría igual');
  });

  test('JSON inválido dos veces: dos intentos, y el error lleva lo de los dos', async () => {
    const llamadas = stubFetch([respuesta(200, INVALIDA), respuesta(200, INVALIDA)]);
    await assert.rejects(pedir(), (err) => {
      assert.match(err.message, /contenido vacío o JSON inválido/);
      assert.equal(err.tokenUsage.totalTokens, 30);
      return true;
    });
    assert.equal(llamadas.length, 2);
  });

  test('un intento inválido y después un 402: el error del 402 lleva lo del primero', async () => {
    stubFetch([respuesta(200, INVALIDA), respuesta(402, { error: { message: 'Insufficient credits' } })]);
    await assert.rejects(pedir(), (err) => {
      assert.ok(err.userMessage);
      assert.equal(err.tokenUsage.totalTokens, 15);
      return true;
    });
  });

  test('por la fachada, lo gastado en el error lleva su costo estimado', async () => {
    process.env.LLM_INPUT_USD_PER_MTOK = '2';
    process.env.LLM_OUTPUT_USD_PER_MTOK = '10';
    try {
      stubFetch([respuesta(200, CORTADA)]);
      await assert.rejects(llm.requestStructuredAnalysis({ system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'test', timeoutMs: 1000 }), (err) => {
        assert.equal(err.code, 'SALIDA_CORTADA');
        assert.equal(err.tokenUsage.costSource, 'estimate_env');
        assert.ok(Math.abs(err.tokenUsage.costUsd - (6000 * 2 + 12000 * 10) / 1e6) < 1e-9);
        return true;
      });
    } finally {
      delete process.env.LLM_INPUT_USD_PER_MTOK;
      delete process.env.LLM_OUTPUT_USD_PER_MTOK;
    }
  });
});

describe('Anthropic: respuesta cortada por el tope de salida y lo gastado en los errores', { concurrency: false }, () => {
  // El cliente del proveedor es interno: se reemplaza create (la llamada a
  // la API) en el prototipo de Messages, que comparten todos; lo demás es el
  // código real.
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = require('../src/llm/anthropicProvider');
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'clave-de-test' }).messages);
  const originales = { create: proto.create, warn: console.warn, error: console.error };
  let respuestas;
  let llamadas;
  beforeEach(() => {
    llamadas = 0;
    console.warn = () => {};
    console.error = () => {};
    proto.create = async () => respuestas[Math.min(llamadas++, respuestas.length - 1)];
  });
  afterEach(() => {
    proto.create = originales.create;
    console.warn = originales.warn;
    console.error = originales.error;
  });
  const pedirA = () => anthropic.requestStructuredAnalysis({ system: 's', userPrompt: 'u', schema: SCHEMA, maxTokens: 16000 });
  const texto = (t) => [{ type: 'text', text: t }];

  test('cortada con un JSON a medias (lo que de verdad llega): no se reintenta, tira SALIDA_CORTADA con lo gastado', async () => {
    respuestas = [{ stop_reason: 'max_tokens', content: texto('{"ok": tr'), usage: { input_tokens: 5000, output_tokens: 16000 } }];
    await assert.rejects(pedirA(), (err) => {
      assert.equal(err.code, 'SALIDA_CORTADA');
      assert.equal(err.tokenUsage.outputTokens, 16000);
      return true;
    });
    assert.equal(llamadas, 1);
  });

  test('JSON inválido dos veces (no cortada): dos intentos, y el error lleva lo de los dos', async () => {
    respuestas = [{ stop_reason: 'end_turn', content: texto('no es JSON'), usage: { input_tokens: 10, output_tokens: 5 } }];
    await assert.rejects(pedirA(), (err) => {
      assert.equal(err.tokenUsage.totalTokens, 30);
      return true;
    });
    assert.equal(llamadas, 2);
  });

  test('una respuesta buena: el JSON del bloque de texto y su uso', async () => {
    respuestas = [{ stop_reason: 'end_turn', content: texto('{"ok": true}'), usage: { input_tokens: 10, output_tokens: 5 } }];
    const { parsed, usage } = await pedirA();
    assert.deepEqual(parsed, { ok: true });
    assert.equal(usage.totalTokens, 15);
  });
});

describe('clasificarPosteo pide su timeout', { concurrency: false }, () => {
  test('60 s por llamada, pasado por la fachada src/llm', async () => {
    const original = llm.requestStructuredAnalysis;
    const recibido = [];
    llm.requestStructuredAnalysis = async (req) => {
      recibido.push(req);
      return { parsed: { relevant: true, title: 't', sentiment: 'neutral', motivo: 'm' }, usage: null };
    };
    try {
      const r = await classifier.clasificarPosteo('Jorge Macri inauguró una plaza');
      assert.equal(r.relevant, true);
      assert.equal(recibido.length, 1);
      assert.equal(recibido[0].timeoutMs, 60000);
    } finally {
      llm.requestStructuredAnalysis = original;
    }
  });
});
