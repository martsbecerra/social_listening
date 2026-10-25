'use strict';

// El costo estimado de un análisis (src/analysisCost.js), el que muestra la
// confirmación con más de 1.000 comentarios. Puro: sin base, sin Apify,
// sin modelo. Las cuentas, a mano en cada test.

delete process.env.ANALISIS_USD_POR_COMENTARIO;
delete process.env.ANALISIS_USD_FIJO;
delete process.env.ANALISIS_CONFIRMAR_DESDE;

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { estimarAnalisis, opcionesDeConfirmacion, confirmarDesde } = require('../src/analysisCost');

const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} ≠ ${b}`);
const STARTER = 0.0023;

afterEach(() => {
  delete process.env.ANALISIS_USD_POR_COMENTARIO;
  delete process.env.ANALISIS_USD_FIJO;
  delete process.env.ANALISIS_CONFIRMAR_DESDE;
});

describe('el costo estimado', () => {
  test('Apify por ítem a la tarifa que se pasa; el modelo, 0,0021 por comentario más 0,06', () => {
    const e = estimarAnalisis(1000, { usdPorItemApify: STARTER });
    cerca(e.apify, 2.3, 'apify');
    cerca(e.modelo, 1000 * 0.0021 + 0.06, 'modelo');
    cerca(e.total, 2.3 + 2.16, 'total');
    assert.equal(e.items, 1000);
  });

  test('el modelo clasifica hasta lo que se le pasa; sin nada que clasificar, no cuesta', () => {
    cerca(estimarAnalisis(4000, { usdPorItemApify: STARTER, analizar: 3000 }).modelo, 3000 * 0.0021 + 0.06);
    assert.equal(estimarAnalisis(0, { usdPorItemApify: STARTER }).total, 0);
  });

  test('las tarifas del modelo y el corte salen del .env (con coma decimal); un valor raro vuelve al de siempre', () => {
    process.env.ANALISIS_USD_POR_COMENTARIO = '0,003';
    process.env.ANALISIS_USD_FIJO = '0.1';
    cerca(estimarAnalisis(100, { usdPorItemApify: 0 }).modelo, 0.4);
    process.env.ANALISIS_USD_FIJO = '-1';
    cerca(estimarAnalisis(100, { usdPorItemApify: 0 }).modelo, 0.36);
    assert.equal(confirmarDesde(), 1000);
    process.env.ANALISIS_CONFIRMAR_DESDE = '1500';
    assert.equal(confirmarDesde(), 1500);
  });
});

describe('las opciones de la confirmación', () => {
  const OPTS = { tope: 3000, topeAnalisis: 3000, usdPorItemApify: STARTER };

  test('5.200 comentarios: "todo" llega al tope (3.000, no entran todos) y "parcial" es 1.000', () => {
    const [todo, parcial] = opcionesDeConfirmacion(5200, OPTS);
    assert.deepEqual([todo.alcance, todo.items, todo.completo], ['todo', 3000, false]);
    cerca(todo.total, 3000 * STARTER + 3000 * 0.0021 + 0.06, 'todo');
    assert.deepEqual([parcial.alcance, parcial.items, parcial.completo], ['parcial', 1000, false]);
    cerca(parcial.total, 1000 * STARTER + 1000 * 0.0021 + 0.06, 'parcial');
  });

  test('2.500 comentarios: "todo" entra entero', () => {
    const opciones = opcionesDeConfirmacion(2500, OPTS);
    assert.deepEqual(
      opciones.map((o) => [o.alcance, o.items, o.completo]),
      [
        ['todo', 2500, true],
        ['parcial', 1000, false],
      ]
    );
  });

  test('con 1.000 o menos no hay opción parcial (no hace falta confirmar)', () => {
    assert.deepEqual(opcionesDeConfirmacion(1000, OPTS).map((o) => o.alcance), ['todo']);
  });

  test('el modelo clasifica hasta COMMENTS_ANALYSIS_LIMIT aunque se traigan más', () => {
    const [todo] = opcionesDeConfirmacion(5200, { ...OPTS, topeAnalisis: 2000 });
    cerca(todo.modelo, 2000 * 0.0021 + 0.06);
    cerca(todo.apify, 3000 * STARTER);
  });
});
