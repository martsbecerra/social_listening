'use strict';

// Estado de una corrida (src/runStatus.js, noviembre 2026, openspec/changes/
// ventana-por-fuente): puro, sin base. Una corrida con búsquedas caídas ya
// no es "ok"; los textos de lo que falló son para una persona.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../src/runStatus');

const fila = (fuente, estado, extra = {}) => ({ tipo: 'busqueda', fuente, estado, intento: 1, motivo: null, topeLleno: false, huecoDesde: null, ...extra });
const TERMINADA = { id: 7, finishedAt: '2026-11-16T15:06:00.000Z', quotaExceeded: false, errorCode: null };

describe('estadoCorrida', () => {
  test('en curso o interrumpida le ganan a todo; después cortada; después incompleta; si no, ok', () => {
    const abierta = { id: 7, finishedAt: null };
    assert.equal(rs.estadoCorrida(abierta, [], { runIdEnCurso: 7 }), 'en curso');
    assert.equal(rs.estadoCorrida(abierta, [], { runIdEnCurso: 8 }), 'interrumpida');
    assert.equal(rs.estadoCorrida(abierta, []), 'interrumpida');
    assert.equal(rs.estadoCorrida({ ...TERMINADA, quotaExceeded: true }, [fila('macri', 'fallo')]), 'cortada');
    assert.equal(rs.estadoCorrida({ ...TERMINADA, errorCode: 'AUTH_INVALID' }, []), 'incompleta');
    assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok'), fila('gcba', 'ok')]), 'ok');
    assert.equal(rs.estadoCorrida(TERMINADA, []), 'ok', 'una corrida anterior a la tabla, sin filas, sigue ok');
    assert.equal(rs.estadoCorrida(null, []), 'interrumpida');
  });

  test('incompleta: una fuente en fallo, esperando, parcial, recuperada o perdida', () => {
    for (const estado of ['fallo', 'esperando', 'parcial', 'recuperada', 'perdida']) {
      assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok'), fila('gcba', estado)]), 'incompleta', estado);
    }
    assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok'), fila('viejo', 'sin_fuente')]), 'ok', 'un término que ya no está no marca la corrida');
  });

  test('incompleta: no se buscó nada, un tope lleno sin cubrir, un hueco por el techo o el detalle caído', () => {
    assert.equal(rs.estadoCorrida(TERMINADA, [{ tipo: 'plataforma', estado: 'fallo', motivo: 'NOT_CONFIGURED' }]), 'incompleta');
    assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok', { topeLleno: true })]), 'incompleta');
    assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok', { huecoDesde: '2026-10-01T00:00:00.000Z' })]), 'incompleta');
    assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok'), { tipo: 'detalle', estado: 'fallo', motivo: 'TIMEOUT' }]), 'incompleta');
    assert.equal(rs.estadoCorrida(TERMINADA, [fila('macri', 'ok'), { tipo: 'detalle', estado: 'ok' }]), 'ok');
  });
});

