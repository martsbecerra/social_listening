'use strict';

// Las métricas del análisis (src/analysisMetrics.js) y lo que sale de ellas
// (src/reportBuilder.js: el informe de 8 puntos y el CSV de comentarios).
// Puro: filas armadas a mano, sin base ni modelo. Los números esperados
// están calculados a mano en los comentarios de cada test.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAnalysisView, columnasDeVista, emojisDe, UMBRAL_HECHO } = require('../src/analysisMetrics');
const { buildInforme, buildComentariosCsv } = require('../src/reportBuilder');

const T0 = Date.parse('2026-10-19T13:00:00.000Z');
const en = (h) => new Date(T0 + h * 3600e3).toISOString();

// 20 comentarios: 8 del churrero (fuera del posteo, temas 1 y 4, el 4 unido
// al 1), 6 del parque, 2 de los árboles, 2 pedidos, 1 ruido y 1 sin clasificar.
function comentariosV2() {
  const c = [];
  const churro = [
    ['leg1', true, 500, 'negativo', 1, 'Mientras inauguran, le sacan el carrito al churrero. @gcba @GCBA 😡😡', 0.1],
    ['vecino2', false, 300, 'negativo', 4, 'Devuélvanle el carrito a Don Ramón #DonRamon', 0.5],
    ['vecino3', false, 200, 'negativo', 1, 'Lo vimos todos 🤦‍♂️ @gcba', 1],
    ['vecino4', false, 100, 'negativo', 4, 'Vergüenza #donramon', 1.5],
    ['vecino5', false, 50, 'negativo', 1, 'Un laburante sin su carrito @leg1.', 2],
    ['vecino6', false, 40, 'negativo', 4, 'Van por los que menos tienen', 3],
    ['vecino7', false, 30, 'negativo', 1, 'Papelón', 4],
    ['vecino8', false, 20, 'neutral', 4, '¿Qué pasó con el churrero?', 5],
  ];
  churro.forEach(([usuario, verificada, likes, tono, tema, texto, h]) =>
    c.push({ usuario, verificada, likes, tono, postura: 'critica', tema, sobrePosteo: false, pedido: false, texto, fecha: en(h) })
  );
  const parque = [
    ['vecina9', false, 80, 'Hermoso el lago 👏🏽', 6],
    ['medio2', true, 70, 'Recorrimos el parque renovado ❤️', 7],
    ['jc6', false, 60, 'Gracias a los vecinos', 8],
    ['vecina12', false, 5, 'Impecable', 9],
    ['vecina13', false, 4, 'Muy lindo', 10],
    ['vecina14', false, 3, 'Golazo 🙂', 11],
  ];
  parque.forEach(([usuario, verificada, likes, texto, h]) =>
    c.push({ usuario, verificada, likes, tono: 'positivo', postura: 'favor', tema: 2, sobrePosteo: true, pedido: false, texto, fecha: en(h) })
  );
  c.push({ usuario: 'vecina15', verificada: false, likes: 15, tono: 'positivo', postura: 'favor', tema: 3, sobrePosteo: true, pedido: false, texto: 'Los árboles 🌳', fecha: en(20) });
  c.push({ usuario: 'vecina16', verificada: false, likes: 0, tono: 'positivo', postura: 'favor', tema: 3, sobrePosteo: true, pedido: false, texto: 'Qué lindo', fecha: en(30) });
  c.push({ usuario: 'vecina17', verificada: false, likes: 9, tono: 'neutral', postura: 'neutra', tema: 2, sobrePosteo: true, pedido: true, texto: '¿Va a haber baños?', fecha: en(40) });
  c.push({ usuario: 'vecina18', verificada: false, likes: 1, tono: 'neutral', postura: 'neutra', tema: 2, sobrePosteo: true, pedido: true, texto: '¿Y baños públicos?', fecha: en(47) });
  c.push({ usuario: 'bot19', verificada: false, likes: 0, tono: 'ruido', postura: 'neutra', tema: null, sobrePosteo: false, pedido: false, texto: 'Seguime y ganá', fecha: en(47.5) });
  c.push({ usuario: 'nadie20', verificada: false, likes: 2, tono: null, postura: null, tema: null, sobrePosteo: null, pedido: null, texto: 'sin clasificar', fecha: en(47.9) });
  return c.map((x, i) => ({ n: i + 1, ...x }));
}

