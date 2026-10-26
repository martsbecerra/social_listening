'use strict';

// Las piezas sin red de la fase H (src/geo/, openspec/changes/geo-pro):
// la normalización de textos, la conversión de coordenadas y la
// configuración. La conversión se compara contra convertir_coordenadas de
// USIG (ws.usig.buenosaires.gob.ar) en tres puntos, con los valores que
// devolvió el servicio el 25/10/2026; más un cruce que USIG dio en los dos
// sistemas y un hospital del dataset en EPSG:9498 contra su dirección.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geo-piezas-'));
process.env.MONITORING_GEO_DIR = tmp; // ANTES de cargar src/geo/config.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { limpiarTexto, normalizarLugar, prepararParaUsig, conCaba } = require('../src/geo/texto');
const { gkBaALonLat, lonLatAGkBa, caba2019ALonLat, esPlana } = require('../src/geo/proyecciones');
const geoConfig = require('../src/geo/config');

// Distancia aproximada en metros entre dos puntos cercanos de la Ciudad.
const metros = (a, b) => Math.hypot((a.lon - b.lon) * 91600, (a.lat - b.lat) * 111000);

describe('textos', () => {
  test('limpiar: minúsculas, sin acentos ni signos; la ñ queda; lo que no es texto da ""', () => {
    assert.equal(limpiarTexto('  Plaza CONSTITUCIÓN!! '), 'plaza constitucion');
    assert.equal(limpiarTexto('Cañitas, Güemes'), 'cañitas guemes');
    assert.equal(limpiarTexto(null), '');
    assert.equal(limpiarTexto(12), '');
  });

  test('normalizar un lugar: las abreviaturas, palabra por palabra', () => {
    assert.equal(normalizarLugar('Pza. Italia'), 'plaza italia');
    assert.equal(normalizarLugar('Villa Gral. Mitre'), 'villa general mitre');
    assert.equal(normalizarLugar('Av. Avellaneda'), 'avenida avellaneda', '"av" sí, "avellaneda" no');
    assert.equal(normalizarLugar('Bo. Fraga'), 'barrio fraga');
  });

  test('para USIG: ", CABA" una sola vez y las abreviaturas expandidas', () => {
    assert.equal(conCaba('ESTADOS UNIDOS 75, CABA'), 'ESTADOS UNIDOS 75, CABA');
    assert.equal(conCaba('Gral. Paz y Lope de Vega, Capital Federal'), 'general Paz y Lope de Vega, CABA');
    assert.equal(prepararParaUsig('Av. Corrientes 1200'), 'avenida Corrientes 1200');
    assert.equal(conCaba(''), '');
  });
});

describe('coordenadas', () => {
  // [x, y] Gauss-Krüger → [lon, lat] según convertir_coordenadas de USIG.
  const USIG = [
    [[97861.56465606578, 95093.40434445627], [-58.486632, -34.673496]],
    [[108000, 106000], [-58.376117, -34.575153]],
    [[92000, 94000], [-58.550596, -34.683323]],
  ];

  for (const [[x, y], [lon, lat]] of USIG) {
    test(`Gauss-Krüger (${x.toFixed(0)}, ${y.toFixed(0)}) da lo mismo que USIG, a menos de 1 m`, () => {
      const p = gkBaALonLat(x, y);
      assert.ok(metros(p, { lon, lat }) < 1, `${p.lon}, ${p.lat}`);
    });
  }

  test('un cruce que USIG dio en los dos sistemas (Nazca y Rivadavia)', () => {
    const p = gkBaALonLat(99418.6758194921, 99840.6762806083);
    assert.ok(metros(p, { lon: -58.469639, lat: -34.630705 }) < 1);
  });

  test('ida y vuelta', () => {
    const p = gkBaALonLat(104745.826622, 98932.9231535);
    const q = lonLatAGkBa(p.lon, p.lat);
    assert.ok(Math.hypot(q.x - 104745.826622, q.y - 98932.9231535) < 0.01);
  });

  test('EPSG:9498: el Garrahan del dataset cae a menos de 80 m de su dirección según USIG', () => {
    const delDataset = caba2019ALonLat(26549.56742604346, 69922.54409977954);
    const deLaDireccion = gkBaALonLat(106581.497548, 99823.951154); // Combate de los Pozos 1881
    assert.ok(metros(delDataset, deLaDireccion) < 80, `${metros(delDataset, deLaDireccion)} m`);
  });

  test('plana o en grados', () => {
    assert.equal(esPlana(97861, 95093), true);
    assert.equal(esPlana(-58.4, -34.6), false);
  });
});

describe('la configuración', { concurrency: false }, () => {
  test('la versionada trae todas las listas y sus patrones compilan', () => {
    const c = geoConfig.recargar();
    for (const k of ['gazetteer', 'villas', 'indicadores_de_lugar', 'indicadores_a_quitar', 'entidades_lineales', 'lugares_fuera_de_caba',
      'barrios_y_comunas_excluidos', 'barrios_informales', 'lugares_extra', 'altura_minima_direccion', 'patrones_direccion_invalida']) {
      assert.ok(k in c, k);
    }
    for (const p of c.patrones_direccion_invalida) assert.doesNotThrow(() => new RegExp(p, 'i'), p);
    for (const l of c.lugares_extra) {
      assert.ok(l.nombre && Array.isArray(l.variantes) && l.variantes.length, l.nombre);
      assert.ok(Boolean(l.club) !== Boolean(l.direccion), `${l.nombre}: club o direccion, uno solo`);
    }
    assert.ok(c.lugares_extra.length >= 40, 'estadios y unos 30 hitos');
  });

  test('data/geo/geo-config.json pisa las claves que trae', () => {
    fs.writeFileSync(path.join(tmp, 'geo-config.json'), JSON.stringify({ altura_minima_direccion: 5, barrios_informales: { once: 'Balvanera' } }));
    const c = geoConfig.recargar();
    assert.equal(c.altura_minima_direccion, 5);
    assert.deepEqual(c.barrios_informales, { once: 'Balvanera' });
    assert.ok(c.villas.grupos.length > 10, 'lo que no trae queda');
  });

  test('uno roto no frena nada: vale la versionada', () => {
    fs.writeFileSync(path.join(tmp, 'geo-config.json'), '{ roto');
    const avisos = [];
    const original = console.warn;
    console.warn = (m) => avisos.push(String(m));
    try {
      assert.equal(geoConfig.recargar().altura_minima_direccion, 10);
    } finally {
      console.warn = original;
      fs.rmSync(path.join(tmp, 'geo-config.json'));
      geoConfig.recargar();
    }
    assert.ok(avisos.some((m) => m.includes('no se pudo leer')));
  });
});
