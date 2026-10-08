'use strict';

// Progreso real del ciclo en curso (src/monitoringProgress.js): módulo puro,
// en memoria, sin DB ni red — se prueba solo. Ver Cambio B (progreso real en
// "Actualizar ahora").

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const progress = require('../src/monitoringProgress');

describe('monitoringProgress', () => {
  beforeEach(() => {
    progress.endCycle(); // por si un test anterior dejó un ciclo a medias
  });

  test('sin ciclo arrancado, getProgress es null', () => {
    assert.equal(progress.getProgress(), null);
  });

  test('startCycle sin ninguna fase todavía: sigue siendo null (nada que mostrar)', () => {
    progress.startCycle();
    assert.equal(progress.getProgress(), null);
  });

  test('una fase con total 0 no se anuncia: getProgress sigue null', () => {
    progress.startCycle();
    progress.startPhase('Detectando posteos nuevos', 0);
    assert.equal(progress.getProgress(), null);
  });

  test('startPhase + tick: contador y porcentaje reales de una sola fase', () => {
    progress.startCycle();
    progress.startPhase('Cuentas trackeadas', 4);
    assert.deepEqual(progress.getProgress(), { phase: 'Cuentas trackeadas', done: 0, total: 4, percent: 0 });
    progress.tick();
    assert.deepEqual(progress.getProgress(), { phase: 'Cuentas trackeadas', done: 1, total: 4, percent: 25 });
    progress.tick(2);
    assert.deepEqual(progress.getProgress(), { phase: 'Cuentas trackeadas', done: 3, total: 4, percent: 75 });
    progress.tick();
    assert.deepEqual(progress.getProgress(), { phase: 'Cuentas trackeadas', done: 4, total: 4, percent: 100 });
  });

  test('tick no pasa del total de su fase (llamadas de más no rompen el contador)', () => {
    progress.startCycle();
    progress.startPhase('Hashtags', 2);
    progress.tick(5);
    assert.deepEqual(progress.getProgress(), { phase: 'Hashtags', done: 2, total: 2, percent: 100 });
  });

  test('el porcentaje es GLOBAL: una fase nueva suma su trabajo al total conocido y puede bajar el % hasta que avance', () => {
    progress.startCycle();
    progress.startPhase('Cuentas trackeadas', 4);
    progress.tick(4);
    assert.equal(progress.getProgress().percent, 100); // 4/4

    progress.startPhase('Refrescando métricas', 6);
    // ahora el trabajo conocido es 4+6=10, completado sigue en 4 -> 40%, y la
    // fase visible es la nueva, arrancando en 0.
    assert.deepEqual(progress.getProgress(), { phase: 'Refrescando métricas', done: 0, total: 6, percent: 40 });
    progress.tick(6);
    assert.deepEqual(progress.getProgress(), { phase: 'Refrescando métricas', done: 6, total: 6, percent: 100 });
  });

  test('una fase que no cuenta en el porcentaje (las fotos): se muestra con su contador y el % no se mueve', () => {
    progress.startCycle();
    progress.startPhase('Refrescando métricas', 4);
    progress.tick(4);
    assert.deepEqual(progress.getProgress(), { phase: 'Refrescando métricas', done: 4, total: 4, percent: 100 });

    // Antes: 4 hechos sobre 4 + 150 conocidos, la barra volvía al 3 %.
    progress.startPhase('Guardando fotos', 150, { countsInPercent: false });
    assert.deepEqual(progress.getProgress(), { phase: 'Guardando fotos', done: 0, total: 150, percent: 100 });
    progress.tick(60);
    assert.deepEqual(progress.getProgress(), { phase: 'Guardando fotos', done: 60, total: 150, percent: 100 });

    // Una fase común que arranca después sigue con la cuenta de siempre,
    // sin el trabajo de las fotos.
    progress.startPhase('Calculando benchmark de cuentas', 4);
    assert.deepEqual(progress.getProgress(), { phase: 'Calculando benchmark de cuentas', done: 0, total: 4, percent: 50 });
  });

  test('al principio del ciclo, una fase que no cuenta deja el % en 0', () => {
    progress.startCycle();
    progress.startPhase('Guardando fotos pendientes', 10, { countsInPercent: false });
    progress.tick(10);
    assert.deepEqual(progress.getProgress(), { phase: 'Guardando fotos pendientes', done: 10, total: 10, percent: 0 });
  });

  test('tick con ok: null avanza el contador sin contarlo como bien ni como error', () => {
    const lineas = [];
    const original = console.log;
    console.log = (...args) => lineas.push(args.join(' '));
    try {
      progress.startCycle();
      progress.startPhase('Guardando fotos', 5, { countsInPercent: false });
      progress.tick(2);
      progress.tick(1, { ok: false });
      progress.tick(2, { ok: null });
      assert.deepEqual(progress.getProgress(), { phase: 'Guardando fotos', done: 5, total: 5, percent: 0 });
      progress.endCycle();
    } finally {
      console.log = original;
    }
    assert.ok(lineas.some((l) => /termina Guardando fotos \(\d+ms, 2 ok, 1 error, 5\/5\)/.test(l)), lineas.join(' | '));
  });

  test('endCycle limpia todo: vuelve a null aunque haya habido una fase en curso', () => {
    progress.startCycle();
    progress.startPhase('Clasificando relevancia', 3);
    progress.tick();
    progress.endCycle();
    assert.equal(progress.getProgress(), null);
  });

  test('tick sin ciclo/fase activa no tira (llamada de más, inofensiva)', () => {
    assert.doesNotThrow(() => progress.tick());
    progress.startCycle();
    assert.doesNotThrow(() => progress.tick());
  });
});