function filaV2(extra = {}) {
  return {
    id: 7,
    url: 'https://www.instagram.com/p/PRUEBA1/',
    cuenta: 'jorgemacri',
    postType: 'reel',
    caption: 'Reabrimos el Parque Centenario renovado.',
    postedAt: en(0),
    finishedAt: en(48),
    likes: 24600,
    comentariosTotal: 1284,
    traidos: 20,
    analizados: 19,
    usdApify: 0.7,
    usdModelo: 0.34,
    resultado: {
      version: 2,
      lectura: 'La obra gusta, pero domina lo del churrero.',
      hecho: { temaId: 4, titulo: 'Le sacaron el carrito a un churrero', descripcion: 'Un video del operativo.' },
      pedidos: [
        { texto: 'Baños en el parque', ids: [17, 18, 99] },
        { texto: 'Qué pasó con el churrero', ids: [2, 3, 4] },
        { texto: 'Uno que no existe', ids: [99] },
      ],
      queMirar: 'Responder sobre el churrero.',
    },
    temas: {
      version: 2,
      lista: [
        { id: 1, nombre: 'Vendedor de churros' },
        { id: 2, nombre: 'Parque y obra' },
        { id: 3, nombre: 'Árboles y lago' },
        { id: 4, nombre: 'Churrero', unidoA: 1 },
        { id: 5, nombre: 'Baños', manual: true, texto: 'Piden baños.' },
      ],
    },
    comentarios: comentariosV2(),
    cuando: { tramos: [{ h: 0, n: 5 }], unidadHoras: 6, pico: { indice: 0, h: 0, n: 5 } },
    ...extra,
  };
}

const FIGURAS = new Map([
  ['leg1', { nombre: 'Ana Leg', rol: 'legislador', alineacion: 'oposicion', origen: 'equipo' }],
  ['jc6', { nombre: 'Junta Comunal 6', rol: 'junta_comunal', alineacion: 'oficialismo', origen: 'sugerida' }],
]);

