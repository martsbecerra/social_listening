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
