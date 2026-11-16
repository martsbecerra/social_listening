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
  // La corrida #56 del piloto (16/11/2026): seis de ocho.
  const corrida56 = [
    fila('blacri', 'ok'),
    fila('gobierno porteño', 'fallo', { motivo: 'HTTP_502' }),
    fila('blackri', 'ok'),
    fila('macri', 'fallo', { motivo: 'HTTP_502' }),
    fila('GCBA', 'fallo', { motivo: 'TIMEOUT' }),
    fila('PDLC', 'fallo', { motivo: 'TIMEOUT' }),
    fila('gobierno de la ciudad', 'fallo', { motivo: 'TIMEOUT' }),
    fila('jorgemacri', 'fallo', { motivo: 'TIMEOUT' }),
  ];

  test('resumenFallidas: "Fallaron 6 de 8 búsquedas", los nombres y una línea por fuente', () => {
    const r = rs.resumenFallidas(corrida56);
    assert.equal(r.titulo, 'Fallaron 6 de 8 búsquedas');
    assert.equal(r.nota, 'se retoman solas');
    assert.equal(r.nombres, '«gobierno porteño», «macri», «GCBA», «PDLC» y 2 más');
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
      'fallaron 6 de 8 búsquedas: «gobierno porteño» HTTP_502, «macri» HTTP_502, «GCBA» TIMEOUT, «PDLC» TIMEOUT, «gobierno de la ciudad» TIMEOUT, «jorgemacri» TIMEOUT'
    );
    assert.equal(rs.resumenParaLog([fila('macri', 'ok')]), '');
    assert.equal(rs.resumenParaLog([fila('macri', 'esperando'), fila('gcba', 'ok', { topeLleno: true })]), '1 sigue en Apify: «macri»; tope lleno: «gcba»');
    assert.equal(rs.resumenParaLog([{ tipo: 'plataforma', estado: 'fallo', motivo: 'SIN_BUSQUEDA' }]), 'no se buscó nada (SIN_BUSQUEDA)');
  });
});
