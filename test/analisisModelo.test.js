'use strict';

// El análisis con el modelo (src/analyzeComments.js): tandas de 100
// comentarios por llamada y una síntesis; una tanda caída deja sus
// comentarios sin clasificar y el resto sigue; "analizados" son los
// clasificados de verdad; los temas traen solo números de comentarios que
// existen; los tonos van en cantidades simples y el informe con su
// ponderado; los reclamos conservan su gestión al re-analizar. El LLM y la
// subcategoría stubeados por el objeto del módulo; base y registro de
// cuentas en temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-modelo-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.ACCOUNT_REGISTRY_PATH = path.join(tmp, 'account-types.json');
delete process.env.COMMENTS_ANALYSIS_LIMIT;

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const llm = require('../src/llm');
const clasificarReclamo = require('../src/clasificarReclamo');
const { analyzeComments } = require('../src/analyzeComments');
const { updateAccountRegistry, loadAccountRegistry } = require('../src/accountRegistry');

const URL = 'https://www.instagram.com/p/TEST/';
const POST = { ownerFullName: 'GCBA', ownerUsername: 'gcba', caption: 'Anuncio', likesCount: 900, commentsCount: 1480, videoPlayCount: null };

function comentarios(n, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    apifyId: `c${i + 1}`,
    username: `vecino${i + 1}`,
    isVerified: false,
    // Likes distintos y decrecientes: la muestra queda en este mismo orden.
    likesCount: 1000 - i,
    timestamp: null,
    text: `Comentario número ${i + 1} sobre la plaza`,
    ...extra(i),
  }));
}

// La lista de comentarios de un prompt de tanda: "N. @usuario (...)".
function numerosDelPrompt(userPrompt) {
  return [...userPrompt.matchAll(/^(\d+)\. @(\S+)/gm)].map((m) => [Number(m[1]), m[2]]);
}

let llamadas;
let tandaFalla;
let errorDeTanda;
let omitir;
let temas;
let subcategoria;
function stubModelo() {
  llm.requestStructuredAnalysis = async ({ schemaName, userPrompt }) => {
    llamadas.push({ schemaName, userPrompt });
    if (schemaName === 'tanda_instagram') {
      const numero = Number(/tanda (\d+) de/.exec(userPrompt)[1]);
      if (tandaFalla === numero) throw errorDeTanda || new Error('se cayó la tanda');
      const lista = numerosDelPrompt(userPrompt);
      return {
        parsed: {
          classifications: lista
            .filter(([n]) => !omitir.has(`${numero}:${n}`))
            .map(([n, user]) => ({
              index: n,
              sentiment: Number(user.replace('vecino', '')) % 3 === 0 ? 'negativo' : 'positivo',
              accountType: 'vecino',
              reclamosGeo: user === 'vecino5' ? [{ direccionDetectada: 'Salta 250', direccionNormalizada: 'Salta 250', tematica: 'bache', categoria: 'Infraestructura', tipoUbicacion: 'calle_altura' }] : [],
            })),
        },
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.01 },
      };
    }
    return {
      parsed: {
        posteoSobre: 'Un anuncio de la plaza',
        insightApoyo: ['@vecino1 apoyo', '@vecino2 apoyo'],
        insightCriticas: ['@vecino3 crítica'],
        insightReclamos: ['@vecino5 bache'],
        insightMedios: [],
        posturaAudiencia: 'Mayormente a favor.',
        lecturaEstrategica: 'La plaza gusta.',
        temasConversacion: temas,
      },
      usage: { inputTokens: 3000, outputTokens: 800, totalTokens: 3800, costUsd: 0.02 },
    };
  };
  clasificarReclamo.asignarSubcategorias = async (lista) => ({ subcategorias: lista.map(() => subcategoria), usage: null, llamadas: 0 });
}

function pasosQueAnotan() {
  const eventos = [];
  const anotar = (tipo) => (key, detalle) => eventos.push([tipo, key, detalle]);
  return { eventos, pasos: { start: anotar('start'), update: anotar('update'), done: anotar('done'), skip: anotar('skip'), fail: anotar('fail') } };
}

beforeEach(() => {
  llamadas = [];
  tandaFalla = null;
  errorDeTanda = null;
  subcategoria = '';
  omitir = new Set();
  temas = [
    { titulo: 'La plaza', texto: 'Hablan de la plaza.', comentarios: [1, 2, 2, 999, 0, 3] },
    { titulo: '', texto: 'sin título', comentarios: [1] },
  ];
  stubModelo();
});

