'use strict';

// Imágenes en el mensaje de usuario (src/llm/imagenes.js, rama
// clasificacion-foto-y-exclusiones): la forma del pedido en OpenRouter (texto
// y data URL) y en Anthropic (bloque de imagen base64 y después el texto);
// sin imágenes, el mensaje sigue siendo texto; lo que no es una imagen en
// base64 de un tipo permitido no se manda. Sin red: fetch y el create del
// SDK stubeados.

process.env.OPENROUTER_API_KEY = 'clave-de-test';
process.env.ANTHROPIC_API_KEY = 'clave-de-test';
process.env.LLM_RETRY_DELAY_MS = '1';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const imagenes = require('../src/llm/imagenes');
const openrouter = require('../src/llm/openrouterProvider');
const anthropic = require('../src/llm/anthropicProvider');

const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
const FOTO = { mediaType: 'image/jpeg', data: Buffer.from('jpeg de prueba').toString('base64') };

describe('normalizarImagenes', () => {
  test('solo imágenes en base64 de tipos permitidos, hasta 4; nunca un link', () => {
    assert.deepEqual(imagenes.normalizarImagenes(null), []);
    assert.deepEqual(imagenes.normalizarImagenes([FOTO]), [FOTO]);
    const malas = [
      { mediaType: 'image/gif', data: FOTO.data },
      { mediaType: 'image/svg+xml', data: FOTO.data },
      { mediaType: 'image/jpeg', data: 'https://scontent.cdninstagram.com/foto.jpg' },
      { mediaType: 'image/jpeg', data: '' },
      null,
    ];
    assert.deepEqual(imagenes.normalizarImagenes(malas), []);
    assert.equal(imagenes.normalizarImagenes(Array(6).fill(FOTO)).length, 4);
  });
});

describe('OpenRouter', { concurrency: false }, () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function capturar() {
    const cuerpos = [];
    global.fetch = async (url, opts) => {
      cuerpos.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });
    };
    return cuerpos;
  }

  test('con una imagen: el mensaje de usuario es [texto, image_url con data URL]', async () => {
    const cuerpos = capturar();
    const r = await openrouter.requestStructuredAnalysis({ system: 's', userPrompt: 'POSTEO:\nhola', schema: SCHEMA, schemaName: 'x', maxTokens: 100, images: [FOTO] });
    assert.deepEqual(r.parsed, { ok: true });
    assert.deepEqual(cuerpos[0].messages[1], {
      role: 'user',
      content: [
        { type: 'text', text: 'POSTEO:\nhola' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${FOTO.data}` } },
      ],
    });
  });

  test('sin imágenes, el mensaje sigue siendo texto', async () => {
    const cuerpos = capturar();
    await openrouter.requestStructuredAnalysis({ system: 's', userPrompt: 'hola', schema: SCHEMA, maxTokens: 100 });
    assert.equal(cuerpos[0].messages[1].content, 'hola');
  });
});

describe('Anthropic', { concurrency: false }, () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'clave-de-test' }).messages);
  const originalCreate = proto.create;
  afterEach(() => {
    proto.create = originalCreate;
  });

  test('con una imagen: bloque image base64 y después el texto; sin imágenes, texto', async () => {
    const pedidos = [];
    proto.create = async (params) => {
      pedidos.push(params);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 2 } };
    };
    await anthropic.requestStructuredAnalysis({ system: 's', userPrompt: 'POSTEO:\nhola', schema: SCHEMA, maxTokens: 100, images: [FOTO] });
    assert.deepEqual(pedidos[0].messages[0].content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: FOTO.data } },
      { type: 'text', text: 'POSTEO:\nhola' },
    ]);
    await anthropic.requestStructuredAnalysis({ system: 's', userPrompt: 'hola', schema: SCHEMA, maxTokens: 100 });
    assert.equal(pedidos[1].messages[0].content, 'hola');
  });
});
