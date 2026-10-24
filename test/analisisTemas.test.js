'use strict';

// Editar los temas de un análisis v2 (src/analysisTemas.js): puro, sin base.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { aplicarCambio, traducirListaVieja, MAX_MANUALES } = require('../src/analysisTemas');

const BASE = {
  version: 2,
  lista: [
    { id: 1, nombre: 'Baches' },
    { id: 2, nombre: 'Plaza' },
  ],
};

describe('aplicarCambio', () => {
  test('renombrar no toca la lista de entrada y limpia los espacios', () => {
    const nueva = aplicarCambio(BASE, { accion: 'renombrar', id: 1, nombre: '  Calles   rotas ' });
    assert.equal(nueva.lista[0].nombre, 'Calles rotas');
    assert.equal(BASE.lista[0].nombre, 'Baches');
  });

  test('renombrar con el nombre de otro del modelo (sin acentos ni mayúsculas) los une', () => {
    const nueva = aplicarCambio({ version: 2, lista: [{ id: 1, nombre: 'Baches' }, { id: 2, nombre: 'Plaza Italia' }] }, { accion: 'renombrar', id: 1, nombre: 'PLAZA ITALÍA' });
    assert.equal(nueva.lista[0].unidoA, 2);
    assert.equal(nueva.lista[0].nombre, 'Baches', 'conserva su nombre: los comentarios cuentan en el otro');
    assert.throws(() => aplicarCambio(nueva, { accion: 'renombrar', id: 1, nombre: 'x' }), /no existe/, 'uno unido ya no está a la vista');
  });

  test('agregar a mano: id nuevo, sin repetir nombre, con tope', () => {
    let t = aplicarCambio(BASE, { accion: 'agregar', nombre: 'Seguridad', texto: ' Más patrullaje. ' });
    assert.deepEqual(t.lista[2], { id: 3, nombre: 'Seguridad', manual: true, texto: 'Más patrullaje.' });
    assert.throws(() => aplicarCambio(t, { accion: 'agregar', nombre: 'seguridad' }), /Ya hay un tema/);
    for (let i = 1; i < MAX_MANUALES; i++) t = aplicarCambio(t, { accion: 'agregar', nombre: `Tema ${i}` });
    assert.throws(() => aplicarCambio(t, { accion: 'agregar', nombre: 'Uno más' }), /hasta 8/);
  });

  test('un manual con el nombre de otro: no se une, se avisa', () => {
    const t = aplicarCambio(BASE, { accion: 'agregar', nombre: 'Seguridad' });
    assert.throws(() => aplicarCambio(t, { accion: 'renombrar', id: 3, nombre: 'Plaza' }), /agregado a mano/);
    assert.throws(() => aplicarCambio(t, { accion: 'renombrar', id: 1, nombre: 'Seguridad' }), /agregado a mano/);
  });

  test('un tema del modelo no lleva texto; uno a mano sí, y renombrarlo lo conserva', () => {
    assert.throws(() => aplicarCambio(BASE, { accion: 'renombrar', id: 1, nombre: 'Baches', texto: 'algo' }), /no llevan texto/);
    assert.equal(aplicarCambio(BASE, { accion: 'renombrar', id: 1, nombre: 'Pozos', texto: '  ' }).lista[0].nombre, 'Pozos');
    const t = aplicarCambio(BASE, { accion: 'agregar', nombre: 'Seguridad', texto: 'Patrullaje.' });
    assert.equal(aplicarCambio(t, { accion: 'renombrar', id: 3, nombre: 'Inseguridad' }).lista[2].texto, 'Patrullaje.');
    assert.equal(aplicarCambio(t, { accion: 'renombrar', id: 3, nombre: 'Seguridad', texto: 'Otro.' }).lista[2].texto, 'Otro.');
  });

  test('quitar: solo los manuales', () => {
    const t = aplicarCambio(BASE, { accion: 'agregar', nombre: 'Seguridad' });
    assert.deepEqual(aplicarCambio(t, { accion: 'quitar', id: 3 }).lista, BASE.lista);
    assert.throws(() => aplicarCambio(t, { accion: 'quitar', id: 1 }), /no se puede quitar/);
  });

  test('datos mal puestos: 400 con el mensaje', () => {
    for (const cambio of [{ accion: 'renombrar', id: 1, nombre: ' ' }, { accion: 'renombrar', id: 1, nombre: 'x'.repeat(61) }, { accion: 'agregar', nombre: 'x', texto: 'y'.repeat(1001) }, { accion: 'otra' }, null]) {
      assert.throws(
        () => aplicarCambio(BASE, cambio),
        (e) => e.status === 400 && Boolean(e.userMessage)
      );
    }
  });
});

describe('traducirListaVieja (la solapa de la fase E manda la lista entera)', () => {
  const actual = [
    { id: 1, titulo: 'Baches', texto: '' },
    { id: 2, titulo: 'Plaza', texto: '' },
  ];
  test('uno más al final: agregar', () => {
    assert.deepEqual(traducirListaVieja(actual, [...actual, { titulo: 'Nuevo', texto: 'x' }]), { accion: 'agregar', nombre: 'Nuevo', texto: 'x' });
  });
  test('uno menos: quitar ese', () => {
    assert.deepEqual(traducirListaVieja(actual, [{ titulo: 'Plaza' }]), { accion: 'quitar', id: 1 });
  });
  test('un título distinto: renombrar ese', () => {
    assert.deepEqual(traducirListaVieja(actual, [{ titulo: 'Baches' }, { titulo: 'Plazas' }]), { accion: 'renombrar', id: 2, nombre: 'Plazas', texto: undefined });
  });
  test('igual: nada; dos de más o no es una lista: 400', () => {
    assert.equal(traducirListaVieja(actual, actual), null);
    assert.throws(() => traducirListaVieja(actual, [...actual, {}, {}]), /un tema por vez/);
    assert.throws(() => traducirListaVieja(actual, 'x'), /lista/);
  });
});
