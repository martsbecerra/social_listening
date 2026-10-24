'use strict';

// El análisis con el modelo (src/analyzeComments.js) desde la fase F: la
// primera tanda va sola y define los temas, las demás los reutilizan y
// suman nuevos que se unen por nombre; por comentario tono, postura, tema,
// sobre el posteo y pedido (sin tipo de cuenta, sin registro de cuentas);
// una tanda caída deja sus comentarios sin clasificar; los verificados se
// cruzan con las figuras públicas; la síntesis recibe los números del
// servidor y su respuesta se valida (hecho, pedidos, sugerencias solo para
// verificados sin ficha, guardadas como "sugerida"); los reclamos conservan
// su gestión al re-analizar. El LLM y la subcategoría stubeados por el
// objeto del módulo; base temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-modelo-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
delete process.env.COMMENTS_ANALYSIS_LIMIT;

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const llm = require('../src/llm');
const clasificarReclamo = require('../src/clasificarReclamo');
const { analyzeComments, BATCH_SIZE } = require('../src/analyzeComments');
const { claveTema } = require('../src/analysisMetrics');

const URL = 'https://www.instagram.com/p/TEST/';
// Tres tandas, la última por la mitad (con BATCH_SIZE 50: 125 comentarios).
const B = BATCH_SIZE;
const N = B * 2 + B / 2;
const POST = { ownerFullName: 'GCBA', ownerUsername: 'gcba', caption: 'Anuncio', likesCount: 900, commentsCount: 1480, videoPlayCount: null, postedAt: '2026-10-20T12:00:00.000Z' };

// vecino3 y vecino6 son verificados; vecino6 está en la tabla de figuras.
function comentarios(n, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    apifyId: `c${i + 1}`,
    username: `vecino${i + 1}`,
    isVerified: i + 1 === 3 || i + 1 === 6,
    // Likes distintos y decrecientes: la muestra queda en este mismo orden.
    likesCount: 1000 - i,
    timestamp: new Date(Date.parse(POST.postedAt) + (i + 1) * 60000).toISOString(),
    text: `Comentario número ${i + 1} sobre la plaza`,
    ...extra(i),
  }));
}

// La lista de comentarios de un prompt de tanda: "N. @usuario (...)".
function numerosDelPrompt(userPrompt) {
  return [...userPrompt.matchAll(/^(\d+)\. @(\S+)/gm)].map((m) => [Number(m[1]), m[2].replace(/\[.*$/, '')]);
}

let llamadas;
let terminadas;
let tandaFalla;
let errorDeTanda;
let cortadas;
let sinTemas;
let omitir;
let sintesis;
let subcategoria;
const GASTO_CORTADA = { inputTokens: 4000, outputTokens: 16000, totalTokens: 20000, costUsd: 0.17 };
function stubModelo() {
  llm.requestStructuredAnalysis = async ({ schemaName, userPrompt }) => {
    if (schemaName === 'tanda_instagram') {
      // "tanda 2 de 3" o, partida, "tanda 1.2 de 3".
      const etiqueta = /tanda ([\d.]+) de/.exec(userPrompt)[1];
      const numero = Number(etiqueta.split('.')[0]);
      llamadas.push({ schemaName, numero, etiqueta, userPrompt, conTerminadas: [...terminadas] });
      await new Promise((r) => setImmediate(r));
      if (cortadas.has(etiqueta)) throw Object.assign(new Error('la respuesta se cortó en el tope de salida'), { code: 'SALIDA_CORTADA', userMessage: 'cortada', tokenUsage: GASTO_CORTADA });
      if (tandaFalla === numero || (Array.isArray(tandaFalla) && tandaFalla.includes(numero))) throw errorDeTanda || new Error('se cayó la tanda');
      const define = /DEFINÍ LOS TEMAS/.test(userPrompt);
      const cuantos = define ? 0 : [...userPrompt.matchAll(/^(\d+)\. (?!@)/gm)].length;
      // La primera define dos temas; las demás suman "Seguridad en el parque"
      // con su número (escrito distinto: tiene que quedar uno solo).
      const temas = define
        ? sinTemas.has(numero)
          ? []
          : [
              { numero: 1, nombre: 'Plaza y obra' },
              { numero: 2, nombre: 'Churrero' },
            ]
        : [{ numero: cuantos + 1, nombre: numero === 2 ? 'Seguridad en el parque' : 'seguridad en el PARQUE ' }];
      const nuevo = define ? null : cuantos + 1;
      const lista = numerosDelPrompt(userPrompt);
      terminadas.add(etiqueta);
      return {
        parsed: {
          temas,
          classifications: lista
            .filter(([n]) => !omitir.has(`${numero}:${n}`))
            .map(([n, user]) => {
              const k = Number(user.replace('vecino', ''));
              return {
                index: n,
                sentiment: k % 3 === 0 ? 'negativo' : 'positivo',
                postura: k % 3 === 0 ? 'critica' : 'favor',
                tema: nuevo && k % 5 === 0 ? nuevo : k % 2 === 0 ? 2 : 1,
                sobre_posteo: k % 2 !== 0,
                pedido: k % 7 === 0,
                reclamosGeo: k === 5 ? [{ direccionDetectada: 'Salta 250', direccionNormalizada: 'Salta 250', tematica: 'bache', categoria: 'Infraestructura', tipoUbicacion: 'calle_altura' }] : [],
              };
            }),
        },
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.01 },
      };
    }
    llamadas.push({ schemaName, userPrompt });
    if (sintesis instanceof Error) throw sintesis;
    return { parsed: sintesis, usage: { inputTokens: 3000, outputTokens: 800, totalTokens: 3800, costUsd: 0.02 } };
  };
  clasificarReclamo.asignarSubcategorias = async (lista) => ({ subcategorias: lista.map(() => subcategoria), usage: null, llamadas: 0 });
}