describe('las métricas de un análisis v2', () => {
  const v = buildAnalysisView(filaV2(), { figuras: FIGURAS });

  test('tono: cantidades sobre los 18 clasificados sin ruido; ponderado likes + 1; ruido y sin clasificar aparte', () => {
    assert.deepEqual([v.tono.positivos, v.tono.neutrales, v.tono.negativos, v.tono.ruido, v.tono.sinClasificar, v.tono.base], [8, 3, 7, 1, 1, 18]);
    assert.ok(Math.abs(v.tono.proporcion.negativo - 7 / 18) < 1e-9);
    // negativos: 501+301+201+101+51+41+31 = 1227 de 1505 (positivos 245, neutrales 33).
    assert.ok(Math.abs(v.tono.ponderado.negativo - 1227 / 1505) < 1e-9);
    assert.ok(Math.abs(v.tono.ponderado.positivo - 245 / 1505) < 1e-9);
    assert.equal(v.tono.neto, 6, 'round((8 - 7) / 18 * 100)');
  });

  test('postura y "hablan del posteo", con los desvíos por tema', () => {
    assert.deepEqual([v.postura.favor, v.postura.neutra, v.postura.critica, v.postura.base], [8, 2, 8, 18]);
    assert.deepEqual([v.sobrePosteo.si, v.sobrePosteo.no, v.sobrePosteo.base], [10, 8, 18]);
    assert.deepEqual(
      v.sobrePosteo.desvios.map((d) => [d.tema, d.n]),
      [['Vendedor de churros', 8]],
      'el tema 4 se unió al 1'
    );
  });

  test('temas: el unido suma, el manual va al final sin conteo, el primero es la estrella', () => {
    assert.deepEqual(
      v.temas.map((t) => [t.nombre, t.n, t.estrella]),
      [
        ['Vendedor de churros', 8, true],
        ['Parque y obra', 8, false],
        ['Árboles y lago', 2, false],
        ['Baños', null, false],
      ]
    );
    assert.deepEqual(v.temas[0].tonos, { positivo: 0, neutral: 1, negativo: 7 });
    assert.deepEqual(v.temas[1].tonos, { positivo: 6, neutral: 2, negativo: 0 });
  });

  test('hecho dominante: 8 de 19 analizados, 1.240 de 1.489 likes, un verificado, los 3 con más likes', () => {
    assert.equal(v.hecho.tema, 'Vendedor de churros');
    assert.equal(v.hecho.titulo, 'Le sacaron el carrito a un churrero');
    assert.ok(Math.abs(v.hecho.proporcion - 8 / 19) < 1e-9);
    assert.ok(Math.abs(v.hecho.proporcionLikes - 1240 / 1489) < 1e-9);
    assert.equal(v.hecho.verificados, 1);
    assert.deepEqual(
      v.hecho.ejemplos.map((c) => c.n),
      [1, 2, 3]
    );
    assert.ok(Math.abs(v.hecho.desdeHoras - 0.1) < 1e-9);
    assert.equal(v.sinHecho, null);
    assert.equal(v.queMirar, 'Responder sobre el churrero.');
  });

  test('sin hecho: debajo del 20 % o sobre otro tema que no es el principal fuera del posteo, la versión calma', () => {
    const chico = buildAnalysisView(filaV2({ analizados: 50 }));
    assert.ok(8 / 50 < UMBRAL_HECHO);
    assert.equal(chico.hecho, null);
    assert.equal(chico.sinHecho.tema, 'Vendedor de churros');
    assert.equal(chico.sinHecho.temas.length, 3);
    const otro = buildAnalysisView(filaV2({ resultado: { ...filaV2().resultado, hecho: { temaId: 2, titulo: 'x', descripcion: 'y' } } }));
    assert.equal(otro.hecho, null);
    const ninguno = buildAnalysisView(filaV2({ resultado: { ...filaV2().resultado, hecho: null } }));
    assert.equal(ninguno.hecho, null);
  });

  test('quién habló: los verificados y las figuras de la tabla aunque no tengan tilde, por likes', () => {
    assert.deepEqual(
      v.quienHablo.map((q) => [q.usuario, q.verificada, q.figura && q.figura.rol]),
      [
        ['leg1', true, 'legislador'],
        ['medio2', true, null],
        ['jc6', false, 'junta_comunal'],
      ]
    );
    assert.equal(v.quienHablo[0].comentario.likes, 500);
  });

  test('pedidos: solo números que existen, el ejemplo con más likes, si es del hecho', () => {
    assert.deepEqual(
      v.pedidos.map((p) => [p.texto, p.n, p.delHecho]),
      [
        ['Qué pasó con el churrero', 3, true],
        ['Baños en el parque', 2, false],
      ]
    );
    assert.equal(v.pedidos[1].ejemplo, '¿Va a haber baños?');
  });

  test('etiquetas: una vez por comentario, sin el punto final; hashtags sin mayúsculas', () => {
    assert.deepEqual(v.etiquetas.cuentas, [
      { cuenta: '@gcba', n: 2, verificadaQueComento: false },
      { cuenta: '@leg1', n: 1, verificadaQueComento: true },
    ]);
    assert.deepEqual(v.etiquetas.hashtags, [{ tag: '#DonRamon', n: 2 }]);
    assert.equal(v.etiquetas.comentarios, 3);
  });

  test('emojis: sin tonos de piel ni selector; una secuencia con ZWJ cuenta por el primero; apoyo y bronca', () => {
    assert.deepEqual(emojisDe('👏🏽 ❤️ 🤦‍♂️'), ['👏', '❤', '🤦']);
    assert.equal(v.emojis.lista[0].emoji, '😡');
    assert.equal(v.emojis.lista[0].n, 2);
    assert.equal(v.emojis.apoyo, 3, '👏 ❤ 🌳');
    assert.equal(v.emojis.bronca, 3, '😡 😡 🤦');
  });

  test('los que más pegaron: 6 por likes, con los del hecho marcados', () => {
    assert.deepEqual(
      v.top.map((c) => [c.n, c.delHecho]),
      [
        [1, true],
        [2, true],
        [3, true],
        [4, true],
        [9, false],
        [10, false],
      ]
    );
  });

  test('el tiempo: primer comentario a 6 min, el 50 % a las 7 h, 5 en las últimas 24 h', () => {
    assert.equal(v.tiempo.primeroMin, 6);
    assert.ok(Math.abs(v.tiempo.mitadHoras - 7) < 1e-9);
    assert.equal(v.tiempo.ultimas24, 5);
    assert.equal(v.tiempo.sigueVivo, true);
    assert.equal(v.tiempo.picoHoras, 0);
  });

  test('comparación: primero de la cuenta; con anteriores, promedios y la serie de negativos', () => {
    assert.equal(v.comparacion.primero, true);
    const anteriores = [
      {
        id: 50,
        pctNeg: 30,
        comentariosTotal: 700,
        nVerificados: 1,
        comentarios: [true, true, true, false].map((s, i) => ({ n: i + 1, tono: 'positivo', sobrePosteo: s })),
        temas: { version: 2, lista: [] },
      },
      { id: 40, pctNeg: 20, comentariosTotal: 500, nVerificados: 0, comentarios: [{ n: 1, tono: 'positivo' }], temas: [] },
    ];
    const c = buildAnalysisView(filaV2(), { anteriores }).comparacion;
    assert.equal(c.primero, false);
    assert.equal(c.n, 2);
    assert.deepEqual(c.promedio, { neg: 25, comentarios: 600, verificados: 0.5, sobrePosteo: 75 });
    assert.deepEqual(
      c.serie.map((p) => [p.id, p.neg, p.actual]),
      [
        [40, 20, false],
        [50, 30, false],
        [7, 38.9, true],
      ]
    );
    assert.ok(Math.abs(c.actual.sobrePosteo - (10 / 18) * 100) < 1e-9);
  });

  test('el costo y las columnas de la galería', () => {
    assert.deepEqual(v.costo, { apify: 0.7, modelo: 0.34, total: 1.04 });
    assert.deepEqual(columnasDeVista(v), { pctNeg: 38.9, tieneHecho: true, nVerificados: 2, temaEstrella: 'Vendedor de churros' });
  });
});