describe('tandas y síntesis', { concurrency: false }, () => {
  test('250 comentarios: tres tandas (100, 100, 50) numeradas desde 1 y una síntesis', async () => {
    const { pasos, eventos } = pasosQueAnotan();
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(250), pasos });
    const tandas = llamadas.filter((l) => l.schemaName === 'tanda_instagram');
    assert.equal(tandas.length, 3);
    assert.deepEqual(tandas.map((l) => numerosDelPrompt(l.userPrompt).length).sort((a, b) => b - a), [100, 100, 50]);
    for (const l of tandas) assert.equal(numerosDelPrompt(l.userPrompt)[0][0], 1, 'cada tanda arranca en 1');
    assert.equal(llamadas.filter((l) => l.schemaName === 'sintesis_instagram').length, 1);
    assert.equal(r.numeros.analizados, 250);
    assert.equal(r.numeros.enviados, 250);
    assert.equal(r.numeros.tandas, 3);
    assert.equal(r.numeros.fallidas, 0);
    // El paso del tono avanza con números reales y termina con lo clasificado.
    const tono = eventos.filter(([, key]) => key === 'tono');
    assert.deepEqual(tono[0], ['start', 'tono', '0 de 250']);
    assert.ok(tono.some(([tipo, , d]) => tipo === 'update' && /^(100|200|250|50|150) de 250$/.test(d)));
    assert.match(tono[tono.length - 1][2], /^250 clasificados · \d+ s$/);
    assert.equal(r.tokenUsage.totalTokens, 3 * 1500 + 3800);
  });

  test('una tanda que falla deja sus comentarios sin clasificar y el análisis sigue', async () => {
    tandaFalla = 2;
    const { pasos, eventos } = pasosQueAnotan();
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(250), pasos });
    assert.equal(r.numeros.analizados, 150);
    assert.equal(r.numeros.fallidas, 1);
    assert.equal(r.classifications.filter((c) => c === null).length, 100);
    const sintesis = llamadas.find((l) => l.schemaName === 'sintesis_instagram').userPrompt;
    assert.match(sintesis, /\[sin clasificar\]/);
    assert.match(eventos.filter(([, key]) => key === 'tono').pop()[2], /una tanda falló/);
    // El contador del tono suma solo lo clasificado: nunca llega a 250.
    const avances = eventos.filter(([tipo, key]) => tipo === 'update' && key === 'tono').map(([, , d]) => Number(d.split(' ')[0]));
    assert.equal(Math.max(...avances), 150);
  });

  test('un tema no nombra comentarios de una tanda caída', async () => {
    tandaFalla = 2;
    temas = [{ titulo: 'La plaza', texto: 'Hablan de la plaza.', comentarios: [1, 100, 101, 150, 200, 201] }];
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(250) });
    assert.deepEqual(r.qualitative.temasConversacion[0].comentarios, [1, 100, 201]);
  });

  test('lo que el modelo no devolvió no cuenta como analizado', async () => {
    omitir = new Set(['1:1', '1:7']);
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(40) });
    assert.equal(r.numeros.analizados, 38);
    assert.equal(r.classifications[0], null);
    const t = r.tonos;
    assert.equal(t.positivos + t.neutrales + t.negativos + t.ruido, 38);
  });

  test('si fallan todas las tandas, tira con un mensaje para la persona', async () => {
    tandaFalla = 1;
    await assert.rejects(analyzeComments({ url: URL, post: POST, comments: comentarios(30) }), (err) => Boolean(err.userMessage));
    assert.equal(llamadas.filter((l) => l.schemaName === 'sintesis_instagram').length, 0);
  });

  test('si fallan todas las tandas, el mensaje es el del proveedor (sin crédito no se arregla reintentando)', async () => {
    tandaFalla = 1;
    errorDeTanda = Object.assign(new Error('402'), { userMessage: 'Tu cuenta de OpenRouter no tiene crédito suficiente.' });
    await assert.rejects(analyzeComments({ url: URL, post: POST, comments: comentarios(30) }), (err) => err.userMessage === 'Tu cuenta de OpenRouter no tiene crédito suficiente.');
  });

  test('si falla la síntesis, tira', async () => {
    llm.requestStructuredAnalysis = async ({ schemaName, userPrompt }) => {
      if (schemaName === 'sintesis_instagram') throw new Error('se cayó la síntesis');
      const lista = numerosDelPrompt(userPrompt);
      return { parsed: { classifications: lista.map(([n]) => ({ index: n, sentiment: 'neutral', accountType: 'vecino', reclamosGeo: [] })) }, usage: null };
    };
    await assert.rejects(analyzeComments({ url: URL, post: POST, comments: comentarios(10) }), (err) => Boolean(err.userMessage));
  });

  test('si falla la síntesis, el error lleva lo ya gastado en las tandas', async () => {
    const tandaSola = llm.requestStructuredAnalysis;
    llm.requestStructuredAnalysis = async (args) => {
      if (args.schemaName === 'sintesis_instagram') throw new Error('se cayó la síntesis');
      return tandaSola(args);
    };
    await assert.rejects(analyzeComments({ url: URL, post: POST, comments: comentarios(250) }), (err) => {
      assert.equal(err.tokenUsage.totalTokens, 3 * 1500);
      assert.ok(Math.abs(err.tokenUsage.costUsd - 0.03) < 1e-9);
      return true;
    });
  });
});