function pasosQueAnotan() {
  const eventos = [];
  const anotar = (tipo) => (key, detalle, extra) => eventos.push([tipo, key, detalle, extra]);
  return { eventos, pasos: { start: anotar('start'), update: anotar('update'), done: anotar('done'), skip: anotar('skip'), fail: anotar('fail') } };
}

beforeEach(() => {
  llamadas = [];
  terminadas = new Set();
  tandaFalla = null;
  errorDeTanda = null;
  cortadas = new Set();
  sinTemas = new Set();
  subcategoria = '';
  omitir = new Set();
  sintesis = {
    lectura: 'La plaza gusta; el churrero divide.',
    hecho_dominante: { hay: true, tema: 2, titulo: 'Le sacaron el carrito al churrero', descripcion: 'Un video circuló.' },
    pedidos: [
      { texto: 'Que devuelvan el carrito', ids: [7, 14, 14, 999] },
      { texto: 'Baños', ids: [14, 21] },
    ],
    que_mirar: 'Responder sobre el churrero.',
    figuras_sugeridas: [
      { username: '@Vecino3', rol: 'periodista', alineacion: 'oposicion' },
      { username: 'vecino4', rol: 'medio', alineacion: 'ninguna' },
      { username: 'vecino6', rol: 'creador', alineacion: 'oficialismo' },
    ],
  };
  stubModelo();
});