describe('un análisis v1 (fase E) se sigue abriendo', () => {
  const fila = {
    id: 3,
    url: 'https://www.instagram.com/p/VIEJO/',
    cuenta: 'gcba',
    postedAt: en(0),
    finishedAt: en(30),
    analizados: 4,
    comentariosTotal: 10,
    resultado: { posteoSobre: 'x', lecturaEstrategica: 'La lectura de antes.' },
    temas: [
      { titulo: 'Tránsito', texto: 'Quejas.', comentarios: [1, 2, 2, 9] },
      { titulo: 'Plaza', texto: 'Elogios.', comentarios: [3] },
    ],
    comentarios: [
      { n: 1, usuario: 'a', verificada: true, likes: 10, fecha: en(1), texto: 'Un caos @gcba', tono: 'negativo', tipo: 'vecino' },
      { n: 2, usuario: 'b', verificada: false, likes: 5, fecha: en(2), texto: 'Lo mismo', tono: 'negativo', tipo: 'vecino' },
      { n: 3, usuario: 'c', verificada: false, likes: 1, fecha: en(3), texto: 'Linda 👏', tono: 'positivo', tipo: 'vecino' },
      { n: 4, usuario: 'd', verificada: false, likes: 0, fecha: en(4), texto: 'jaja', tono: 'neutral', tipo: 'vecino' },
    ],
    cuando: null,
  };
  const v = buildAnalysisView(fila);

  test('lo que se puede contar con sus comentarios, y los bloques v2 no disponibles', () => {
    assert.equal(v.version, 1);
    assert.deepEqual(v.disponible, { postura: false, sobrePosteo: false, hecho: false, pedidos: false });
    assert.equal(v.postura, null);
    assert.equal(v.sobrePosteo, null);
    assert.equal(v.pedidos, null);
    assert.equal(v.hecho, null);
    assert.deepEqual([v.tono.positivos, v.tono.neutrales, v.tono.negativos], [1, 1, 2]);
    assert.deepEqual(
      v.temas.map((t) => [t.nombre, t.n, t.estrella]),
      [
        ['Tránsito', 2, true],
        ['Plaza', 1, false],
      ]
    );
    assert.equal(v.sinHecho.tema, 'Tránsito');
    assert.equal(v.lectura, 'La lectura de antes.');
    assert.equal(v.quienHablo.length, 1);
    assert.equal(v.etiquetas.cuentas[0].cuenta, '@gcba');
    assert.equal(v.comentarios[0].tema, 'Tránsito');
  });

  test('el informe dice "no disponible" en lo que no tiene', () => {
    const t = buildInforme(v);
    assert.match(t, /1\) \*Lo que pasó:\* no disponible en este análisis/);
    assert.match(t, /3\) \*Postura hacia la gestión:\* no disponible/);
    assert.match(t, /5\) \*Temas:\* Tránsito \(2\), Plaza \(1\)/);
    assert.match(t, /8\) \*Lectura:\* La lectura de antes\./);
  });
});

