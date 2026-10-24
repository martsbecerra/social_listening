'use strict';

// El análisis de publicación en el servidor: "Cuándo comentaron"
// (src/commentTimeline.js), el progreso (src/analysisProgress.js), el
// trabajo (src/analysisJob.js) y sus rutas (src/analysisRoutes.js, con el
// gate de login de la app en un puerto local). Apify, el LLM, la
// subcategoría, la geocodificación y la descarga de fotos stubeados por el
// objeto del módulo; una prueba pasa por runActorSync con fetch simulado
// para ver el gasto atado al análisis. Base, registro de cuentas y fotos en
// temporales: ni Apify real, ni el modelo, ni data/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-trabajo-'));
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.MONITORING_MEDIA_DIR = MEDIA;
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.SESSION_SECRET = 'secreto-de-test';
process.env.APP_BASE_URL = 'http://localhost'; // cookie sin "secure"
delete process.env.COMMENTS_LIMIT;
delete process.env.COMMENTS_ANALYSIS_LIMIT;
delete process.env.POST_IMAGES;

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const apify = require('../src/apify');
const llm = require('../src/llm');
const clasificarReclamo = require('../src/clasificarReclamo');
const geoWorker = require('../src/geoWorker');
const postImages = require('../src/postImages');
const progress = require('../src/analysisProgress');
const analysisJob = require('../src/analysisJob');
const analysisRoutes = require('../src/analysisRoutes');
const { buildCommentTimeline } = require('../src/commentTimeline');
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');

const POST_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'apify', 'post-detail.json'), 'utf8'));
const POSTED_AT = '2026-10-20T12:00:00.000Z';
const HORA = 3600 * 1000;
const realFetch = global.fetch;
const original = {
  fetchAnalysisPost: apify.fetchAnalysisPost,
  fetchAnalysisComments: apify.fetchAnalysisComments,
};

function postItem(extra = {}) {
  return [{ ...POST_FIXTURE[0], id: '111222333', shortCode: 'ABC123', ownerUsername: 'gcba', ownerFullName: 'GCBA', likesCount: 900, commentsCount: 480, timestamp: POSTED_AT, displayUrl: 'https://scontent.cdninstagram.com/v/foto.jpg', ...extra }];
}

function commentItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    ownerUsername: `vecino${i + 1}`,
    text: `Comentario ${i + 1}`,
    likesCount: 500 - i,
    timestamp: new Date(Date.parse(POSTED_AT) + (i % 10) * HORA + 60000).toISOString(),
  }));
}

// ---- stubs
let llamadasApify;
let respuestaPost;
let respuestaComentarios;
let errorPost;
let frenoPost;
let geocodificaciones;
let fotos;
function stubs() {
  llamadasApify = [];
  respuestaPost = postItem();
  respuestaComentarios = commentItems(25);
  errorPost = null;
  frenoPost = null;
  geocodificaciones = 0;
  fotos = [];
  apify.fetchAnalysisPost = async (url, hooks) => {
    llamadasApify.push(['post', url]);
    if (hooks.onAcquired) hooks.onAcquired();
    if (frenoPost) await frenoPost;
    if (errorPost) throw errorPost;
    return respuestaPost;
  };
  apify.fetchAnalysisComments = async (url, hooks) => {
    llamadasApify.push(['comments', url]);
    if (hooks.onAcquired) hooks.onAcquired();
    return { items: respuestaComentarios, limit: 300 };
  };
  llm.requestStructuredAnalysis = async ({ schemaName, userPrompt }) => {
    if (schemaName === 'tanda_instagram') {
      const lista = [...userPrompt.matchAll(/^(\d+)\. @(\S+)/gm)];
      return {
        parsed: {
          temas: /DEFINÍ LOS TEMAS/.test(userPrompt)
            ? [
                { numero: 1, nombre: 'Baches' },
                { numero: 2, nombre: 'Plaza' },
              ]
            : [],
          classifications: lista.map((m) => ({
            index: Number(m[1]),
            sentiment: Number(m[2].replace('vecino', '')) % 4 === 0 ? 'negativo' : 'positivo',
            postura: Number(m[2].replace('vecino', '')) % 4 === 0 ? 'critica' : 'favor',
            tema: Number(m[2].replace('vecino', '')) % 2 === 0 ? 1 : 2,
            sobre_posteo: Number(m[2].replace('vecino', '')) % 2 !== 0,
            pedido: false,
            reclamosGeo: m[2] === 'vecino2' ? [{ direccionDetectada: 'Salta 250', direccionNormalizada: 'Salta 250', tematica: 'bache', categoria: 'Infraestructura', tipoUbicacion: 'calle_altura' }] : [],
          })),
        },
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
      };
    }
    return {
      parsed: {
        lectura: 'La lectura estratégica.',
        hecho_dominante: { hay: true, tema: 1, titulo: 'Un pozo enorme en Salta', descripcion: 'Lo mencionan muchos.' },
        pedidos: [{ texto: 'Arreglar las calles', ids: [2, 3, 99] }],
        que_mirar: 'Responder por los baches.',
        figuras_sugeridas: [],
      },
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380, costUsd: 0.02 },
    };
  };
  clasificarReclamo.asignarSubcategorias = async (lista) => ({ subcategorias: lista.map(() => ''), usage: null, llamadas: 0 });
  geoWorker.processPendingReclamosInBackground = () => {
    geocodificaciones += 1;
  };
  postImages.savePostImage = async (post) => {
    fotos.push(post);
    return { ok: true, status: 'ok', sourceUrl: post.url, width: 1080, height: 1350, savedAt: '2026-10-24T10:00:00.000Z' };
  };
}

