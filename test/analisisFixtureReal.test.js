'use strict';

// REQ-ANA-18: la normalización contra lo que de verdad devolvió el actor
// oficial en la corrida autorizada del 24/10/2026 (una publicación, un reel
// con 138 comentarios según Instagram; el actor devolvió 64, sin respuestas
// anidadas). Los ítems están anonimizados (scratchpad/anonimizar-e.js): sin
// usuarios, textos, ids ni links reales; las fechas corridas todas lo mismo
// (la publicación quedó el 15/1/2026 a las 15:00 UTC), así que los
// desfasajes son los reales. Números y booleanos, tal cual.
// fetch simulado con esos ítems, el modelo stubeado y base, registro y fotos
// en temporales: ni Apify ni el LLM ni data/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-fixture-'));
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
const { buildCommentTimeline } = require('../src/commentTimeline');
const { apifySimulado } = require('./helpers/apifySimulado');

const FIX = path.join(__dirname, 'fixtures', 'apify');
const PUBLICACION = JSON.parse(fs.readFileSync(path.join(FIX, 'analisis-publicacion.json'), 'utf8'));
const COMENTARIOS = JSON.parse(fs.readFileSync(path.join(FIX, 'analisis-comentarios.json'), 'utf8'));
const URL_POST = 'https://www.instagram.com/p/PRUEBA1/';
const POSTED_AT = '2026-01-15T15:00:00.000Z';

