'use strict';

// REQ-PRO-14: el schema v2 contra lo que de verdad devolvieron el actor
// oficial y el modelo en la corrida autorizada del 24/10/2026 (una
// publicación, un carrusel con 385 comentarios según Instagram; el actor
// devolvió 155 ítems, 150 con texto). En esa corrida, con tandas de 100, la
// primera se cortó en el tope de salida (dos veces) y solo respondió la
// segunda: 50 comentarios, que definieron los temas. Los fixtures están
// anonimizados (scratchpad/anonimizar-f.js): sin usuarios, textos, ids ni
// links reales; del modelo quedan los números, los booleanos, las
// enumeraciones y los ids de comentarios, y sus textos se reemplazaron.
// fetch simulado, el modelo stubeado con esas respuestas y base y fotos en
// temporales: ni Apify ni el LLM ni data/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-fixture-f-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.MONITORING_MEDIA_DIR = path.join(tmp, 'media');
process.env.APIFY_API_TOKEN = 'token-de-test';
delete process.env.COMMENTS_LIMIT;
delete process.env.COMMENTS_ANALYSIS_LIMIT;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const apify = require('../src/apify');
const llm = require('../src/llm');
const clasificarReclamo = require('../src/clasificarReclamo');
const geoWorker = require('../src/geoWorker');
const postImages = require('../src/postImages');
const analysisJob = require('../src/analysisJob');
const { BATCH_SIZE, BATCH_MAX_TOKENS } = require('../src/analyzeComments');
const { normalizeBatchClassifications, normalizeTemasDeTanda, normalizeSynthesis } = require('../src/validateAnalysis');
const { POSTURAS } = require('../src/analysisSchema');

const leer = (...partes) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', ...partes), 'utf8'));
const PUBLICACION = leer('apify', 'analisis-f-publicacion.json');
const COMENTARIOS = leer('apify', 'analisis-f-comentarios.json');
const TANDA = leer('llm', 'analisis-f-tanda.json');
const SINTESIS = leer('llm', 'analisis-f-sintesis.json');
const URL_POST = 'https://www.instagram.com/p/PRUEBA1/';
const TONOS = ['positivo', 'neutral', 'negativo', 'ruido'];

const verificados = () => COMENTARIOS.filter((c) => c.owner.is_verified).map((c) => c.ownerUsername);

describe('lo que devolvió el actor oficial (corrida F)', () => {
  test('la publicación: un carrusel con 385 comentarios según Instagram', () => {
    assert.equal(PUBLICACION.length, 1);
    const p = PUBLICACION[0];
    assert.deepEqual([p.type, p.productType, p.commentsCount, p.likesCount], ['Sidecar', 'carousel_container', 385, 3799]);
    assert.equal(p.childPosts.length, 2);
  });

  test('155 ítems: solo los de primer nivel; 5 sin texto (traen media: un GIF); 2 verificados en owner.is_verified', () => {
    assert.equal(COMENTARIOS.length, 155);
    const sinTexto = COMENTARIOS.filter((c) => !c.text);
    assert.equal(sinTexto.length, 5);
    assert.ok(sinTexto.every((c) => c.media && typeof c.media === 'object'));
    assert.ok(COMENTARIOS.every((c) => c.replies === null && c.repliesCount === null && c.postUrl === URL_POST));
    assert.equal(verificados().length, 2);
  });

  test('normalizar: los 5 sin texto quedan afuera; 150 de 385, carrusel', () => {
    assert.equal(apify.normalizeComments(COMENTARIOS).length, 150);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const { post, comments } = apify.buildAnalysisData(PUBLICACION, COMENTARIOS, URL_POST, 300);
      assert.deepEqual([post.postType, post.commentsCount, comments.length], ['carrusel', 385, 150]);
    } finally {
      console.warn = warn;
    }
  });
});