const URL_ABC = 'https://www.instagram.com/p/ABC123/';
async function analizar(url = URL_ABC) {
  const started = analysisJob.start({ url, analizadoPor: 'prueba@test.local' });
  await analysisJob.waitFor(started.id);
  return started.id;
}

// Los logs del trabajo no ensucian la salida de la suite.
const consoleOriginal = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});
after(() => Object.assign(console, consoleOriginal));
beforeEach(() => {
  stubs();
  global.fetch = realFetch;
});

describe('Cuándo comentaron', () => {
  const con = (horas) => horas.map((h) => ({ timestamp: new Date(Date.parse(POSTED_AT) + h * HORA).toISOString() }));

  test('sin fecha de la publicación o con menos de 10 comentarios con fecha: no hay bloque', () => {
    assert.equal(buildCommentTimeline({ postedAt: null, comments: con([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }), null);
    assert.equal(buildCommentTimeline({ postedAt: POSTED_AT, comments: [...con([1, 2, 3, 4, 5, 6, 7, 8, 9]), { timestamp: null }, {}] }), null);
  });

  test('hasta 48 h, por hora; el pico es el tramo con más comentarios', () => {
    const t = buildCommentTimeline({ postedAt: POSTED_AT, comments: [...con([0.5, 1.2, 1.5, 1.7, 3, 5, 9, 9.1, 20, 30.5]), { timestamp: null }] });
    assert.equal(t.unidadHoras, 1);
    assert.equal(t.tramos.length, 31);
    assert.deepEqual(t.tramos.slice(0, 4), [{ h: 0, n: 1 }, { h: 1, n: 3 }, { h: 2, n: 0 }, { h: 3, n: 1 }]);
    assert.deepEqual(t.pico, { indice: 1, h: 1, n: 3 });
    assert.equal(t.conFecha, 10);
    assert.equal(t.total, 11);
    assert.equal(t.tramos.reduce((s, x) => s + x.n, 0), 10);
  });

  test('hasta 7 días, de a 6 h; después, por día; uno antes de la publicación cuenta en el primero', () => {
    const seis = buildCommentTimeline({ postedAt: POSTED_AT, comments: con([-1, 1, 2, 7, 8, 13, 50, 60, 70, 100]) });
    assert.equal(seis.unidadHoras, 6);
    assert.equal(seis.tramos[0].n, 3);
    assert.equal(seis.tramos[1].h, 6);
    const dias = buildCommentTimeline({ postedAt: POSTED_AT, comments: con([1, 2, 3, 4, 5, 6, 7, 8, 30, 240]) });
    assert.equal(dias.unidadHoras, 24);
    assert.equal(dias.tramos.length, 11);
    assert.deepEqual(dias.pico, { indice: 0, h: 0, n: 8 });
  });
});

describe('el trabajo del análisis', { concurrency: false }, () => {
  test('un análisis entero queda en la fila, con pasos reales y sin el link original de la foto', async () => {
    const id = await analizar('https://www.instagram.com/reel/ABC123/?igsh=xyz');
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'ok');
    assert.equal(a.url, URL_ABC, 'el link normalizado a /p/<code>/');
    assert.equal(a.postCode, 'ABC123');
    assert.equal(a.cuenta, 'gcba');
    assert.equal(a.postedAt, POSTED_AT);
    assert.equal(a.comentariosTotal, 480);
    assert.deepEqual([a.traidos, a.unicos, a.enviados, a.analizados], [25, 25, 25, 25]);
    assert.deepEqual(a.tonos, { positivos: 19, neutrales: 0, negativos: 6, ruido: 0 });
    assert.equal(a.resultado.version, 2);
    assert.equal(a.resultado.lectura, 'La lectura estratégica.');
    assert.equal(a.resultado.lecturaEstrategica, 'La lectura estratégica.', 'la que lee la solapa de la fase E');
    assert.deepEqual(a.resultado.hecho, { temaId: 1, titulo: 'Un pozo enorme en Salta', descripcion: 'Lo mencionan muchos.' });
    assert.deepEqual(a.resultado.pedidos, [{ texto: 'Arreglar las calles', ids: [2, 3] }]);
    assert.equal(a.resultado.queMirar, 'Responder por los baches.');
    assert.deepEqual(a.temas, {
      version: 2,
      lista: [
        { id: 1, nombre: 'Baches' },
        { id: 2, nombre: 'Plaza' },
      ],
    });
    assert.equal(a.comentarios.length, 25);
    assert.deepEqual(a.comentarios[0], {
      n: 1,
      usuario: 'vecino1',
      verificada: false,
      likes: 500,
      fecha: respuestaComentarios[0].timestamp,
      texto: 'Comentario 1',
      tono: 'positivo',
      postura: 'favor',
      tema: 2,
      sobrePosteo: true,
      pedido: false,
    });
    assert.equal(a.cuando.unidadHoras, 1);
    assert.equal(a.cuando.conFecha, 25);
    // El informe de 8 puntos, con la misma cuenta que la pantalla.
    assert.match(a.reporteAntes, /^\*Análisis de publicación · @gcba · /);
    assert.match(a.reporteAntes, /\(25 analizados\)/);
    assert.match(a.reporteAntes, /1\) \*Lo que pasó:\* el 48 % de los comentarios habla de un mismo hecho ajeno al posteo: Un pozo enorme en Salta\./);
    assert.equal(a.reporteDespues, '');
    assert.equal(a.positivoPct, null, 'sin el ponderado por tipo de cuenta');
    // Las columnas de la galería: 6 de 25 negativos; el hecho (12 de 25 en "Baches", fuera del posteo); "Plaza", 13.
    assert.deepEqual([a.pctNeg, a.tieneHecho, a.nVerificados, a.temaEstrella], [24, true, 0, 'Plaza']);
    assert.equal(a.reclamos, 1);
    assert.equal(geocodificaciones, 1, 'los reclamos se geocodifican después');
    assert.equal(a.tokens, 150 + 380);
    assert.equal(a.usdModelo, 0.03);
    assert.equal(a.usdApify, 0, 'Apify stubeado: no hay filas en apify_calls');
    assert.equal(a.image.status, 'ok');
    assert.deepEqual(fotos, [{ plataforma: 'instagram', id: '111222333', url: 'https://scontent.cdninstagram.com/v/foto.jpg' }]);

    const view = progress.getView(id, 'instagram');
    assert.equal(view.estado, 'ok');
    const detalle = Object.fromEntries(view.pasos.map((p) => [p.key, `${p.estado} · ${p.detalle}`]));
    assert.equal(detalle.turno, undefined, 'sin espera, el paso del turno no aparece');
    assert.match(detalle.publicacion, /^ok · @gcba · 900 likes · \d+ s$/);
    assert.match(detalle.comentarios, /^ok · 25 comentarios · \d+ s$/);
    assert.match(detalle.clasificar, /^ok · 25 de 25 · 1 tanda · \d+ s$/);
    assert.equal(detalle.verificados, 'ok · 0 verificados · 0 figuras públicas');
    assert.equal(view.porcentaje, 100);
    assert.equal(detalle.reclamos, 'ok · 1 reclamo');
    assert.match(detalle.informe, /^ok · listo · [\d.]+ caracteres$/);
    assert.equal(progress.getView(id, 'x'), null, 'por plataforma');
  });

  test('el mismo link con un análisis en curso devuelve el mismo id, sin otra corrida', async () => {
    let soltar;
    frenoPost = new Promise((resolve) => (soltar = resolve));
    const a = analysisJob.start({ url: 'https://www.instagram.com/p/DUP1/' });
    const b = analysisJob.start({ url: 'https://instagram.com/p/DUP1/?utm_source=ig' });
    assert.equal(a.yaEnCurso, false);
    assert.deepEqual(b, { id: a.id, yaEnCurso: true });
    assert.equal(analysisJob.enCursoDe('https://www.instagram.com/p/DUP1/'), a.id);
    assert.deepEqual(analysisJob.listEnCurso(), [{ id: a.id, url: 'https://www.instagram.com/p/DUP1/', analizadoPor: null }]);
    soltar();
    await analysisJob.waitFor(a.id);
    assert.equal(llamadasApify.filter(([k]) => k === 'post').length, 1);
    assert.equal(analysisJob.enCursoDe('https://www.instagram.com/p/DUP1/'), null);
    const c = analysisJob.start({ url: 'https://www.instagram.com/p/DUP1/' });
    assert.notEqual(c.id, a.id, 'terminado, el mismo link arranca otro');
    await analysisJob.waitFor(c.id);
  });

  test('un link sin código de publicación no arranca nada', () => {
    assert.equal(analysisJob.start({ url: 'https://www.instagram.com/gcba/' }), null);
    assert.equal(analysisJob.start({ url: 'https://www.instagram.com/reels/audio/1234567890/' }), null, 'la página de un audio no es una publicación');
  });

  test('el link se normaliza a /p/<code>/: reels, con el usuario adelante, con parámetros', () => {
    const norm = (u) => (analysisJob.normalizeAnalysisUrl(u) || {}).url || null;
    assert.equal(norm('https://www.instagram.com/reel/ABC_12-x/?igsh=abc'), 'https://www.instagram.com/p/ABC_12-x/');
    assert.equal(norm('https://instagram.com/reels/ABC/'), 'https://www.instagram.com/p/ABC/');
    assert.equal(norm('https://www.instagram.com/gcba/p/ABC/'), 'https://www.instagram.com/p/ABC/');
    assert.equal(norm('https://www.instagram.com/tv/ABC'), 'https://www.instagram.com/p/ABC/');
    assert.equal(norm('https://www.instagram.com/reels/audio/123/'), null);
    assert.equal(norm('https://www.instagram.com/stories/gcba/123/'), null);
    assert.equal(norm('https://www.instagram.com/share/p/BAJm1JX0Hc/'), null, 'el token de compartir no es el código');
    assert.equal(norm('https://www.instagram.com/share/reel/_7mEmXSq5/'), null);
    assert.equal(norm('no es un link'), null);
  });

  test('sin comentarios: estado "sin comentarios", con el mensaje para la persona', async () => {
    respuestaComentarios = [{ id: 'x', text: '   ' }];
    const id = await analizar('https://www.instagram.com/p/SINCOM/');
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'sin comentarios');
    assert.equal(a.error, analysisJob.MENSAJE_SIN_COMENTARIOS);
    assert.equal(a.cuenta, 'gcba', 'los datos de la publicación quedan');
    assert.equal(progress.getView(id, 'instagram').estado, 'sin comentarios');
  });

  test('si Apify falla: estado error con su mensaje y el paso en error', async () => {
    errorPost = Object.assign(new Error('402'), { userMessage: 'Se agotó el crédito de Apify.' });
    const id = await analizar('https://www.instagram.com/p/FALLA/');
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'error');
    assert.equal(a.error, 'Se agotó el crédito de Apify.');
    const view = progress.getView(id, 'instagram');
    assert.equal(view.error, 'Se agotó el crédito de Apify.');
    assert.equal(view.pasos.find((p) => p.key === 'publicacion').estado, 'error');
    assert.equal(view.pasos.find((p) => p.key === 'clasificar').estado, 'pendiente');
  });

  test('si el modelo falla en todas las tandas: error, y el paso de clasificar en error', async () => {
    llm.requestStructuredAnalysis = async () => {
      throw new Error('caído');
    };
    const id = await analizar('https://www.instagram.com/p/SINLLM/');
    assert.equal(db.getAnalisis(id, 'instagram').estado, 'error');
    assert.equal(progress.getView(id, 'instagram').pasos.find((p) => p.key === 'clasificar').estado, 'error');
  });

  test('si la síntesis falla después de clasificar, la fila guarda lo gastado en el modelo', async () => {
    const tandas = llm.requestStructuredAnalysis;
    llm.requestStructuredAnalysis = async (args) => {
      if (args.schemaName === 'sintesis_instagram') throw new Error('se cayó la síntesis');
      return tandas(args);
    };
    const id = await analizar('https://www.instagram.com/p/SINSINTESIS/');
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'error');
    assert.equal(a.tokens, 150);
    assert.ok(Math.abs(a.usdModelo - 0.01) < 1e-9);
  });

  test('"Esperar turno en Apify" aparece solo si una corrida tuvo que esperar cupo', async () => {
    let soltar;
    const espera = new Promise((resolve) => (soltar = resolve));
    apify.fetchAnalysisPost = async (url, hooks) => {
      hooks.onQueued();
      await espera;
      hooks.onAcquired();
      return respuestaPost;
    };
    const { id } = analysisJob.start({ url: 'https://www.instagram.com/p/TURNO/' });
    await new Promise((r) => setImmediate(r));
    const turno = progress.getView(id, 'instagram').pasos[0];
    assert.deepEqual([turno.key, turno.estado, turno.detalle], ['turno', 'en curso', '1 corrida esperando cupo']);
    assert.equal(progress.getView(id, 'instagram').pasos.find((p) => p.key === 'publicacion').estado, 'pendiente');
    soltar();
    await analysisJob.waitFor(id);
    assert.match(progress.getView(id, 'instagram').pasos[0].detalle, /^\d+ s de espera$/);
    assert.equal(progress.getView(id, 'instagram').pasos[0].estado, 'ok');
  });

  test('la foto del Monitoreo se reusa; si la publicación está ahí sin foto, se entera de la nueva', async () => {
    const ahora = new Date().toISOString();
    for (const [id, code] of [['555', 'CONFOTO'], ['666', 'SINFOTO']]) {
      db.saveDetectedPost({ id, plataforma: 'instagram', account: 'gcba', url: `https://www.instagram.com/p/${code}/`, caption: 'x', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: ahora, title: 'T', sentiment: 'neutral', postType: 'imagen' });
    }
    db.markPostImageSaved('555', 'instagram', { sourceUrl: 'https://scontent.cdninstagram.com/v/vieja.jpg', width: 360, height: 450, savedAt: '2026-10-01T00:00:00.000Z' });
    fs.mkdirSync(path.join(MEDIA, 'instagram'), { recursive: true });
    for (const size of ['thumb', 'full']) fs.writeFileSync(path.join(MEDIA, 'instagram', `555_${size}.jpg`), `jpeg-${size}`);

    respuestaPost = postItem({ id: '555', shortCode: 'CONFOTO' });
    const conFoto = await analizar('https://www.instagram.com/p/CONFOTO/');
    assert.equal(fotos.length, 0, 'no se baja otra vez');
    assert.equal(db.getAnalisis(conFoto, 'instagram').imageSavedAt, '2026-10-01T00:00:00.000Z');

    respuestaPost = postItem({ id: '666', shortCode: 'SINFOTO' });
    const sinFoto = await analizar('https://www.instagram.com/p/SINFOTO/');
    assert.equal(fotos.length, 1);
    assert.equal(db.getAnalisis(sinFoto, 'instagram').imageSavedAt, '2026-10-24T10:00:00.000Z');
    assert.equal(db.getPostImage('666', 'instagram').savedAt, '2026-10-24T10:00:00.000Z', 'el Monitoreo ya tiene su foto');
  });

  test('con Apify de verdad (fetch simulado): las dos corridas quedan atadas al análisis y el gasto en la fila', async () => {
    apify.fetchAnalysisPost = original.fetchAnalysisPost;
    apify.fetchAnalysisComments = original.fetchAnalysisComments;
    global.fetch = async (url, opts) => {
      if (!String(url).includes('api.apify.com')) return realFetch(url, opts);
      const body = JSON.parse(opts.body);
      const items = body.resultsType === 'posts' ? postItem({ id: '777', shortCode: 'REAL' }) : commentItems(12);
      return new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const id = await analizar('https://www.instagram.com/p/REAL/');
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'ok');
    assert.equal(db.sumApifyUsdForAnalisis(id).calls, 2);
    // (1 + 1) y (12 + 1) resultados a 0,0023 en Starter.
    assert.ok(Math.abs(a.usdApify - db.sumApifyUsdForAnalisis(id).usd) < 1e-9);
    assert.ok(a.usdApify > 0);
  });
});