describe('el informe de 8 puntos y el CSV de comentarios', () => {
  const v = buildAnalysisView(filaV2(), { figuras: FIGURAS });
  const t = buildInforme(v);

  test('los 8 puntos con los números de la pantalla', () => {
    assert.match(t, /^\*Análisis de publicación · @jorgemacri · 19\/10\*/);
    assert.match(t, /♥ 24\.600 · 💬 1\.284 comentarios \(19 analizados\)/);
    assert.match(t, /1\) \*Lo que pasó:\* el 42 % de los comentarios habla de un mismo hecho ajeno al posteo: Le sacaron el carrito a un churrero\./);
    assert.match(t, /2\) \*Tono:\* 44 % positivo · 17 % neutro · 39 % negativo \(tono neto \+6\)/);
    assert.match(t, /3\) \*Postura hacia la gestión:\* 44 % a favor · 11 % neutra · 44 % crítica/);
    assert.match(t, /4\) \*Hablan del posteo:\* 56 % · se desvían a: Vendedor de churros/);
    assert.match(t, /5\) \*Temas:\* Vendedor de churros \(8\), Parque y obra \(8\), Árboles y lago \(2\), Baños: Piden baños\./);
    // El rol solo si es del equipo: la sugerida va como @usuario.
    assert.match(t, /6\) \*Quién habló:\* 2 verificados — Ana Leg \(Legislador\/a · oposición\), @medio2 · figuras públicas sin tilde: @jc6/);
    assert.match(t, /7\) \*Pedidos:\* Qué pasó con el churrero \(3\) · Baños en el parque \(2\)/);
    assert.match(t, /8\) \*Lectura:\* La obra gusta, pero domina lo del churrero\./);
    assert.match(t, /• @leg1: “Mientras inauguran/);
    assert.match(t, /_Social Listening · DGAYD · 21\/10\/2026_$/);
  });

  test('el CSV: un renglón por comentario, con la clasificación y la fecha de Argentina', () => {
    const csv = buildComentariosCsv(v).trim().split('\n');
    assert.equal(csv.length, 21);
    assert.match(csv[0], /^"Número","Usuario","Verificada","Likes","Fecha \(hora de Argentina\)"/);
    assert.equal(csv[1], '"1","leg1","sí","500","19/10/2026, 10:06","0.1","negativo","crítica","Vendedor de churros","no","no","Mientras inauguran, le sacan el carrito al churrero. @gcba @GCBA 😡😡"');
    assert.match(csv[20], /"sin clasificar"/);
  });
});