describe('temas, tonos e informe', { concurrency: false }, () => {
  test('los temas se quedan con los números válidos de la muestra, sin repetidos', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(20) });
    assert.deepEqual(r.qualitative.temasConversacion, [{ titulo: 'La plaza', texto: 'Hablan de la plaza.', comentarios: [1, 2, 3] }]);
    assert.match(r.report, /TEMAS DE LA CONVERSACIÓN/);
    assert.match(r.report, /1\. La plaza: Hablan de la plaza\./);
  });

  test('tonos simples; el informe con su ponderado; muestra parcial con los números reales', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(30) });
    // vecinoN con N múltiplo de 3 es negativo: 10 de 30.
    assert.deepEqual(r.tonos, { positivos: 20, neutrales: 0, negativos: 10, ruido: 0 });
    assert.equal(r.metricas.positivoPct, 67);
    assert.equal(r.metricas.negativoPct, 33);
    assert.match(r.report, /Análisis realizado sobre 30 de 1\.480 comentarios\./);
    assert.doesNotMatch(r.report, /priorizadas/, 'la muestra no la recortó la app');
  });

  test('si la app recortó la muestra, el informe dice cómo se priorizó', async () => {
    process.env.COMMENTS_ANALYSIS_LIMIT = '20';
    try {
      const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(30) });
      assert.equal(r.numeros.enviados, 20);
      assert.match(r.report, /Análisis realizado sobre 20 de 1\.480 comentarios \(priorizadas cuentas verificadas y comentarios con más likes\)\./);
    } finally {
      delete process.env.COMMENTS_ANALYSIS_LIMIT;
    }
  });

  test('los reclamos se guardan y, al re-analizar, conservan su gestión', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(12) });
    assert.equal(r.reclamos, 1);
    db.updateEstado('ig:c5', 'Resuelto');
    await analyzeComments({ url: URL, post: POST, comments: comentarios(12) });
    const fila = db.listReclamosFiltered({ plataforma: 'instagram' }).find((x) => x.id === 'ig:c5');
    assert.equal(fila.estado, 'Resuelto');
  });

  test('re-analizar sin subcategoría (la llamada falló) no borra la que ya tenía el reclamo', async () => {
    subcategoria = 'Reclamos por falta de mantenimiento en obras de la Ciudad';
    await analyzeComments({ url: URL, post: POST, comments: comentarios(12) });
    const subDe = () => db.listReclamosFiltered({ plataforma: 'instagram' }).find((x) => x.id === 'ig:c5').subcategoria;
    assert.equal(subDe(), 'Reclamos por falta de mantenimiento en obras de la Ciudad');
    subcategoria = '';
    await analyzeComments({ url: URL, post: POST, comments: comentarios(12) });
    assert.equal(subDe(), 'Reclamos por falta de mantenimiento en obras de la Ciudad');
  });

  test('el registro de cuentas: dos actualizaciones a la vez no se pisan', async () => {
    await Promise.all([
      updateAccountRegistry((r) => (r.accounts.cuentauno = { accountType: 'periodista' })),
      updateAccountRegistry((r) => (r.accounts.cuentados = { accountType: 'oficial' })),
    ]);
    const r = await loadAccountRegistry();
    assert.equal(r.accounts.cuentauno.accountType, 'periodista');
    assert.equal(r.accounts.cuentados.accountType, 'oficial');
  });

  test('el registro: un rename que Windows rechaza un momento se reintenta; si no hay caso, no queda el temporal', async () => {
    const fsp = require('fs/promises');
    const original = fsp.rename;
    const dir = path.dirname(process.env.ACCOUNT_REGISTRY_PATH);
    const temporales = () => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    let fallas = 2;
    fsp.rename = async (...args) => {
      if (fallas-- > 0) throw Object.assign(new Error('ocupado'), { code: 'EPERM' });
      return original(...args);
    };
    try {
      await updateAccountRegistry((r) => (r.accounts.cuentatres = { accountType: 'vecino' }));
      assert.equal((await loadAccountRegistry()).accounts.cuentatres.accountType, 'vecino');
      fsp.rename = async () => {
        throw Object.assign(new Error('ocupado'), { code: 'EPERM' });
      };
      await assert.rejects(updateAccountRegistry((r) => (r.accounts.cuentacuatro = { accountType: 'vecino' })), /ocupado/);
      assert.deepEqual(temporales(), []);
    } finally {
      fsp.rename = original;
    }
  });

  test('sin reclamos, el paso queda omitido', async () => {
    const { pasos, eventos } = pasosQueAnotan();
    await analyzeComments({ url: URL, post: POST, comments: comentarios(4), pasos });
    assert.deepEqual(eventos.find(([, key]) => key === 'reclamos'), ['skip', 'reclamos', 'sin reclamos con ubicación']);
  });
});