describe('lo que respondió el modelo valida contra el schema v2', () => {
  test('la tanda: 50 clasificaciones con los cinco campos y 10 temas', () => {
    const filas = normalizeBatchClassifications(TANDA.parsed.classifications, TANDA.usuarios.length);
    assert.equal(filas.length, 50);
    assert.ok(filas.every(Boolean), 'devolvió las 50');
    for (const f of filas) {
      assert.ok(TONOS.includes(f.sentiment), f.sentiment);
      assert.ok(POSTURAS.includes(f.postura), f.postura);
      assert.equal(typeof f.sobrePosteo, 'boolean');
      assert.equal(typeof f.pedido, 'boolean');
      assert.ok(Number.isInteger(f.tema) && f.tema >= 0 && f.tema <= 10);
    }
    assert.equal(normalizeTemasDeTanda(TANDA.parsed.temas).length, 10);
    assert.equal(TANDA.definioTemas, true);
  });

  test('el tope de salida: el razonamiento cuenta (50 comentarios, 10.653 tokens) y una tanda de 100 se cortaba', () => {
    // El JSON de la respuesta ocupa una fracción: el resto es razonamiento.
    assert.ok(TANDA.usage.outputTokens > 4 * Math.ceil(JSON.stringify(TANDA.parsed).length / 4));
    assert.deepEqual(TANDA.laQueSeCorto.map((x) => [x.comentarios, x.maxTokens, x.intentos]), [[100, 12000, 2]]);
    assert.ok((TANDA.usage.outputTokens / 50) * 100 > 12000, 'a ese ritmo, 100 comentarios no entraban en 12.000');
    assert.ok((TANDA.usage.outputTokens / 50) * BATCH_SIZE < BATCH_MAX_TOKENS * 0.75, 'una tanda de hoy entra con margen');
  });

  test('la síntesis: sin hecho dominante, 8 pedidos con números que existen, ninguna figura sugerida', () => {
    const s = normalizeSynthesis(SINTESIS.parsed, {
      temasValidos: new Set(Array.from({ length: 10 }, (_, i) => i + 1)),
      comentariosValidos: new Set(Array.from({ length: 50 }, (_, i) => 101 + i)),
      verificadosSinFicha: new Set(verificados()),
    });
    assert.equal(s.hecho, null);
    assert.equal(s.pedidos.length, 8);
    assert.deepEqual(
      s.pedidos.map((p) => p.ids.length),
      [1, 1, 1, 1, 1, 1, 1, 2]
    );
    assert.deepEqual(s.figurasSugeridas, []);
  });
});