describe('motivo de un fallo', () => {
  test('motivoDeFallo: del error o del texto guardado a un código corto', () => {
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('Apify: se superó el timeout de seguridad (300000ms)'), { code: 'TIMEOUT' })), 'TIMEOUT');
    assert.equal(rs.motivoDeFallo('TIMEOUT'), 'TIMEOUT');
    assert.equal(rs.motivoDeFallo('Apify respondió 502: <html><body>Bad Gateway</body></html>'), 'HTTP_502');
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('Apify respondió 502: x'), { status: 502 })), 'HTTP_502');
    assert.equal(rs.motivoDeFallo('QUOTA_EXCEEDED'), 'QUOTA_EXCEEDED');
    assert.equal(rs.motivoDeFallo(new Error('Apify respondió 403: {"error":{"message":"Monthly usage hard limit exceeded"}}')), 'QUOTA_EXCEEDED');
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('Apify respondió 401: no'), { code: 'AUTH_INVALID', status: 401 })), 'AUTH_INVALID');
    assert.equal(rs.motivoDeFallo('Apify respondió 403: forbidden'), 'AUTH_INVALID');
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('x'), { code: 'RATE_LIMITED' })), 'RATE_LIMITED');
    assert.equal(rs.motivoDeFallo('Error de red al llamar a Apify: fetch failed'), 'RED');
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('x'), { network: true })), 'RED');
    assert.equal(rs.motivoDeFallo('El run abc de Apify terminó en TIMED-OUT'), 'RUN_TIMED_OUT');
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('x'), { runStatus: 'FAILED' })), 'RUN_FAILED');
    assert.equal(rs.motivoDeFallo(Object.assign(new Error('x'), { code: 'NO_LANZADA' })), 'NO_LANZADA');
    assert.equal(rs.motivoDeFallo(new Error('algo raro')), 'ERROR');
    assert.equal(rs.motivoDeFallo(null), 'ERROR');
  });

  test('motivoTexto y motivoCorto: para una persona, sin códigos', () => {
    assert.equal(rs.motivoTexto('TIMEOUT'), 'no respondió a tiempo (la búsqueda siguió en Apify)');
    assert.equal(rs.motivoTexto('HTTP_502'), 'Apify respondió con un error (502)');
    assert.equal(rs.motivoTexto('NOT_CONFIGURED'), 'falta configuración del servidor');
    assert.equal(rs.motivoTexto('cualquier cosa'), 'falló');
    assert.equal(rs.motivoCorto('HTTP_502'), 'falló · error 502');
    assert.equal(rs.motivoCorto('RED'), 'falló · sin conexión');
    assert.equal(rs.motivoCorto('AUTH_INVALID'), 'falló · clave rechazada');
    assert.equal(rs.motivoCorto('TIMEOUT'), 'falló');
    assert.equal(rs.motivoCorto(null), 'falló');
  });
});

