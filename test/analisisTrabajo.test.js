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

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
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
const figurasRoutes = require('../src/figurasRoutes');
const { buildCommentTimeline } = require('../src/commentTimeline');
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');
const { apifySimulado } = require('./helpers/apifySimulado');

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
  apify.fetchAnalysisComments = async (url, hooks, opciones = {}) => {
    llamadasApify.push(['comments', url, opciones.resultsLimit]);
    if (hooks.onAcquired) hooks.onAcquired();
    return { items: respuestaComentarios, limit: opciones.resultsLimit };
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
            // Los que agrupa la síntesis de abajo (un pedido solo junta marcados PEDIDO).
            pedido: m[1] === '2' || m[1] === '3',
            reclamosGeo: m[2] === 'vecino2' ? [{ ubicacion: { tipo: 'calle_altura', calle: 'Salta', altura: 250, calle2: '', nombre_lugar: '', barrio_o_comuna: '', texto_original: 'Salta 250', confianza: 'alta', fuera_de_caba: false }, tematica: 'bache', categoria: 'Infraestructura' }] : [],
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

// Hasta que el trabajo quede esperando la confirmación (más de 1.000 comentarios).
async function hastaQueEspere(id) {
  for (let i = 0; i < 400; i++) {
    const view = progress.getView(id, 'instagram');
    if (view && view.confirmacion) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`el análisis #${id} no quedó esperando la confirmación`);
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
    assert.equal(a.resultado.respuestas, true, 'los comentarios se pidieron con sus respuestas (fase G)');
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
      esRespuesta: false,
      respondeA: null,
      respondeAUsuario: null,
      deLaCuenta: false,
      respuestasDeclaradas: null,
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
    assert.match(detalle.comentarios, /^ok · 25 comentarios y 0 respuestas · \d+ s$/);
    assert.equal(detalle.confirmar, undefined, 'con 480 comentarios no se pide confirmación');
    assert.deepEqual(llamadasApify, [['post', URL_ABC], ['comments', URL_ABC, 480]], 'primero la publicación; después todo lo que informa Instagram');
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
    global.fetch = apifySimulado((input) => (input.resultsType === 'posts' ? postItem({ id: '777', shortCode: 'REAL' }) : commentItems(12)), {
      status: 200,
      otro: realFetch,
    });
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
    figurasRoutes.register(app);
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

  test('POST /api/analyze/:id/confirmar: la opción elegida sigue el análisis; mal pedido, 400; si ya no espera, 409', async () => {
    respuestaPost = postItem({ commentsCount: 5200, shortCode: 'MUCHOS1' });
    const ok = await pedir('/api/analyze', { method: 'POST', body: { url: 'https://www.instagram.com/p/MUCHOS1/' } });
    const { id } = await ok.json();
    await hastaQueEspere(id);
    const view = await (await pedir(`/api/analyze/progress?plataforma=instagram&id=${id}`)).json();
    assert.deepEqual(view.confirmacion.opciones.map((o) => o.alcance), ['todo', 'parcial']);
    assert.equal(view.confirmacion.puedeConfirmar, true, 'lo arrancó la misma sesión');
    assert.equal(view.pasos.find((p) => p.key === 'confirmar').estado, 'en curso');
    const raro = await pedir(`/api/analyze/${id}/confirmar`, { method: 'POST', body: { alcance: 'mucho' } });
    assert.equal(raro.status, 400);
    const sinSesion = await pedir(`/api/analyze/${id}/confirmar`, { method: 'POST', body: { alcance: 'todo' }, conCookie: false });
    assert.equal(sinSesion.status, 401);
    const elegido = await pedir(`/api/analyze/${id}/confirmar`, { method: 'POST', body: { alcance: 'parcial' } });
    assert.equal(elegido.status, 200);
    await analysisJob.waitFor(id);
    assert.equal(db.getAnalisis(id, 'instagram').estado, 'ok');
    const tarde = await pedir(`/api/analyze/${id}/confirmar`, { method: 'POST', body: { alcance: 'todo' } });
    assert.equal(tarde.status, 409);
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

  test('el análisis entero suma la vista, el informe y los temas como los lee la solapa de la fase E', async () => {
    const id = await analizar('https://www.instagram.com/p/VISTA/');
    const a = await (await pedir(`/api/analisis/${id}?plataforma=instagram`)).json();
    assert.equal(a.vista.version, 2);
    assert.deepEqual([a.vista.tono.positivos, a.vista.tono.negativos], [19, 6]);
    assert.equal(a.vista.hecho.titulo, 'Un pozo enorme en Salta');
    assert.equal(a.vista.comparacion.primero, false, 'gcba ya tiene análisis anteriores en esta base');
    assert.match(a.vista.imagen.thumbUrl, /^\/api\/analisis\/\d+\/image\?/);
    assert.equal(a.vista.reclamos.length, 1, 'el de vecino2, por el link del posteo');
    assert.match(a.informe, /^\*Análisis de publicación · @gcba/);
    assert.equal(a.reporteAntes, a.informe);
    assert.equal(a.reporteDespues, '');
    // La lista vieja: Plaza (13) primero, Baches (12); números de comentarios.
    assert.deepEqual(
      a.temas.map((t) => [t.titulo, t.texto, t.comentarios.length]),
      [
        ['Plaza', '', 13],
        ['Baches', '', 12],
      ]
    );
  });

  test('PATCH v2: renombrar (y unir si coincide), agregar a mano, quitar solo los manuales; la estrella se actualiza', async () => {
    const id = await analizar('https://www.instagram.com/p/TEMAS2/');
    const patch = (body) => pedir(`/api/analisis/${id}/temas?plataforma=instagram`, { method: 'PATCH', body });
    let r = await patch({ accion: 'renombrar', id: 2, nombre: '  Plaza Italia ' });
    assert.equal(r.status, 200);
    let a = await r.json();
    assert.equal(a.vista.temas[0].nombre, 'Plaza Italia');
    assert.equal(db.listAnalisisGaleria({ plataforma: 'instagram' }).items.find((x) => x.id === id).temaEstrella, 'Plaza Italia');
    a = await (await patch({ accion: 'renombrar', id: 1, nombre: 'plaza italia' })).json();
    assert.deepEqual(
      a.vista.temas.map((t) => [t.nombre, t.n]),
      [['Plaza Italia', 25]],
      'se unieron'
    );
    assert.equal(db.getAnalisis(id, 'instagram').temas.lista[0].unidoA, 2);
    // Las cuatro columnas de la galería, con la vista después de unir.
    const enGaleria = db.listAnalisisGaleria({ plataforma: 'instagram', limit: 200 }).items.find((x) => x.id === id);
    assert.deepEqual([enGaleria.temaEstrella, enGaleria.tieneHecho], ['Plaza Italia', Boolean(a.vista.hecho)]);
    a = await (await patch({ accion: 'agregar', nombre: 'Seguridad', texto: 'Piden más patrullaje.' })).json();
    assert.deepEqual(a.vista.temas[1], { id: 3, nombre: 'Seguridad', manual: true, texto: 'Piden más patrullaje.', n: null, fuera: null, tonos: { positivo: 0, neutral: 0, negativo: 0 }, estrella: false });
    assert.match(a.informe, /5\) \*Temas:\* Plaza Italia \(25\), Seguridad: Piden más patrullaje\./);
    r = await patch({ accion: 'quitar', id: 2 });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /no se puede quitar/);
    assert.equal((await patch({ accion: 'quitar', id: 3 })).status, 200);
    assert.equal((await patch({ accion: 'agregar', nombre: ' ' })).status, 400);
    assert.equal((await patch({ accion: 'borrar todo' })).status, 400);
    assert.equal((await pedir(`/api/analisis/${id}/temas?plataforma=x`, { method: 'PATCH', body: {} })).status, 404);
  });

  test('PATCH viejo (la lista entera de la solapa de la fase E) sobre un v2: se traduce al cambio', async () => {
    const id = await analizar('https://www.instagram.com/p/TEMAS3/');
    const patch = (temas) => pedir(`/api/analisis/${id}/temas?plataforma=instagram`, { method: 'PATCH', body: { temas } });
    let a = await (await patch([{ titulo: 'Plaza', texto: '' }, { titulo: 'Baches y pozos', texto: '' }])).json();
    assert.deepEqual(
      a.temas.map((t) => t.titulo),
      ['Plaza', 'Baches y pozos']
    );
    a = await (await patch([{ titulo: 'Plaza', texto: '' }, { titulo: 'Baches y pozos', texto: '' }, { titulo: 'Nuevo', texto: 'Uno a mano.' }])).json();
    assert.equal(a.vista.temas[2].manual, true);
    assert.equal(a.temas[2].texto, 'Uno a mano.', 'el editor de la E muestra el texto del manual');
    // Renombrar el manual desde la E (manda su texto tal cual): lo conserva.
    a = await (await patch([{ titulo: 'Plaza', texto: '' }, { titulo: 'Baches y pozos', texto: '' }, { titulo: 'A mano', texto: 'Uno a mano.' }])).json();
    assert.deepEqual([a.vista.temas[2].nombre, a.vista.temas[2].texto], ['A mano', 'Uno a mano.']);
    let r = await patch([{ titulo: 'Plaza', texto: 'Le escribo texto' }, { titulo: 'Baches y pozos', texto: '' }, { titulo: 'A mano', texto: 'Uno a mano.' }]);
    assert.equal(r.status, 400, 'un tema del modelo no lleva texto');
    assert.match((await r.json()).error, /no llevan texto/);
    r = await patch([{ titulo: 'Plaza', texto: '' }]);
    assert.equal(r.status, 400, 'sacar uno del modelo no se puede');
  });

  test('PATCH sobre un análisis v1 (fase E): la lista entera, limpia, como siempre', async () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/VIEJO/' });
    db.finishAnalisis(id, 'instagram', {
      analizados: 3,
      tonos: { positivos: 2, neutrales: 1, negativos: 0, ruido: 0 },
      resultado: { lecturaEstrategica: 'De antes.' },
      temas: [{ titulo: 'Viejo', texto: 'x', comentarios: [1] }],
      comentarios: [1, 2, 3].map((n) => ({ n, usuario: `u${n}`, verificada: false, likes: n, fecha: null, texto: 't', tono: 'positivo', tipo: 'vecino' })),
    });
    const ok = await pedir(`/api/analisis/${id}/temas?plataforma=instagram`, {
      method: 'PATCH',
      body: { temas: [{ titulo: '  Baches  ', texto: 'Calles rotas', comentarios: [3, 1, 1, 400] }, { titulo: 'Nuevo', texto: '' }] },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(db.getAnalisis(id, 'instagram').temas, [
      { titulo: 'Baches', texto: 'Calles rotas', comentarios: [1, 3] },
      { titulo: 'Nuevo', texto: '', comentarios: [] },
    ]);
    // La galería se entera (antes quedaba con la estrella vieja).
    assert.equal(db.listAnalisisGaleria({ plataforma: 'instagram', limit: 200 }).items.find((x) => x.id === id).temaEstrella, 'Baches');
    const muchos = await pedir(`/api/analisis/${id}/temas?plataforma=instagram`, { method: 'PATCH', body: { temas: Array.from({ length: 9 }, () => ({ titulo: 't' })) } });
    assert.equal(muchos.status, 400);
    const a = await (await pedir(`/api/analisis/${id}?plataforma=instagram`)).json();
    assert.equal(a.vista.version, 1);
    assert.equal(a.vista.disponible.postura, false);
    assert.match(a.informe, /3\) \*Postura hacia la gestión:\* no disponible/);
    assert.equal(a.temas[0].titulo, 'Baches', 'un v1 conserva su lista');
  });

  test('la galería por la ruta: filtro, búsqueda, total y desde', async () => {
    const todos = await (await pedir('/api/analisis?plataforma=instagram&limit=100')).json();
    assert.ok(todos.total >= todos.recientes.length);
    assert.ok(todos.desde);
    const conHecho = await (await pedir('/api/analisis?plataforma=instagram&f=ev&limit=100')).json();
    assert.ok(conHecho.recientes.length > 0 && conHecho.recientes.every((a) => a.tieneHecho));
    const buscado = await (await pedir(`/api/analisis?plataforma=instagram&q=${encodeURIComponent('PLAZA ITALIA')}`)).json();
    assert.ok(buscado.recientes.length > 0 && buscado.recientes.every((a) => a.temaEstrella === 'Plaza Italia'));
  });

  test('los CSV: comentarios siempre, reclamos solo si hubo', async () => {
    const id = await analizar('https://www.instagram.com/p/CSV1/');
    const r = await pedir(`/api/analisis/${id}/comentarios.csv?plataforma=instagram`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="comentarios-gcba-\d{4}-\d{2}-\d{2}\.csv"$/);
    const crudo = Buffer.from(await r.arrayBuffer()); // .text() se come el BOM
    assert.deepEqual([...crudo.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'con el BOM para Excel');
    const texto = crudo.toString('utf8');
    assert.equal(texto.trim().split('\n').length, 26);
    const rec = await pedir(`/api/analisis/${id}/reclamos.csv?plataforma=instagram`);
    assert.equal(rec.status, 200);
    assert.match(await rec.text(), /"vecino2","Salta 250"/);
    respuestaComentarios = commentItems(25).map((c) => (c.ownerUsername === 'vecino2' ? { ...c, ownerUsername: 'vecino2b' } : c));
    const sinRec = await analizar('https://www.instagram.com/p/CSV2/');
    assert.equal((await pedir(`/api/analisis/${sinRec}/reclamos.csv?plataforma=instagram`)).status, 404);
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

  test('figuras públicas: alta, repetida, mal puesta, confirmar una sugerida, borrar; el correo no sale', async () => {
    assert.equal((await pedir('/api/figuras', { conCookie: false })).status, 401);
    const alta = await pedir('/api/figuras', { method: 'POST', body: { username: '@Leg.Uno', nombre: 'Legisladora Uno', rol: 'legislador', alineacion: 'oposicion' } });
    assert.equal(alta.status, 201);
    const { figura } = await alta.json();
    assert.equal(figura.username, 'leg.uno');
    assert.equal(figura.origen, 'equipo');
    assert.equal('creadoPor' in figura, false);
    assert.equal(db.getFigura('leg.uno').creadoPor, 'prueba@test.local', 'queda en la base');
    assert.equal((await pedir('/api/figuras', { method: 'POST', body: { username: 'leg.uno', nombre: 'Otra', rol: 'medio' } })).status, 409);
    const mal = await pedir('/api/figuras', { method: 'POST', body: { username: 'a b', nombre: 'x', rol: 'legislador' } });
    assert.equal(mal.status, 400);
    assert.ok((await mal.json()).error);
    assert.equal((await pedir('/api/figuras', { method: 'POST', body: { username: 'otra', nombre: 'x', rol: 'astronauta' } })).status, 400);

    db.upsertFiguraSugerida({ username: 'medio.sugerido', rol: 'medio', alineacion: 'oficialismo' });
    const lista = await (await pedir('/api/figuras')).json();
    assert.ok(lista.figuras.every((f) => !('creadoPor' in f)));
    assert.equal(lista.figuras.find((f) => f.username === 'medio.sugerido').origen, 'sugerida');
    assert.equal(lista.roles.legislador, 'Legislador/a');
    assert.ok(lista.rolesConAlineacion.includes('periodista'));
    const confirmada = await pedir('/api/figuras/medio.sugerido', { method: 'PATCH', body: { nombre: 'Medio Sugerido' } });
    assert.equal(confirmada.status, 200);
    assert.equal((await confirmada.json()).figura.origen, 'equipo');
    assert.equal((await pedir('/api/figuras/nadie', { method: 'PATCH', body: { nombre: 'x' } })).status, 404);
    assert.equal((await pedir('/api/figuras/leg.uno', { method: 'DELETE' })).status, 204);
    assert.equal((await pedir('/api/figuras/leg.uno', { method: 'DELETE' })).status, 404);
  });

  test('figuras públicas (F2): descartar una sugerida, no una del equipo; restaurarla', async () => {
    db.upsertFiguraSugerida({ username: 'cre.sugerido', rol: 'creador' });
    assert.equal((await pedir('/api/figuras/cre.sugerido/descartar', { method: 'POST', conCookie: false })).status, 401);
    const desc = await pedir('/api/figuras/cre.sugerido/descartar', { method: 'POST' });
    assert.equal(desc.status, 200);
    const { figura } = await desc.json();
    assert.equal(figura.origen, 'descartada');
    assert.equal('creadoPor' in figura, false);
    const otra = await pedir('/api/figuras/cre.sugerido/descartar', { method: 'POST' });
    assert.equal(otra.status, 409);
    assert.match((await otra.json()).error, /ya estaba descartada/);
    assert.equal((await pedir('/api/figuras/medio.sugerido/descartar', { method: 'POST' })).status, 409, 'una del equipo no se descarta');
    assert.equal((await pedir('/api/figuras/nadie/descartar', { method: 'POST' })).status, 404);
    const restaurada = await pedir('/api/figuras/cre.sugerido', { method: 'PATCH', body: {} });
    assert.equal((await restaurada.json()).figura.origen, 'equipo');
  });
});

describe('la confirmación (fase G)', { concurrency: false }, () => {
  afterEach(() => delete process.env.ANALISIS_CONFIRMAR_MS);
  const arrancar = (code, extra = {}) => {
    respuestaPost = postItem({ shortCode: code, ...extra });
    return analysisJob.start({ url: `https://www.instagram.com/p/${code}/`, analizadoPor: 'prueba@test.local' }).id;
  };
  const pasosDe = (id) => Object.fromEntries(progress.getView(id, 'instagram').pasos.map((p) => [p.key, `${p.estado} · ${p.detalle}`]));

  test('Instagram dice 0 comentarios: "sin comentarios" sin pedir la corrida de los comentarios', async () => {
    const id = arrancar('CERO1', { commentsCount: 0 });
    await analysisJob.waitFor(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'sin comentarios');
    assert.deepEqual(llamadasApify.map(([k]) => k), ['post'], 'solo la publicación');
    assert.equal(pasosDe(id).comentarios, 'omitido · Instagram informa 0 comentarios');
  });

  test('con más de 1.000: la publicación una vez, la espera con las dos opciones y, con "parcial", 625 pedidos y hasta 1.000 al modelo', async () => {
    respuestaComentarios = commentItems(1200);
    const id = arrancar('MUCHOS2', { commentsCount: 5200 });
    const view = await hastaQueEspere(id);
    assert.equal(view.confirmacion.comentarios, 5200);
    assert.deepEqual(
      view.confirmacion.opciones.map((o) => [o.alcance, o.items, o.completo]),
      [
        ['todo', 3000, false],
        ['parcial', 1000, false],
      ]
    );
    assert.ok(view.confirmacion.opciones.every((o) => o.total > 0));
    assert.ok(view.confirmacion.venceAt);
    assert.match(pasosDe(id).confirmar, /^en curso · 5\.200 comentarios · elegí cuántos analizar$/);
    assert.deepEqual(llamadasApify.map(([k]) => k), ['post'], 'antes de confirmar no se pidieron los comentarios');
    assert.equal(db.getAnalisis(id, 'instagram').cuenta, 'gcba', 'la publicación ya quedó guardada');

    assert.equal(analysisJob.confirmar(id, 'parcial', { quien: 'prueba@test.local' }), 'ok');
    await analysisJob.waitFor(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'ok');
    assert.deepEqual(llamadasApify.map(([k, , n]) => [k, n ?? null]), [['post', null], ['comments', 625]], 'la publicación no se pidió dos veces');
    assert.equal(a.enviados, 1000, 'al modelo, hasta 1.000');
    assert.match(pasosDe(id).confirmar, /^ok · 1\.000 de 5\.200 · ~US\$ \d+,\d\d estimado$/);
  });

  test('"todo" con 2.500 comentarios: se piden los 2.500 y el paso dice "todos"', async () => {
    const id = arrancar('MUCHOS3', { commentsCount: 2500 });
    await hastaQueEspere(id);
    analysisJob.confirmar(id, 'todo', { quien: 'prueba@test.local' });
    await analysisJob.waitFor(id);
    assert.deepEqual(llamadasApify[1], ['comments', 'https://www.instagram.com/p/MUCHOS3/', 2500]);
    assert.match(pasosDe(id).confirmar, /^ok · todos · ~US\$/);
  });

  test('cancelar: no se piden los comentarios y queda "cancelado"', async () => {
    const id = arrancar('MUCHOS4', { commentsCount: 1500 });
    await hastaQueEspere(id);
    assert.equal(analysisJob.confirmar(id, 'cancelar', { quien: 'prueba@test.local' }), 'ok');
    await analysisJob.waitFor(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'cancelado');
    assert.equal(a.error, analysisJob.MENSAJE_CANCELADO);
    assert.deepEqual(llamadasApify.map(([k]) => k), ['post']);
    assert.equal(progress.getView(id, 'instagram').confirmacion, null);
  });

  test('si nadie confirma, vence: "cancelado" con el aviso y sin gastar más', async () => {
    process.env.ANALISIS_CONFIRMAR_MS = '40';
    const id = arrancar('MUCHOS5', { commentsCount: 4000 });
    await analysisJob.waitFor(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'cancelado');
    assert.equal(a.error, analysisJob.MENSAJE_VENCIDO);
    assert.deepEqual(llamadasApify.map(([k]) => k), ['post']);
    assert.equal(pasosDe(id).confirmar, 'omitido · venció la espera');
  });

  test('solo confirma quien lo arrancó; uno que no espera, o una opción que no se ofreció, no', async () => {
    const id = arrancar('MUCHOS6', { commentsCount: 1800 });
    await hastaQueEspere(id);
    assert.equal(analysisJob.confirmar(id, 'todo', { quien: 'otra@test.local' }), 'ajeno');
    assert.equal(analysisJob.confirmar(id, 'todo', { quien: null }), 'ajeno', 'sin sesión tampoco');
    assert.equal(analysisJob.confirmar(999999, 'todo', { quien: 'prueba@test.local' }), 'no-espera');
    assert.equal(analysisJob.confirmar(id, 'cancelar', { quien: 'prueba@test.local' }), 'ok');
    await analysisJob.waitFor(id);
  });
});