describe('las rutas', { concurrency: false }, () => {
  let server;
  let base;
  let cookie;
  before(async () => {
    let header = '';
    setSessionCookie({ append: (name, value) => (header = value) }, 'prueba@test.local');
    cookie = header.split(';')[0];
    const app = express();
    app.use(express.json());
    app.use(createAuthGate());
    analysisRoutes.register(app);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const pedir = (ruta, { method = 'GET', body, conCookie = true } = {}) =>
    realFetch(`${base}${ruta}`, {
      method,
      redirect: 'manual',
      headers: { ...(conCookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  test('sin sesión: 401', async () => {
    assert.equal((await pedir('/api/analisis?plataforma=instagram', { conCookie: false })).status, 401);
    assert.equal((await pedir('/api/analyze', { method: 'POST', body: { url: URL_ABC }, conCookie: false })).status, 401);
  });

  test('POST /api/analyze: 400 con un link de otra red o sin publicación; 202 con el id', async () => {
    const x = await pedir('/api/analyze', { method: 'POST', body: { url: 'https://x.com/a/status/1' } });
    assert.equal(x.status, 400);
    assert.match((await x.json()).error, /solo analiza publicaciones de Instagram/);
    const perfil = await pedir('/api/analyze', { method: 'POST', body: { url: 'https://www.instagram.com/gcba/' } });
    assert.equal(perfil.status, 400);
    assert.equal(llamadasApify.length, 0, 'nada se gastó');

    const ok = await pedir('/api/analyze', { method: 'POST', body: { url: 'https://www.instagram.com/p/RUTA1/' } });
    assert.equal(ok.status, 202);
    const { id, yaEnCurso } = await ok.json();
    assert.equal(yaEnCurso, false);
    await analysisJob.waitFor(id);

    const prog = await pedir(`/api/analyze/progress?plataforma=instagram&id=${id}`);
    assert.equal(prog.status, 200);
    const view = await prog.json();
    assert.equal(view.estado, 'ok');
    assert.ok(view.pasos.length >= 6);
    assert.equal((await pedir(`/api/analyze/progress?plataforma=x&id=${id}`)).status, 404);
    assert.equal((await pedir(`/api/analyze/progress?id=${id}`)).status, 400);
  });

  test('en curso: "propio" solo para quien lo arrancó, y el correo no sale', async () => {
    let soltar;
    frenoPost = new Promise((resolve) => (soltar = resolve));
    const ok = await pedir('/api/analyze', { method: 'POST', body: { url: 'https://www.instagram.com/p/PROPIO1/' } });
    const { id } = await ok.json();
    let otraHeader = '';
    setSessionCookie({ append: (name, value) => (otraHeader = value) }, 'otra@test.local');
    const otra = otraHeader.split(';')[0];
    try {
      const texto = await (await pedir('/api/analisis?plataforma=instagram&limit=4')).text();
      assert.doesNotMatch(texto, /prueba@test\.local/);
      assert.deepEqual(JSON.parse(texto).enCurso, [{ id, url: 'https://www.instagram.com/p/PROPIO1/', propio: true }]);
      const ajena = await (await realFetch(`${base}/api/analisis?plataforma=instagram&limit=4`, { headers: { Cookie: otra } })).json();
      assert.deepEqual(ajena.enCurso, [{ id, url: 'https://www.instagram.com/p/PROPIO1/', propio: false }]);
    } finally {
      soltar();
      await analysisJob.waitFor(id);
    }
  });

  test('el progreso de un análisis que ya no está en memoria sale de la fila', async () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/VIEJO/' });
    db.failAnalisis(id, 'instagram', { estado: 'interrumpido', error: 'El servidor se reinició.' });
    const view = await (await pedir(`/api/analyze/progress?plataforma=instagram&id=${id}`)).json();
    assert.deepEqual([view.estado, view.error, view.pasos], ['interrumpido', 'El servidor se reinició.', null]);
  });

  test('recientes, "¿ya se analizó?" y el análisis entero, sin el link original de la foto', async () => {
    const id = await analizar('https://www.instagram.com/p/LISTA/');
    const lista = await (await pedir('/api/analisis?plataforma=instagram&limit=4')).json();
    assert.ok(lista.recientes.length <= 4);
    assert.equal(lista.recientes[0].id, id);
    assert.deepEqual(lista.enCurso, []);
    assert.match(lista.recientes[0].imagen.thumbUrl, new RegExp(`^/api/analisis/${id}/image\\?plataforma=instagram&size=thumb&v=`));

    const ya = await (await pedir(`/api/analisis?plataforma=instagram&url=${encodeURIComponent('https://www.instagram.com/reel/LISTA/?igsh=1')}`)).json();
    assert.equal(ya.ultimo.id, id);
    assert.equal(ya.enCurso, null);
    const nunca = await (await pedir(`/api/analisis?plataforma=instagram&url=${encodeURIComponent('https://www.instagram.com/p/NUNCA/')}`)).json();
    assert.equal(nunca.ultimo, null);

    const res = await pedir(`/api/analisis/${id}?plataforma=instagram`);
    assert.equal(res.status, 200);
    const texto = await res.text();
    assert.doesNotMatch(texto, /scontent\.cdninstagram\.com/, 'el link original de la foto no sale');
    assert.doesNotMatch(texto, /prueba@test\.local/, 'quién lo corrió no sale');
    const a = JSON.parse(texto);
    assert.equal(a.estado, 'ok');
    assert.equal(a.comentarios.length, 25);
    assert.equal(a.image, undefined);
    assert.equal((await pedir(`/api/analisis/${id}?plataforma=x`)).status, 404);
    assert.equal((await pedir(`/api/analisis/${id}`)).status, 400);
    assert.equal((await pedir('/api/analisis/999999?plataforma=instagram')).status, 404);
  });

  test('PATCH de los temas: se guardan limpios; una lista inválida, 400', async () => {
    const id = await analizar('https://www.instagram.com/p/TEMAS/');
    const ok = await pedir(`/api/analisis/${id}/temas?plataforma=instagram`, {
      method: 'PATCH',
      body: { temas: [{ titulo: '  Baches  ', texto: 'Calles rotas', comentarios: [3, 1, 1, 400] }, { titulo: 'Nuevo', texto: '' }] },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(db.getAnalisis(id, 'instagram').temas, [
      { titulo: 'Baches', texto: 'Calles rotas', comentarios: [1, 3] },
      { titulo: 'Nuevo', texto: '', comentarios: [] },
    ]);
    const sinTitulo = await pedir(`/api/analisis/${id}/temas?plataforma=instagram`, { method: 'PATCH', body: { temas: [{ titulo: ' ', texto: 'x' }] } });
    assert.equal(sinTitulo.status, 400);
    const muchos = await pedir(`/api/analisis/${id}/temas?plataforma=instagram`, { method: 'PATCH', body: { temas: Array.from({ length: 9 }, () => ({ titulo: 't' })) } });
    assert.equal(muchos.status, 400);
    assert.equal((await pedir(`/api/analisis/${id}/temas?plataforma=x`, { method: 'PATCH', body: { temas: [] } })).status, 404);
  });

  test('la foto: el archivo del posteo, armado con datos de la fila', async () => {
    respuestaPost = postItem({ id: '888', shortCode: 'FOTO' });
    const id = await analizar('https://www.instagram.com/p/FOTO/');
    fs.mkdirSync(path.join(MEDIA, 'instagram'), { recursive: true });
    fs.writeFileSync(path.join(MEDIA, 'instagram', '888_thumb.jpg'), 'miniatura');
    const res = await pedir(`/api/analisis/${id}/image?plataforma=instagram&size=thumb`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'miniatura');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal((await pedir(`/api/analisis/${id}/image?plataforma=instagram&size=full`)).status, 404, 'sin el archivo, 404');
    assert.equal((await pedir(`/api/analisis/${id}/image?plataforma=instagram&size=../../x`)).status, 400);
    assert.equal((await pedir(`/api/analisis/${id}/image?plataforma=x&size=thumb`)).status, 404);
  });
});