describe('el análisis entero, como en la corrida', { concurrency: false }, () => {
  const realFetch = global.fetch;
  const consola = { log: console.log, warn: console.warn, error: console.error };
  const CORTADA = { inputTokens: 6000, outputTokens: BATCH_MAX_TOKENS, totalTokens: 6000 + BATCH_MAX_TOKENS, costUsd: 0.17 };
  const llamadas = [];
  before(() => {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    global.fetch = async (url, opts) => {
      if (!String(url).includes('api.apify.com')) throw new Error(`sin red: ${url}`);
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify(body.resultsType === 'posts' ? PUBLICACION : COMENTARIOS), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    // La tanda con los mismos usuarios que la que respondió, su respuesta
    // real; las otras se cortan por el tope (y sus mitades fallan), así
    // quedan los 50 clasificados de la corrida.
    llm.requestStructuredAnalysis = async ({ schemaName, userPrompt }) => {
      if (schemaName === 'tanda_instagram') {
        const etiqueta = /tanda ([\d.]+) de/.exec(userPrompt)[1];
        const usuarios = [...userPrompt.matchAll(/^\d+\. @(\S+?)(?: \[VERIFICADA\])? \(/gm)].map((m) => m[1]);
        llamadas.push({ etiqueta, n: usuarios.length, define: /DEFINÍ LOS TEMAS/.test(userPrompt) });
        if (JSON.stringify(usuarios) === JSON.stringify(TANDA.usuarios)) return { parsed: TANDA.parsed, usage: TANDA.usage };
        if (!etiqueta.includes('.')) throw Object.assign(new Error('la respuesta se cortó en el tope de salida'), { code: 'SALIDA_CORTADA', userMessage: 'cortada', tokenUsage: CORTADA });
        throw new Error('contenido vacío o JSON inválido');
      }
      llamadas.push({ etiqueta: 'sintesis' });
      return { parsed: SINTESIS.parsed, usage: SINTESIS.usage };
    };
    clasificarReclamo.asignarSubcategorias = async (lista) => ({ subcategorias: lista.map(() => ''), usage: null, llamadas: 0 });
    geoWorker.processPendingReclamosInBackground = () => {};
    postImages.savePostImage = async () => ({ skipped: true });
  });
  after(() => {
    global.fetch = realFetch;
    Object.assign(console, consola);
  });

  test('la fila y el informe: 50 de 385 analizados, con los números que dio la corrida real', async () => {
    const { id } = analysisJob.start({ url: 'https://www.instagram.com/p/PRUEBA1/?hl=es&img_index=1' });
    await analysisJob.waitFor(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'ok');
    assert.deepEqual([a.url, a.cuenta, a.postType, a.comentariosTotal, a.traidos, a.analizados], [URL_POST, 'usuario_12', 'carrusel', 385, 150, 50]);
    // La respuesta real va a la tanda 3 (posiciones 101 a 150), que define los temas.
    assert.deepEqual(
      llamadas.map((l) => l.etiqueta),
      ['1', '1.1', '1.2', '2', '3', '2.1', '2.2', 'sintesis'].filter((x) => llamadas.some((l) => l.etiqueta === x))
    );
    assert.equal(llamadas.find((l) => l.etiqueta === '3').define, true);
    assert.equal(a.comentarios.filter((c) => c.tono !== null).map((c) => c.n).join(','), Array.from({ length: 50 }, (_, i) => 101 + i).join(','));
    assert.equal(a.comentarios.filter((c) => c.verificada).length, 2);
    assert.equal(a.cuando.unidadHoras, 6, 'comentarios hasta las 121 h: de a 6 h (por día recién pasados los 7 días)');
    // (1 + 155) resultados a 0,0023: lo que cobró la corrida real.
    assert.ok(Math.abs(a.usdApify - 156 * 0.0023) < 1e-9);
    // Lo gastado en las dos tandas cortadas también cuenta.
    assert.equal(a.tokens, 2 * CORTADA.totalTokens + TANDA.usage.totalTokens + SINTESIS.usage.totalTokens);
    assert.deepEqual([a.nVerificados, a.tieneHecho, a.temaEstrella], [2, false, 'Tema de prueba 3']);

    const t = a.reporteAntes;
    assert.match(t, /💬 385 comentarios \(50 analizados\)/);
    assert.match(t, /1\) \*Lo que pasó:\* sin un hecho dominante, pero el 57 % se desvía del posteo, sobre todo a Tema de prueba 3\./);
    assert.match(t, /2\) \*Tono:\* 15 % positivo · 28 % neutro · 57 % negativo \(tono neto -41\)/);
    assert.match(t, /3\) \*Postura hacia la gestión:\* 15 % a favor · 33 % neutra · 52 % crítica/);
    assert.match(t, /4\) \*Hablan del posteo:\* 43 %/);
    // El tema que el modelo armó para el ruido quedó sin comentarios: no sale.
    const temas = /5\) \*Temas:\* (.*)/.exec(t)[1];
    assert.equal(temas.split(', ').length, 9);
    assert.doesNotMatch(temas, /Tema de prueba 8\b/);
    assert.match(t, /6\) \*Quién habló:\* 2 verificados/);
    assert.match(t, /7\) \*Pedidos:\* Pedido de prueba 8 \(2\) · Pedido de prueba 1 \(1\) · Pedido de prueba 2 \(1\)/);
    assert.equal(db.listFiguras().length, 0, 'no sugirió a nadie');
    assert.equal(a.reclamos, 3);
  });
});
