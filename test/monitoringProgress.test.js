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