describe('la forma que devuelve el actor oficial', () => {
  test('la publicación: lo que el análisis lee está en el primer nivel', () => {
    const p = PUBLICACION[0];
    assert.equal(PUBLICACION.length, 1);
    for (const campo of ['id', 'shortCode', 'type', 'productType', 'caption', 'url', 'timestamp', 'likesCount', 'commentsCount', 'videoPlayCount', 'displayUrl', 'ownerUsername', 'ownerFullName']) {
      assert.ok(p[campo] !== undefined && p[campo] !== null, campo);
    }
    assert.equal(p.latestComments.length, 13, 'trae además 13 comentarios de muestra, con la misma forma');
  });

  test('cada comentario: autor, verificada en owner.is_verified, fecha, likes y foto de perfil; sin respuestas', () => {
    assert.equal(COMENTARIOS.length, 64);
    for (const c of COMENTARIOS) {
      assert.equal(typeof c.text, 'string');
      assert.equal(c.ownerUsername, c.owner.username);
      assert.equal(typeof c.owner.is_verified, 'boolean');
      assert.equal(c.ownerIsVerified, undefined, 'no hay ownerIsVerified en el primer nivel');
      assert.match(c.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(typeof c.likesCount, 'number');
      assert.equal(c.ownerProfilePicUrl, c.owner.profile_pic_url);
      assert.equal(c.repliesCount, null);
      assert.equal(c.replies, null);
      // addParentData agrega solo el link y el código de la publicación.
      assert.equal(c.postUrl, URL_POST);
      assert.equal(c.metaData.id, 'PRUEBA1');
      assert.equal(c.ownerFullName, undefined);
      assert.equal(c.likesCount >= 0, true);
    }
  });
});

describe('la normalización contra el fixture', () => {
  test('normalizePost: id, código, fecha, tipo, foto y números', () => {
    const post = apify.normalizePost(PUBLICACION, COMENTARIOS, URL_POST);
    assert.match(post.id, /^\d{19}$/);
    assert.equal(post.shortCode, 'PRUEBA1');
    assert.equal(post.postedAt, POSTED_AT);
    assert.equal(post.postType, 'reel');
    assert.equal(post.imageUrl, PUBLICACION[0].displayUrl);
    assert.match(new URL(post.imageUrl).hostname, /fbcdn\.net$/, 'un host que postImages acepta');
    assert.equal(post.likesCount, 1217);
    assert.equal(post.commentsCount, 138);
    assert.equal(post.videoPlayCount, 20200);
    assert.equal(post.ownerUsername, 'usuario_13');
  });

  test('normalizeComments: los 64, la verificada desde owner, likes 0 como 0 (no "sin dato")', () => {
    const comments = apify.normalizeComments(COMENTARIOS);
    assert.equal(comments.length, 64);
    assert.equal(comments.filter((c) => c.isVerified).length, 1);
    assert.equal(comments.filter((c) => c.likesCount === 0).length, 23);
    assert.equal(Math.max(...comments.map((c) => c.likesCount)), 31);
    assert.ok(comments.every((c) => c.timestamp && c.apifyId && c.username.startsWith('usuario_')));
  });

  test('buildAnalysisData: 64 traídos de 138 que informa Instagram', () => {
    const avisos = [];
    const warn = console.warn;
    console.warn = (m) => avisos.push(String(m));
    try {
      const { post, comments, scrapeMeta } = apify.buildAnalysisData(PUBLICACION, COMENTARIOS, URL_POST, 300);
      assert.equal(post.commentsCount, 138);
      assert.equal(comments.length, 64);
      assert.deepEqual(scrapeMeta, {
        commentsLimitRequested: 300,
        rawCommentItems: 64,
        primerNivel: 64,
        respuestas: 0,
        commentsOnPost: 138,
        comentariosTrasNormalizar: 64,
      });
    } finally {
      console.warn = warn;
    }
    assert.match(avisos.join('\n'), /64 comentarios de primer nivel \(y 0 respuestas\), menos que los 300 pedidos\. Instagram reporta 138/);
  });

  test('"Cuándo comentaron" se arma: 64 con fecha, de a 6 h (48,9 h de comentarios), pico en el primer tramo', () => {
    const comments = apify.normalizeComments(COMENTARIOS);
    const cuando = buildCommentTimeline({ postedAt: POSTED_AT, comments });
    assert.ok(cuando);
    assert.equal(cuando.unidadHoras, 6);
    assert.equal(cuando.conFecha, 64);
    assert.equal(cuando.total, 64);
    assert.equal(cuando.tramos.length, 9);
    assert.deepEqual(cuando.pico, { indice: 0, h: 0, n: 32 });
    assert.equal(cuando.tramos.reduce((n, t) => n + t.n, 0), 64);
  });
});

describe('el análisis entero con lo que devolvió el actor', { concurrency: false }, () => {
  const realFetch = global.fetch;
  const consola = { log: console.log, warn: console.warn, error: console.error };
  before(() => {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    global.fetch = apifySimulado((input) => (input.resultsType === 'posts' ? PUBLICACION : COMENTARIOS));
    llm.requestStructuredAnalysis = async ({ schemaName, userPrompt }) => {
      if (schemaName === 'tanda_instagram') {
        const lista = [...userPrompt.matchAll(/^(\d+)\. @(\S+)/gm)].map((m) => Number(m[1]));
        return {
          parsed: {
            temas: [{ numero: 1, nombre: 'Un tema' }],
            classifications: lista.map((index) => ({
              index,
              sentiment: index % 3 ? 'positivo' : 'negativo',
              postura: index % 3 ? 'favor' : 'critica',
              tema: 1,
              sobre_posteo: true,
              pedido: false,
              reclamosGeo: [],
            })),
          },
          usage: { inputTokens: 1000, outputTokens: 300, totalTokens: 1300, costUsd: 0.01 },
        };
      }
      return {
        parsed: {
          lectura: 'Lectura de prueba.',
          hecho_dominante: { hay: false, tema: 0, titulo: '', descripcion: '' },
          pedidos: [],
          que_mirar: 'Mirar de prueba.',
          figuras_sugeridas: [],
        },
        usage: { inputTokens: 2000, outputTokens: 400, totalTokens: 2400, costUsd: 0.02 },
      };
    };
    clasificarReclamo.asignarSubcategorias = async (lista) => ({ subcategorias: lista.map(() => ''), usage: null, llamadas: 0 });
    geoWorker.processPendingReclamosInBackground = () => {};
    postImages.savePostImage = async () => ({ skipped: true });
  });
  after(() => {
    global.fetch = realFetch;
    Object.assign(console, consola);
  });

  test('la fila: cuenta, números reales, "analizados 64 de 138", la verificada y "Cuándo comentaron"', async () => {
    const { id } = analysisJob.start({ url: 'https://www.instagram.com/reel/PRUEBA1/?igsh=x' });
    await analysisJob.waitFor(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'ok');
    assert.equal(a.url, URL_POST);
    assert.equal(a.cuenta, 'usuario_13');
    assert.equal(a.postType, 'reel');
    assert.equal(a.postedAt, POSTED_AT);
    assert.equal(a.likes, 1217);
    assert.equal(a.comentariosTotal, 138);
    assert.equal(a.traidos, 64);
    assert.equal(a.analizados, 64);
    assert.equal(a.comentarios.length, 64);
    assert.equal(a.comentarios.filter((c) => c.verificada).length, 1);
    assert.ok(a.comentarios.every((c) => c.fecha));
    assert.equal(a.cuando.unidadHoras, 6);
    assert.equal(a.cuando.conFecha, 64);
    // (1 + 64) resultados a 0,0023: lo mismo que cobró la corrida real.
    assert.ok(Math.abs(a.usdApify - 65 * 0.0023) < 1e-9);
    assert.match(a.reporteAntes, /💬 138 comentarios \(64 analizados\)/);
    assert.equal(a.nVerificados, 1);
  });
});