describe('lo que falló, en textos', () => {
  // La forma de la corrida #56 del piloto (16/11/2026): seis de ocho, con los
  // términos de hoy.
  const corrida56 = [
    fila('blacri', 'ok'),
    fila('gobierno porteño', 'fallo', { motivo: 'HTTP_502' }),
    fila('blackri', 'ok'),
    fila('macri', 'fallo', { motivo: 'HTTP_502' }),
    fila('GCBA', 'fallo', { motivo: 'TIMEOUT' }),
    fila('policía de la ciudad', 'fallo', { motivo: 'TIMEOUT' }),
    fila('gobierno de la ciudad', 'fallo', { motivo: 'TIMEOUT' }),
    fila('jorgemacri', 'fallo', { motivo: 'TIMEOUT' }),
  ];

  test('resumenFallidas: "Fallaron 6 de 8 búsquedas", los nombres y una línea por fuente', () => {
    const r = rs.resumenFallidas(corrida56);
    assert.equal(r.titulo, 'Fallaron 6 de 8 búsquedas');
    assert.equal(r.nota, 'se retoman solas');
    assert.equal(r.nombres, '«gobierno porteño», «macri», «GCBA», «policía de la ciudad» y 2 más');
    assert.equal(r.lineas.length, 6);
    assert.equal(r.lineas[0], '«gobierno porteño» · Apify respondió con un error (502)');
    assert.equal(r.lineas[2], '«GCBA» · no respondió a tiempo (la búsqueda siguió en Apify)');
    assert.deepEqual({ fallidas: r.fallidas, esperando: r.esperando, topeLleno: r.topeLleno, total: r.total }, { fallidas: 6, esperando: 0, topeLleno: 0, total: 8 });
    assert.equal(rs.resumenFallidas([fila('macri', 'ok'), fila('gcba', 'fallo', { motivo: 'RED' })]).titulo, 'Falló 1 de 2 búsquedas');
  });

  test('resumenFallidas: esperando, tope lleno, recuperadas, sin buscar; null si no hay nada que contar', () => {
    let r = rs.resumenFallidas([fila('macri', 'esperando', { motivo: 'TIMEOUT' }), fila('gcba', 'esperando'), fila('blacri', 'ok')]);
    assert.equal(r.titulo, '2 de 3 búsquedas siguen en Apify');
    assert.equal(r.nota, 'se levantan solas');

    r = rs.resumenFallidas([fila('gobierno porteño', 'ok', { topeLleno: true, tope: 50 }), fila('macri', 'ok')]);
    assert.equal(r.titulo, '«gobierno porteño» llegó al tope de 50 resultados');
    assert.equal(r.nota, 'puede faltar algo');

    r = rs.resumenFallidas([fila('GCBA', 'recuperada', { motivo: 'TIMEOUT' }), fila('macri', 'ok')]);
    assert.equal(r.titulo, 'Falló 1 de 2 búsquedas');
    assert.equal(r.nota, 'se levantó después');
    assert.deepEqual(r.lineas, ['«GCBA» · no respondió a tiempo (la búsqueda siguió en Apify) · se levantó después']);

    r = rs.resumenFallidas([{ tipo: 'plataforma', estado: 'fallo', motivo: 'NOT_CONFIGURED' }]);
    assert.equal(r.titulo, 'No se buscó nada: falta configuración del servidor');

    assert.equal(rs.resumenFallidas([fila('macri', 'ok')]), null);
    assert.equal(rs.resumenFallidas([]), null);
    assert.equal(rs.resumenFallidas(undefined), null);
  });

  test('los textos de cada lugar de la pantalla ya vienen armados: cierre del recuadro, chip, tooltip de la escucha y párrafo del Pipeline', () => {
    // Seis de ocho caídas (la #56).
    let r = rs.resumenFallidas(corrida56);
    assert.equal(r.corto, 'Fallaron 6 de 8 búsquedas');
    assert.equal(r.chip, '6 de 8 búsquedas fallaron');
    assert.equal(r.frase, 'fallaron 6 de 8 búsquedas');
    assert.equal(r.tooltip, 'Fallaron 6 de 8 búsquedas: «gobierno porteño», «macri», «GCBA», «policía de la ciudad» y 2 más.\nCada una retoma desde la última vez que anduvo.');
    assert.equal(r.pipeline, 'Fallaron 6 de 8 búsquedas: traídas, nuevas y relevantes son de las 2 que respondieron.');
    assert.equal(r.deLasQueRespondieron, 'de las 2 búsquedas que respondieron');
    assert.equal(r.respondieron, 2);

    // Una sola caída, y ninguna que respondiera.
    r = rs.resumenFallidas([fila('macri', 'fallo', { motivo: 'RED' })]);
    assert.equal(r.chip, '1 de 1 búsqueda falló');
    assert.equal(r.nota, 'se retoma sola');
    assert.equal(r.tooltip, 'Falló 1 de 1 búsqueda: «macri».\nRetoma desde la última vez que anduvo.');
    assert.equal(r.pipeline, 'Falló 1 de 1 búsqueda: no respondió ninguna.');
    assert.equal(r.deLasQueRespondieron, '');

    // Siguen en Apify.
    r = rs.resumenFallidas([fila('macri', 'esperando'), fila('gcba', 'esperando'), fila('blacri', 'ok')]);
    assert.equal(r.corto, '2 de 3 búsquedas siguen en Apify');
    assert.equal(r.chip, '2 búsquedas siguen en Apify');
    assert.equal(r.tooltip, '2 búsquedas siguen en Apify: se levantan en la próxima corrida.');
    r = rs.resumenFallidas([fila('macri', 'esperando'), fila('blacri', 'ok')]);
    assert.equal(r.chip, '1 búsqueda sigue en Apify');
    assert.equal(r.nota, 'se levanta sola');

    // Tope lleno: el título nombra la búsqueda; el rótulo corto, no.
    r = rs.resumenFallidas([fila('gobierno porteño', 'ok', { topeLleno: true, tope: 50 }), fila('macri', 'ok')]);
    assert.equal(r.corto, '1 búsqueda llegó al tope');
    assert.equal(r.chip, '1 búsqueda llegó al tope');
    assert.equal(r.tooltip, '«gobierno porteño» llegó al tope de 50 resultados: puede faltar algo.');
    assert.equal(r.pipeline, '«gobierno porteño» llegó al tope de 50 resultados: puede faltar algo.');
    r = rs.resumenFallidas([fila('a', 'ok', { topeLleno: true }), fila('b', 'ok', { topeLleno: true })]);
    assert.equal(r.titulo, '2 búsquedas llegaron al tope');

    // No se pudo pedir el detalle de los nuevos.
    r = rs.resumenFallidas([fila('macri', 'ok'), { tipo: 'detalle', estado: 'fallo', motivo: 'TIMEOUT', tope: 37 }]);
    assert.equal(r.pipeline, 'No se pudo pedir el texto de 37 resultados nuevos.');

    // No se buscó nada.
    r = rs.resumenFallidas([{ tipo: 'plataforma', estado: 'fallo', motivo: 'NOT_CONFIGURED' }]);
    assert.equal(r.tooltip, 'No se buscó nada: falta configuración del servidor.');
    assert.equal(r.pipeline, 'No se buscó nada en esta corrida: falta configuración del servidor.');
  });

  test('una búsqueda que Apify cortó y dejó algo no cuenta como "falló": respondió a medias', () => {
    // Sola: su propio título.
    let r = rs.resumenFallidas([fila('macri', 'parcial', { motivo: 'RUN_TIMED_OUT' }), fila('gcba', 'ok')]);
    assert.equal(r.titulo, 'Apify cortó 1 de 2 búsquedas');
    assert.equal(r.chip, 'Apify cortó 1 búsqueda');
    assert.equal(r.nota, 'entró lo que dejó');
    assert.equal(r.tooltip, 'Apify cortó 1 de 2 búsquedas: «macri».\nEntró lo que dejó; se vuelve a pedir en la próxima corrida.');
    assert.equal(r.pipeline, 'Apify cortó 1 de 2 búsquedas: entró lo que dejó.');
    assert.deepEqual(r.lineas, ['«macri» · Apify cortó la corrida']);
    assert.equal(r.fallidas, 0);
    assert.equal(r.respondieron, 2);

    // Con una caída de verdad: el título cuenta solo la que no respondió, y
    // los números son de las que sí (la cortada incluida).
    r = rs.resumenFallidas([
      fila('GCBA', 'fallo', { motivo: 'HTTP_502' }),
      fila('jorgemacri', 'parcial', { motivo: 'RUN_TIMED_OUT' }),
      fila('gobierno de la ciudad', 'esperando', { motivo: 'TIMEOUT' }),
      fila('gobierno porteño', 'ok', { topeLleno: true, tope: 120 }),
      fila('macri', 'ok'),
    ]);
    // La que sigue en Apify tampoco respondió: se nombra al lado, y así
    // "las 3 que respondieron" cierra con el total (5 - 1 - 1).
    assert.equal(r.titulo, 'Falló 1 de 5 búsquedas y 1 sigue en Apify');
    assert.equal(r.corto, 'Falló 1 de 5 búsquedas y 1 sigue en Apify');
    assert.equal(r.chip, '1 de 5 búsquedas falló y 1 sigue en Apify');
    assert.equal(r.frase, 'falló 1 de 5 búsquedas y 1 sigue en Apify');
    assert.equal(r.nota, 'se retoman solas');
    assert.equal(r.pipeline, 'Falló 1 de 5 búsquedas y 1 sigue en Apify: traídas, nuevas y relevantes son de las 3 que respondieron.');
    assert.equal(
      r.tooltip,
      'Falló 1 de 5 búsquedas: «GCBA».\n1 sigue en Apify: «gobierno de la ciudad»; se levanta en la próxima corrida.\nRetoma desde la última vez que anduvo.'
    );
    assert.equal(r.nombres, '«GCBA»');
    assert.deepEqual(r.lineas, [
      '«GCBA» · Apify respondió con un error (502)',
      '«jorgemacri» · Apify cortó la corrida',
      '«gobierno de la ciudad» · sigue en Apify, se levanta en la próxima corrida',
      '«gobierno porteño» · llegó al tope de 120 resultados: puede faltar algo',
    ]);
    assert.equal(
      rs.resumenParaLog([fila('GCBA', 'fallo', { motivo: 'HTTP_502' }), fila('jorgemacri', 'parcial', { motivo: 'RUN_TIMED_OUT' }), fila('macri', 'recuperada', { motivo: 'TIMEOUT' })]),
      'falló 1 de 3 búsquedas: «GCBA» HTTP_502; Apify cortó 1: «jorgemacri» RUN_TIMED_OUT; 1 se levantó después: «macri»'
    );
  });

  test('una búsqueda falló y otra sigue en Apify: el texto nombra las dos (también en plural, levantadas y con la cuota)', () => {
    // El caso de la captura aprobada el 20/11/2026: 8 búsquedas, una falló,
    // otra sigue en Apify, una cortada por Apify y una con el tope lleno.
    const ocho = [
      fila('GCBA', 'fallo', { motivo: 'HTTP_502' }),
      fila('gobierno de la ciudad', 'esperando', { motivo: 'TIMEOUT' }),
      fila('jorgemacri', 'parcial', { motivo: 'RUN_TIMED_OUT' }),
      fila('gobierno porteño', 'ok', { topeLleno: true, tope: 120 }),
      fila('macri', 'ok'),
      fila('blacri', 'ok'),
      fila('blackri', 'ok'),
      fila('policía de la ciudad', 'ok'),
    ];
    let r = rs.resumenFallidas(ocho);
    assert.equal(r.pipeline, 'Falló 1 de 8 búsquedas y 1 sigue en Apify: traídas, nuevas y relevantes son de las 6 que respondieron.');
    assert.equal(r.titulo, 'Falló 1 de 8 búsquedas y 1 sigue en Apify');
    assert.equal(r.deLasQueRespondieron, 'de las 6 búsquedas que respondieron');
    assert.deepEqual({ fallidas: r.fallidas, esperando: r.esperando, respondieron: r.respondieron, total: r.total }, { fallidas: 1, esperando: 1, respondieron: 6, total: 8 });

    // En plural, de los dos lados.
    r = rs.resumenFallidas([
      fila('a', 'fallo', { motivo: 'TIMEOUT' }),
      fila('b', 'fallo', { motivo: 'HTTP_502' }),
      fila('c', 'esperando'),
      fila('d', 'esperando'),
      fila('e', 'esperando'),
      fila('f', 'ok'),
    ]);
    assert.equal(r.titulo, 'Fallaron 2 de 6 búsquedas y 3 siguen en Apify');
    assert.equal(r.chip, '2 de 6 búsquedas fallaron y 3 siguen en Apify');
    assert.equal(r.frase, 'fallaron 2 de 6 búsquedas y 3 siguen en Apify');
    assert.equal(r.pipeline, 'Fallaron 2 de 6 búsquedas y 3 siguen en Apify: traídas, nuevas y relevantes son de la 1 que respondió.');
    assert.equal(
      r.tooltip,
      'Fallaron 2 de 6 búsquedas: «a» y «b».\n3 siguen en Apify: «c», «d» y «e»; se levantan en la próxima corrida.\nCada una retoma desde la última vez que anduvo.'
    );

    // No respondió ninguna: una falló y la otra sigue en Apify.
    r = rs.resumenFallidas([fila('a', 'fallo', { motivo: 'TIMEOUT' }), fila('b', 'esperando')]);
    assert.equal(r.pipeline, 'Falló 1 de 2 búsquedas y 1 sigue en Apify: no respondió ninguna.');

    // Una que falló y se levantó después, con otra que sigue en Apify.
    r = rs.resumenFallidas([fila('a', 'recuperada', { motivo: 'TIMEOUT' }), fila('b', 'esperando'), fila('c', 'ok')]);
    assert.equal(r.titulo, 'Falló 1 de 3 búsquedas y 1 sigue en Apify');
    assert.equal(r.nota, 'se retoman solas');
    assert.equal(
      r.tooltip,
      'Falló 1 de 3 búsquedas: «a».\n1 sigue en Apify: «b»; se levanta en la próxima corrida.\nSu resultado se levantó en una corrida posterior.'
    );

    // Cortada por la cuota: la frase de lo que falló también nombra las dos.
    r = rs.resumenFallidas([fila('a', 'fallo', { motivo: 'QUOTA_EXCEEDED' }), fila('b', 'esperando'), fila('c', 'ok')], { estado: 'cortada' });
    assert.equal(r.pipeline, 'Se cortó por la cuota de Apify: falló 1 de 3 búsquedas y 1 sigue en Apify.');

    // Un término que el ciclo salteó porque su corrida ANTERIOR sigue en
    // Apify no falló: se cuenta con las que siguen en Apify.
    const salteada = fila('macri', 'fallo', { motivo: 'SIGUE_EN_APIFY' });
    r = rs.resumenFallidas([salteada, fila('gcba', 'fallo', { motivo: 'HTTP_502' }), fila('blacri', 'ok')]);
    assert.equal(r.titulo, 'Falló 1 de 3 búsquedas y 1 sigue en Apify');
    assert.equal(r.pipeline, 'Falló 1 de 3 búsquedas y 1 sigue en Apify: traídas, nuevas y relevantes son de la 1 que respondió.');
    assert.equal(r.tooltip, 'Falló 1 de 3 búsquedas: «gcba».\n1 sigue en Apify: «macri»; se levanta en la próxima corrida.\nRetoma desde la última vez que anduvo.');
    assert.ok(r.lineas.includes('«macri» · su corrida anterior sigue en Apify'));
    assert.deepEqual({ fallidas: r.fallidas, esperando: r.esperando }, { fallidas: 1, esperando: 1 });
    r = rs.resumenFallidas([salteada, fila('gcba', 'ok')]);
    assert.equal(r.titulo, '1 de 2 búsquedas sigue en Apify');
    assert.equal(r.pipeline, '1 de 2 búsquedas sigue en Apify: se levanta en la próxima corrida.');
    assert.equal(r.fallidas, 0);
    assert.equal(rs.estadoCorrida(TERMINADA, [salteada, fila('gcba', 'ok')]), 'incompleta', 'la corrida igual no fue completa');
    assert.equal(rs.resumenParaLog([salteada, fila('gcba', 'ok')]), '1 sigue en Apify: «macri»');

    // Sin ninguna esperando, los textos de siempre.
    r = rs.resumenFallidas([fila('a', 'fallo', { motivo: 'TIMEOUT' }), fila('b', 'ok')]);
    assert.equal(r.titulo, 'Falló 1 de 2 búsquedas');
    assert.equal(r.pipeline, 'Falló 1 de 2 búsquedas: traídas, nuevas y relevantes son de la 1 que respondió.');
    assert.equal(r.tooltip, 'Falló 1 de 2 búsquedas: «a».\nRetoma desde la última vez que anduvo.');
  });

  test('cortada por la cuota: se dice siempre, con lo que falló si se sabe', () => {
    const conCaidas = rs.resumenFallidas([fila('macri', 'fallo', { motivo: 'QUOTA_EXCEEDED' }), fila('gcba', 'ok')], { estado: 'cortada' });
    assert.equal(conCaidas.corto, 'Se cortó por la cuota de Apify');
    assert.equal(conCaidas.pipeline, 'Se cortó por la cuota de Apify: falló 1 de 2 búsquedas.');
    assert.equal(conCaidas.tooltip, 'Falló 1 de 2 búsquedas: «macri».\nRetoma desde la última vez que anduvo.\nSe cortó por la cuota de Apify.');
    assert.deepEqual(conCaidas.lineas, ['«macri» · se agotó la cuota de Apify']);
    // Una corrida anterior a la tabla (sin filas) que cortó por cuota.
    const sinFilas = rs.resumenFallidas([], { estado: 'cortada' });
    assert.equal(sinFilas.tooltip, 'Se cortó por la cuota de Apify.');
    assert.equal(sinFilas.pipeline, 'Se cortó por la cuota de Apify.');
    assert.equal(sinFilas.frase, 'se cortó por la cuota de Apify');
    assert.equal(rs.resumenFallidas([], { estado: 'ok' }), null);
  });

  test('tope lleno y su segunda consulta: si sigue en Apify lo dice; si se levantó después y lo cubrió, también', () => {
    const enApify = [fila('macri', 'ok', { topeLleno: true, tope: 350 }), fila('macri', 'esperando', { intento: 2 }), fila('gcba', 'ok')];
    let r = rs.resumenFallidas(enApify);
    assert.equal(r.pipeline, '«macri» llegó al tope de 350 resultados: lo que falta sigue en Apify y se levanta en la próxima corrida.');
    assert.equal(r.tooltip, r.pipeline);
    assert.equal(r.nota, 'lo que falta sigue en Apify');
    assert.deepEqual(r.lineas, ['«macri» · llegó al tope de 350 resultados: lo que falta sigue en Apify, se levanta en la próxima corrida']);
    assert.deepEqual([r.total, r.respondieron, r.esperando, r.topeLleno], [2, 2, 0, 1], 'la segunda no es otra búsqueda');
    assert.equal(rs.resumenParaLog(enApify), 'tope lleno: «macri» (la segunda consulta sigue en Apify)');

    // Con otra que llegó al tope sin segunda consulta (no entró en el techo): puede faltar algo.
    r = rs.resumenFallidas([...enApify, fila('pdlc', 'ok', { topeLleno: true, tope: 350 })]);
    assert.equal(r.pipeline, '2 búsquedas llegaron al tope: puede faltar algo.');
    assert.equal(r.lineas[1], '«pdlc» · llegó al tope de 350 resultados: puede faltar algo');

    // La segunda se levantó después y no llenó su tope: la primera ya no está marcada.
    const cubierto = [fila('macri', 'ok', { tope: 350 }), fila('macri', 'recuperada', { intento: 2 }), fila('gcba', 'ok')];
    assert.equal(rs.estadoCorrida(TERMINADA, cubierto), 'incompleta');
    r = rs.resumenFallidas(cubierto);
    assert.equal(r.titulo, '«macri» llegó al tope de 350 resultados');
    assert.equal(r.nota, 'lo que faltaba se levantó después');
    assert.equal(r.pipeline, '«macri» llegó al tope de 350 resultados: lo que faltaba se levantó en una corrida posterior.');
    assert.deepEqual(r.lineas, ['«macri» · llegó al tope de 350 resultados · lo que faltaba se levantó después']);
    assert.equal(rs.resumenParaLog(cubierto), 'tope lleno, cubierto después: «macri»');
    // Si la segunda falló, la primera sigue con "puede faltar algo".
    const fallida = [fila('macri', 'ok', { topeLleno: true, tope: 350 }), fila('macri', 'fallo', { intento: 2, motivo: 'HTTP_502' })];
    assert.equal(rs.resumenFallidas(fallida).pipeline, '«macri» llegó al tope de 350 resultados: puede faltar algo.');
  });

  test('una segunda consulta (intento 2) no cuenta como otra fuente; en X dice "fuentes" y nombra @cuenta y #hashtag', () => {
    const conRelanzamiento = [fila('macri', 'ok'), fila('macri', 'ok', { intento: 2 }), fila('gcba', 'fallo', { motivo: 'TIMEOUT' })];
    assert.equal(rs.resumenFallidas(conRelanzamiento).titulo, 'Falló 1 de 2 búsquedas');
    const x = [
      { tipo: 'cuenta', fuente: 'jorgemacri', estado: 'fallo', intento: 1, motivo: 'RATE_LIMITED' },
      { tipo: 'hashtag', fuente: 'caba', estado: 'fallo', intento: 1, motivo: 'ERROR' },
      { tipo: 'keyword', fuente: 'macri', estado: 'ok', intento: 1 },
    ];
    const r = rs.resumenFallidas(x);
    assert.equal(r.titulo, 'Fallaron 2 de 3 fuentes');
    assert.equal(r.nombres, '@jorgemacri y #caba');
  });

  test('resumenParaLog: con los códigos, para la línea "[ciclo] fin"', () => {
    assert.equal(
      rs.resumenParaLog(corrida56),
      'fallaron 6 de 8 búsquedas: «gobierno porteño» HTTP_502, «macri» HTTP_502, «GCBA» TIMEOUT, «policía de la ciudad» TIMEOUT, «gobierno de la ciudad» TIMEOUT, «jorgemacri» TIMEOUT'
    );
    assert.equal(rs.resumenParaLog([fila('macri', 'ok')]), '');
    assert.equal(rs.resumenParaLog([fila('macri', 'esperando'), fila('gcba', 'ok', { topeLleno: true })]), '1 sigue en Apify: «macri»; tope lleno: «gcba»');
    assert.equal(rs.resumenParaLog([{ tipo: 'plataforma', estado: 'fallo', motivo: 'SIN_BUSQUEDA' }]), 'no se buscó nada (SIN_BUSQUEDA)');
  });
});
