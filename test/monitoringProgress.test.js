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
    // Y la pantalla tampoco tiene nada que mostrar: nunca corrió un ciclo.
    assert.equal(progress.getView(), null);
  });

  test('startCycle sin ninguna fase todavía: sigue siendo null (nada que mostrar)', () => {
    progress.startCycle();
    assert.equal(progress.getProgress(), null);
  });

  test('una fase con total 0 no se anuncia: getProgress sigue null', () => {
    progress.startCycle();
    progress.startPhase('Buscando posteos nuevos', 0);
    assert.equal(progress.getProgress(), null);
    assert.equal(progress.getView(), null);
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

// Lo que dibuja la pantalla de "Actualizar ahora" (getView): la fase con su
// contador y las últimas líneas, ya escritas para una persona.
describe('monitoringProgress: líneas para la pantalla', () => {
  const TERMS = ['macri', 'blackri', 'blacri', 'GCBA', 'PDLC', 'gobierno de la ciudad', 'gobierno porteño', 'jorgemacri'];
  const run = (label, detail = 'buscando…') => ({ state: 'run', label, detail });
  const ok = (label, detail) => ({ state: 'ok', label, detail });
  const err = (label, detail) => ({ state: 'err', label, detail });
  const lines = () => progress.getView().lines;

  function startSearches() {
    progress.startCycle();
    progress.startPhase('Buscando posteos nuevos', TERMS.length, { suffix: 'listas', summary: false });
    for (const term of TERMS) progress.startItem(`busqueda:${term}`, `«${term}»`, 'buscando…');
  }
  const finish = (term, detail, isOk = true) => {
    progress.finishItem(`busqueda:${term}`, { ok: isOk, detail });
    progress.tick(1, { ok: isOk });
  };

  beforeEach(() => {
    progress.endCycle();
  });

  test('la cabecera: fase, contador con su palabra ("5 de 8 listas") y porcentaje', () => {
    startSearches();
    const { lines: _lines, ...head } = progress.getView();
    assert.deepEqual(head, { phase: 'Buscando posteos nuevos', done: 0, total: 8, suffix: 'listas', percent: 0 });
    for (const term of TERMS.slice(0, 5)) finish(term, '1 encontrado, ninguno nuevo');
    const { lines: _after, ...later } = progress.getView();
    assert.deepEqual(later, { phase: 'Buscando posteos nuevos', done: 5, total: 8, suffix: 'listas', percent: 63 });
    // Una fase sin palabra propia: suffix vacío.
    progress.startPhase('Clasificando relevancia', 3);
    assert.equal(progress.getView().suffix, '');
    // getProgress (lo que usa el aviso de ciclo trabado) no cambia de forma.
    assert.deepEqual(progress.getProgress(), { phase: 'Clasificando relevancia', done: 0, total: 3, percent: 45 }); // 5 de 8 + 3
  });

  test('búsquedas en paralelo: lo que está en curso ocupa como mucho 3 líneas (las dos primeras y "y N más")', () => {
    startSearches();
    assert.deepEqual(lines(), [run('«macri»'), run('«blackri»'), run('y 6 más')]);
    assert.equal(progress.VIEW_MAX_RUNNING, 3);

    // Con 3 en curso o menos, se nombran todas.
    for (const term of ['blackri', 'blacri', 'macri', 'jorgemacri', 'GCBA']) finish(term, '3 encontrados, ninguno nuevo');
    assert.deepEqual(lines().filter((l) => l.state === 'run'), [run('«PDLC»'), run('«gobierno de la ciudad»'), run('«gobierno porteño»')]);
  });

  test('lo terminado va arriba, en el orden en que terminó, con su resultado; una búsqueda que falla sale con ✕', () => {
    startSearches();
    finish('blacri', 'sin resultados');
    finish('blackri', '3 encontrados, ninguno nuevo');
    finish('macri', '50 encontrados, 6 nuevos');
    assert.deepEqual(lines(), [
      ok('«blacri»', 'sin resultados'),
      ok('«blackri»', '3 encontrados, ninguno nuevo'),
      ok('«macri»', '50 encontrados, 6 nuevos'),
      run('«GCBA»'),
      run('«PDLC»'),
      run('y 3 más'),
    ]);

    finish('PDLC', 'falló', false);
    finish('GCBA', '50 encontrados, 2 nuevos');
    // Seis líneas como mucho: tres en curso dejan lugar para las tres
    // últimas que terminaron (las más viejas salen de la vista).
    assert.equal(progress.VIEW_MAX_LINES, 6);
    assert.deepEqual(lines(), [
      ok('«macri»', '50 encontrados, 6 nuevos'),
      err('«PDLC»', 'falló'),
      ok('«GCBA»', '50 encontrados, 2 nuevos'),
      run('«gobierno de la ciudad»'),
      run('«gobierno porteño»'),
      run('«jorgemacri»'),
    ]);

    finish('jorgemacri', '28 encontrados, ninguno nuevo');
    finish('gobierno de la ciudad', '37 encontrados, 2 nuevos');
    finish('gobierno porteño', '41 encontrados, 1 nuevo');
    assert.deepEqual(lines(), [
      ok('«macri»', '50 encontrados, 6 nuevos'),
      err('«PDLC»', 'falló'),
      ok('«GCBA»', '50 encontrados, 2 nuevos'),
      ok('«jorgemacri»', '28 encontrados, ninguno nuevo'),
      ok('«gobierno de la ciudad»', '37 encontrados, 2 nuevos'),
      ok('«gobierno porteño»', '41 encontrados, 1 nuevo'),
    ]);
  });

  test('cada fase deja su resumen al terminar: el que le pasa quien la corre, o uno genérico con el contador', () => {
    startSearches();
    for (const term of TERMS) finish(term, '1 encontrado, 1 nuevo');

    // La detección no deja resumen propio (summary: false): sus líneas son
    // las de cada búsqueda. Un resumen pedido para ella no hace nada.
    progress.setPhaseSummary('Buscando posteos nuevos', { detail: 'no va' });
    progress.startPhase('Detalle de búsquedas', 11);
    assert.equal(lines().length, 6);
    assert.ok(lines().every((l) => l.label.startsWith('«')), 'solo búsquedas hasta acá');

    progress.tick(11);
    progress.setPhaseSummary('Detalle de búsquedas', { detail: '11 posteos nuevos' });
    progress.startPhase('Clasificando relevancia', 11);
    assert.deepEqual(lines().at(-1), ok('Detalle de búsquedas', '11 posteos nuevos'));

    // Con otro nombre para la línea.
    progress.tick(11);
    progress.setPhaseSummary('Clasificando relevancia', { label: 'Relevancia', detail: '4 relevantes, 7 descartados' });
    // Un resumen para una fase que no es la visible (no llegó a anunciarse) se ignora.
    progress.setPhaseSummary('Calculando benchmark de cuentas', { label: 'Benchmark de cuentas', detail: '3 cuentas' });
    progress.startPhase('Guardando fotos', 4, { countsInPercent: false });
    assert.deepEqual(lines().at(-1), ok('Relevancia', '4 relevantes, 7 descartados'));

    // Sin resumen propio: uno genérico, con los errores si los hubo.
    progress.tick(3);
    progress.tick(1, { ok: false });
    progress.startPhase('Refrescando métricas', 150);
    assert.deepEqual(lines().at(-1), ok('Guardando fotos', '4 de 4, 1 con error'));

    // Una fase que falló entera.
    progress.tick(150, { ok: false });
    progress.setPhaseSummary('Refrescando métricas', { label: 'Métricas', detail: 'falló', ok: false });
    progress.startPhase('Guardando fotos', 2, { countsInPercent: false });
    assert.deepEqual(lines().at(-1), err('Métricas', 'falló'));
    // Y la genérica de una fase donde todo salió mal también va con ✕.
    progress.tick(2, { ok: false });
    progress.endCycle();
    assert.deepEqual(progress.getView().lines.at(-1), err('Guardando fotos', '2 de 2, 2 con error'));
  });

  test('terminado el ciclo queda su cierre (finished) con la última fase resumida, hasta que arranca otro', () => {
    progress.startCycle();
    progress.startPhase('Buscando posteos nuevos', 2, { suffix: 'listas', summary: false });
    progress.startItem('a', '«macri»', 'buscando…');
    progress.startItem('b', '«GCBA»', 'buscando…');
    progress.finishItem('a', { ok: true, detail: '50 encontrados, 6 nuevos' });
    progress.tick();
    progress.startPhase('Refrescando métricas', 150);
    progress.tick(148);
    progress.tick(2, { ok: false });
    progress.setPhaseSummary('Refrescando métricas', { label: 'Métricas', detail: '148 actualizadas, 2 sin respuesta' });
    // Con el ciclo en curso todavía no hay resumen de la fase visible.
    assert.deepEqual(lines(), [ok('«macri»', '50 encontrados, 6 nuevos'), run('«GCBA»')]);

    progress.endCycle();
    assert.equal(progress.getProgress(), null, 'getProgress sigue siendo solo del ciclo en curso');
    assert.deepEqual(progress.getView(), {
      finished: true,
      // La búsqueda que nunca terminó no va al cierre.
      lines: [ok('«macri»', '50 encontrados, 6 nuevos'), ok('Métricas', '148 actualizadas, 2 sin respuesta')],
    });
    // Se puede consultar las veces que haga falta.
    assert.equal(progress.getView().finished, true);

    // Al arrancar otro ciclo el cierre anterior desaparece.
    progress.startCycle();
    assert.equal(progress.getView(), null);
    progress.startPhase('Buscando posteos nuevos', 1, { suffix: 'listas', summary: false });
    assert.deepEqual(progress.getView().lines, []);
  });

  test('sin ciclo, las líneas no hacen nada ni tiran; cerrar algo que no está en curso tampoco', () => {
    assert.doesNotThrow(() => progress.startItem('x', '«x»', 'buscando…'));
    assert.doesNotThrow(() => progress.finishItem('x', { ok: true, detail: 'nada' }));
    assert.doesNotThrow(() => progress.setPhaseSummary('Refrescando métricas', { detail: 'nada' }));
    progress.startCycle();
    progress.startPhase('Buscando posteos nuevos', 1, { suffix: 'listas', summary: false });
    progress.finishItem('no-existe', { ok: true, detail: 'nada' });
    progress.startItem('x', '«x»', 'buscando…');
    progress.finishItem('x', { ok: false, detail: 'falló' });
    progress.finishItem('x', { ok: true, detail: 'segunda vez: no cambia' });
    assert.deepEqual(lines(), [err('«x»', 'falló')]);
  });
});