describe('tandas y temas', { concurrency: false }, () => {
  test(`${N} comentarios: la primera tanda sola define los temas; las otras dos, en paralelo, los reusan`, async () => {
    const { pasos, eventos } = pasosQueAnotan();
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N), pasos });
    const tandas = llamadas.filter((l) => l.schemaName === 'tanda_instagram');
    assert.deepEqual(tandas.map((l) => l.numero).sort(), [1, 2, 3]);
    assert.match(tandas.find((l) => l.numero === 1).userPrompt, /DEFINÍ LOS TEMAS/);
    for (const n of [2, 3]) {
      const l = tandas.find((x) => x.numero === n);
      assert.ok(l.conTerminadas.includes('1'), `la tanda ${n} arrancó después de la 1`);
      assert.match(l.userPrompt, /LISTA DE TEMAS[^\n]*\n1\. Plaza y obra\n2\. Churrero/);
    }
    for (const l of tandas) assert.equal(numerosDelPrompt(l.userPrompt)[0][0], 1, 'cada tanda arranca en 1');
    assert.equal(llamadas.filter((l) => l.schemaName === 'sintesis_instagram').length, 1);
    assert.equal(r.numeros.analizados, N);
    assert.equal(r.numeros.tandas, 3);
    // El paso avanza con números reales y el avance para el porcentaje.
    const clas = eventos.filter(([, key]) => key === 'clasificar');
    assert.deepEqual(clas[0].slice(0, 3), ['start', 'clasificar', `0 de ${N}`]);
    assert.ok(clas.some(([tipo, , d, extra]) => tipo === 'update' && d === `${B} de ${N}` && extra && extra.avance === 0.4));
    assert.match(clas[clas.length - 1][2], new RegExp(`^${N} de ${N} · 3 tandas · \\d+ s$`));
    assert.equal(r.tokenUsage.totalTokens, 3 * 1500 + 3800);
  });

  test('dos tandas suman el mismo tema escrito distinto: queda uno solo, con los comentarios de las dos', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N) });
    assert.deepEqual(
      r.temas.lista.map((t) => t.nombre),
      ['Plaza y obra', 'Churrero', 'Seguridad en el parque']
    );
    assert.equal(claveTema('seguridad en el PARQUE '), claveTema('Seguridad  en el parque'));
    // vecinoK con K múltiplo de 5 en las tandas 2 y 3 va al tema nuevo (id 3).
    const delNuevo = r.comentarios.filter((c) => c.tema === 3).map((c) => c.usuario);
    assert.ok(delNuevo.includes(`vecino${B + 5}`) && delNuevo.includes(`vecino${2 * B + 5}`));
    assert.ok(!delNuevo.includes('vecino5'), 'en la tanda 1 ese tema no existía');
  });

  test('una tanda que se corta por larga va en dos mitades; la primera mitad de la primera define los temas', async () => {
    cortadas = new Set(['1']);
    const { pasos, eventos } = pasosQueAnotan();
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N), pasos });
    const tandas = llamadas.filter((l) => l.schemaName === 'tanda_instagram');
    assert.deepEqual(tandas.map((l) => l.etiqueta).slice(0, 3), ['1', '1.1', '1.2'], 'las mitades, una después de la otra, antes que el resto');
    assert.deepEqual(numerosDelPrompt(tandas[1].userPrompt).length, Math.ceil(B / 2));
    assert.match(tandas[1].userPrompt, /DEFINÍ LOS TEMAS/);
    assert.match(tandas[2].userPrompt, /LISTA DE TEMAS[^\n]*\n1\. Plaza y obra\n2\. Churrero/);
    assert.ok(tandas.filter((l) => l.numero > 1).every((l) => l.conTerminadas.includes('1.2')), 'las demás, después de las dos mitades');
    assert.equal(r.numeros.analizados, N);
    assert.equal(r.numeros.fallidas, 0);
    // Lo gastado en el intento cortado también cuenta.
    assert.equal(r.tokenUsage.totalTokens, GASTO_CORTADA.totalTokens + 4 * 1500 + 3800);
    assert.match(eventos.filter(([, key]) => key === 'clasificar').pop()[2], new RegExp(`^${N} de ${N} · 3 tandas`));
  });

  test('si una mitad también se corta, solo esos comentarios quedan sin clasificar', async () => {
    cortadas = new Set(['2', '2.2']);
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N) });
    assert.equal(r.numeros.analizados, N - (B - Math.ceil(B / 2)));
    assert.equal(r.numeros.fallidas, 1);
    assert.equal(r.tokenUsage.totalTokens, 2 * GASTO_CORTADA.totalTokens + 3 * 1500 + 3800);
    assert.equal(llamadas.filter((l) => l.etiqueta === '2.2.1').length, 0, 'se parte una sola vez');
  });

  test('una tanda que falla por otra cosa no se parte, y lo que gastó cuenta', async () => {
    tandaFalla = 3;
    errorDeTanda = Object.assign(new Error('JSON inválido'), { tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 } });
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N) });
    assert.equal(llamadas.filter((l) => l.schemaName === 'tanda_instagram').length, 3);
    assert.equal(r.tokenUsage.totalTokens, 150 + 2 * 1500 + 3800);
  });

  test('cada comentario: tono, postura, tema, sobre el posteo y pedido; sin tipo de cuenta', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(30) });
    // La muestra pone primero a los verificados: se busca por usuario.
    const de = (u) => r.comentarios.find((c) => c.usuario === u);
    const c3 = de('vecino3');
    assert.deepEqual(
      { tono: c3.tono, postura: c3.postura, tema: c3.tema, sobrePosteo: c3.sobrePosteo, pedido: c3.pedido, verificada: c3.verificada },
      { tono: 'negativo', postura: 'critica', tema: 1, sobrePosteo: true, pedido: false, verificada: true }
    );
    assert.equal(de('vecino7').pedido, true);
    for (const row of r.classifications) assert.equal(row.accountType, undefined);
    assert.equal(fs.existsSync(path.join(tmp, 'account-types.json')), false, 'no se escribe ningún registro de cuentas');
  });

  test('el spam queda como ruido, sin tema ni postura', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(10, (i) => (i === 0 ? { text: 'Sorteo! seguí y participá' } : {})) });
    const c1 = r.comentarios.find((c) => c.usuario === 'vecino1');
    assert.deepEqual([c1.tono, c1.tema, c1.postura, c1.pedido], ['ruido', null, 'neutra', false]);
  });

  test('una tanda que falla deja sus comentarios sin clasificar; el contador suma solo lo clasificado', async () => {
    tandaFalla = 2;
    const { pasos, eventos } = pasosQueAnotan();
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N), pasos });
    assert.equal(r.numeros.analizados, N - B);
    assert.equal(r.numeros.fallidas, 1);
    assert.equal(r.comentarios.filter((c) => c.tono === null).length, B);
    const avances = eventos.filter(([tipo, key]) => tipo === 'update' && key === 'clasificar').map(([, , d]) => Number(d.split(' ')[0]));
    assert.equal(Math.max(...avances), N - B);
    assert.match(eventos.filter(([, key]) => key === 'clasificar').pop()[2], /una tanda falló/);
  });

  test('si la primera falla, la segunda también va sola y define los temas; las demás los reusan', async () => {
    tandaFalla = 1;
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N) });
    const tandas = llamadas.filter((l) => l.schemaName === 'tanda_instagram');
    const de = (n) => tandas.find((l) => l.numero === n);
    assert.match(de(2).userPrompt, /DEFINÍ LOS TEMAS/);
    assert.ok(de(3).conTerminadas.includes('2'), 'la 3 arrancó después de la 2');
    assert.match(de(3).userPrompt, /LISTA DE TEMAS[^\n]*\n1\. Plaza y obra\n2\. Churrero/);
    // La 3 suma el suyo (el stub lo escribe así en las tandas que no son la 2).
    assert.deepEqual(
      r.temas.lista.map((t) => t.nombre),
      ['Plaza y obra', 'Churrero', 'seguridad en el PARQUE']
    );
  });

  test('si la primera no devuelve temas, la segunda va sola y los define (una sola lista)', async () => {
    sinTemas = new Set([1]);
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(N) });
    const tandas = llamadas.filter((l) => l.schemaName === 'tanda_instagram');
    assert.equal(tandas.filter((l) => /DEFINÍ LOS TEMAS/.test(l.userPrompt)).length, 2, 'la 1 (que no devolvió) y la 2');
    assert.ok(tandas.find((l) => l.numero === 3).conTerminadas.includes('2'));
    assert.equal(r.temas.lista.length, 3);
    // Los de la tanda 1 quedaron clasificados, sin tema.
    assert.ok(r.comentarios.filter((c) => c.usuario === 'vecino1' || c.usuario === 'vecino2').every((c) => c.tono !== null && c.tema === null));
  });

  test('con las dos primeras caídas, las demás van en paralelo (no se espera para siempre)', async () => {
    tandaFalla = [1, 2];
    await analyzeComments({ url: URL, post: POST, comments: comentarios(B * 4) });
    const tandas = llamadas.filter((l) => l.schemaName === 'tanda_instagram');
    assert.ok(!tandas.find((l) => l.numero === 3).conTerminadas.includes('4') && !tandas.find((l) => l.numero === 4).conTerminadas.includes('3'));
  });

  test('lo que el modelo no devolvió no cuenta como analizado', async () => {
    omitir = new Set(['1:1', '1:7']);
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(40) });
    assert.equal(r.numeros.analizados, 38);
    assert.equal(r.comentarios[0].tono, null);
  });

  test('si fallan todas, el mensaje es el del proveedor y no hay síntesis', async () => {
    tandaFalla = 1;
    errorDeTanda = Object.assign(new Error('402'), { userMessage: 'Tu cuenta de OpenRouter no tiene crédito suficiente.' });
    await assert.rejects(analyzeComments({ url: URL, post: POST, comments: comentarios(30) }), (err) => err.userMessage === 'Tu cuenta de OpenRouter no tiene crédito suficiente.');
    assert.equal(llamadas.filter((l) => l.schemaName === 'sintesis_instagram').length, 0);
  });

  test('si falla la síntesis, tira con un mensaje y lo ya gastado en las tandas', async () => {
    sintesis = Object.assign(new Error('se cayó la síntesis'), { tokenUsage: { inputTokens: 3000, outputTokens: 0, totalTokens: 3000, costUsd: 0.006 } });
    const { pasos, eventos } = pasosQueAnotan();
    await assert.rejects(analyzeComments({ url: URL, post: POST, comments: comentarios(N), pasos }), (err) => {
      assert.ok(err.userMessage);
      assert.equal(err.tokenUsage.totalTokens, 3 * 1500 + 3000, 'las tandas y la síntesis fallida');
      return true;
    });
    assert.deepEqual(eventos.filter(([, key]) => key === 'informe').pop().slice(0, 2), ['fail', 'informe']);
  });
});

describe('verificados y síntesis', { concurrency: false }, () => {
  test('los verificados se cruzan con la tabla; la síntesis recibe los números, los temas y los verificados sin ficha', async () => {
    db.createFigura({ username: 'vecino6', nombre: 'Seis', rol: 'periodista', alineacion: null });
    const { pasos, eventos } = pasosQueAnotan();
    await analyzeComments({ url: URL, post: POST, comments: comentarios(30), pasos });
    assert.equal(eventos.find(([tipo, key]) => tipo === 'done' && key === 'verificados')[2], '2 verificados · 1 figura pública');
    const prompt = llamadas.find((l) => l.schemaName === 'sintesis_instagram').userPrompt;
    // vecinoK con K múltiplo de 3 es negativo: 10 de 30.
    assert.match(prompt, /Analizados: 30 de 1480/);
    assert.match(prompt, /Tono: 20 positivos \(67 %\), 0 neutrales \(0 %\), 10 negativos \(33 %\)/);
    assert.match(prompt, /Postura hacia la gestión: 20 a favor \(67 %\), 0 neutra \(0 %\), 10 crítica \(33 %\)/);
    assert.match(prompt, /Hablan del posteo: 15 \(50 %\)/);
    assert.match(prompt, /^1\. Plaza y obra: 15 comentarios/m);
    assert.match(prompt, /^2\. Churrero: 15 comentarios · \d+ pos \/ 0 neu \/ \d+ neg · 15 fuera del posteo/m);
    assert.match(prompt, /TEMA PRINCIPAL FUERA DEL POSTEO ===\n2\. Churrero \(15 comentarios que no hablan del posteo; 50 % de los analizados\)/);
    assert.match(prompt, /VERIFICADOS SIN FICHA ===\n@vecino3\n/);
    assert.match(prompt, /^7\. @vecino7 \[positivo · a favor · tema 1 · PEDIDO\]/m);
  });

  test('lo que vuelve se valida: pedidos con números que existen, sugerencias solo para verificados sin ficha', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(30) });
    const s = r.sintesis;
    assert.equal(s.lectura, 'La plaza gusta; el churrero divide.');
    assert.deepEqual(s.hecho, { temaId: 2, titulo: 'Le sacaron el carrito al churrero', descripcion: 'Un video circuló.' });
    assert.deepEqual(s.pedidos, [
      { texto: 'Que devuelvan el carrito', ids: [7, 14] },
      { texto: 'Baños', ids: [21] },
    ]);
    // vecino4 no es verificado y vecino6 tiene ficha: solo vecino3.
    assert.deepEqual(s.figurasSugeridas, [{ username: 'vecino3', rol: 'periodista', alineacion: 'oposicion' }]);
    assert.equal(db.getFigura('vecino3').origen, 'sugerida');
    assert.equal(db.getFigura('vecino6').rol, 'periodista', 'la del equipo no cambia');
  });

  test('un hecho sobre un tema que no existe, o sin título, no vale', async () => {
    sintesis = { ...sintesis, hecho_dominante: { hay: true, tema: 99, titulo: 'x', descripcion: 'y' } };
    assert.equal((await analyzeComments({ url: URL, post: POST, comments: comentarios(10) })).sintesis.hecho, null);
    sintesis = { ...sintesis, hecho_dominante: { hay: false, tema: 2, titulo: 'x', descripcion: 'y' } };
    assert.equal((await analyzeComments({ url: URL, post: POST, comments: comentarios(10) })).sintesis.hecho, null);
  });
});

describe('reclamos', { concurrency: false }, () => {
  test('se guardan y, al re-analizar, conservan su gestión', async () => {
    const r = await analyzeComments({ url: URL, post: POST, comments: comentarios(12) });
    assert.equal(r.reclamos, 1);
    assert.match(r.reclamosCsv, /"vecino5","Salta 250"/);
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

  test('sin reclamos, el paso queda omitido', async () => {
    const { pasos, eventos } = pasosQueAnotan();
    await analyzeComments({ url: URL, post: POST, comments: comentarios(4), pasos });
    assert.deepEqual(eventos.find(([, key]) => key === 'reclamos').slice(0, 3), ['skip', 'reclamos', 'sin reclamos con ubicación']);
  });
});
