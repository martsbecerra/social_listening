'use strict';

// El (0,0) de USIG y el reintento de los reclamos sin coordenadas
// (src/geocode.js, src/geoWorker.js, src/db.js). Una respuesta de USIG con
// las coordenadas vacías se leía como 0 y el reclamo quedaba "ok" en el
// (0,0). Ahora es "no encontrada", y al arrancar la app (una sola vez) todos
// los reclamos con dirección y sin punto vuelven a USIG sin la caché de "no
// encontrada". Base temporal, USIG simulado con global.fetch y la comuna y
// el barrio simulados (territorios.js baja los polígonos de la red). Desde
// la fase H el worker resuelve con src/geo/resolver.js: las villas y el
// índice de lugares van vacíos (cachés armadas a mano en una carpeta
// temporal), así acá solo se prueba USIG; y la caché usa "usig2:".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geocode-cero-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH; // ANTES de cargar db.js
process.env.MONITORING_GEO_DIR = tmp;
for (const f of ['barrios.geojson', 'comunas.geojson']) fs.copyFileSync(path.join(__dirname, 'fixtures', 'geo', f), path.join(tmp, f));
for (const nombre of ['villas', 'gazetteer']) {
  fs.writeFileSync(path.join(tmp, `${nombre}.json`), JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), filas: [] }));
}
fs.writeFileSync(path.join(tmp, 'geo-config.json'), JSON.stringify({ lugares_extra: [] }));

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const territorios = require('../src/territorios');
territorios.ubicarPunto = async (x, y) => (x < -58 && y < -34 ? { comuna: 1, barrio: 'San Nicolás' } : null); // ANTES de cargar geoWorker
const { geocodeAddress } = require('../src/geocode');
const geoWorker = require('../src/geoWorker');

// USIG simulado: por dirección, la respuesta y cuántas veces se la pidió.
let respuestas;
let pedidos;
global.fetch = async (url) => {
  const consulta = new URL(String(url)).searchParams.get('direccion');
  if (consulta === null) return new Response('no', { status: 404 });
  const direccion = consulta.replace(/, CABA$/, '');
  pedidos.push(direccion);
  const body = respuestas[direccion] || { direccionesNormalizadas: [] };
  return new Response(JSON.stringify(body), { status: 200 });
};
const usig = (x, y, direccion = 'CALLE 123') => ({
  direccionesNormalizadas: [{ cod_partido: 'caba', tipo: 'calle_altura', direccion, nombre_calle: 'CALLE', altura: 123, coordenadas: { x, y, srid: 4326 } }],
});

beforeEach(() => {
  respuestas = {};
  pedidos = [];
});

describe('el (0,0) de USIG', { concurrency: false }, () => {
  test('coordenadas vacías: no encontrada, nunca "ok" en el (0,0), y no queda en la caché como ok', async () => {
    respuestas['Corrientes 1000'] = usig('', '');
    const geo = await geocodeAddress('Corrientes 1000');
    assert.equal(geo.geoStatus, 'no_encontrada');
    assert.equal(geo.x, null);
    assert.equal(geo.y, null);
    const cache = db.getGeocodeCache('usig2:corrientes 1000');
    assert.notEqual(cache.status, 'ok');
  });

  test('coordenadas en 0: lo mismo', async () => {
    respuestas['Rivadavia 2000'] = usig('0', '0');
    assert.equal((await geocodeAddress('Rivadavia 2000')).geoStatus, 'no_encontrada');
  });

  test('un punto de verdad sigue siendo ok', async () => {
    respuestas['Florida 100'] = usig('-58.3746', '-34.6070');
    const geo = await geocodeAddress('Florida 100');
    assert.deepEqual([geo.geoStatus, geo.x, geo.y], ['ok', -58.3746, -34.607]);
  });

  test('una entrada vieja "ok" en el (0,0) de la caché no sirve: se pregunta de nuevo', async () => {
    db.setGeocodeCache({ queryKey: 'usig2:santa fe 3000', lat: 0, lng: 0, displayName: 'SANTA FE 3000', status: 'ok' });
    respuestas['Santa Fe 3000'] = usig('-58.41', '-34.588', 'SANTA FE 3000');
    const geo = await geocodeAddress('Santa Fe 3000');
    assert.deepEqual(pedidos, ['Santa Fe 3000']);
    assert.equal(geo.geoStatus, 'ok');
    assert.equal(geo.x, -58.41);
  });

  test('sinCacheFallida: una "no encontrada" de la caché se vuelve a consultar; sin la opción, no', async () => {
    db.setGeocodeCache({ queryKey: 'usig2:cabildo 500', status: 'not_found' });
    respuestas['Cabildo 500'] = usig('-58.43', '-34.57');
    assert.equal((await geocodeAddress('Cabildo 500')).geoStatus, 'no_encontrada');
    assert.deepEqual(pedidos, [], 'sin la opción, vale la caché');
    assert.equal((await geocodeAddress('Cabildo 500', { sinCacheFallida: true })).geoStatus, 'ok');
    assert.deepEqual(pedidos, ['Cabildo 500']);
  });
});

describe('el reintento al arrancar', { concurrency: false }, () => {
  test('vuelve a ubicar todos los que tienen dirección y no tienen punto; una sola vez', async () => {
    const raw = new DatabaseSync(DB_PATH);
    const insertar = raw.prepare(`
      INSERT INTO reclamos (id, plataforma, detected_at, texto_original, categoria, direccion_detectada, x, y, geo_status)
      VALUES (?, 'instagram', '2026-10-20T10:00:00.000Z', 'texto', 'Higiene', ?, ?, ?, ?)
    `);
    insertar.run('r-cero', 'Peru 300', 0, 0, 'ok'); // el (0,0)
    insertar.run('r-sin', 'Defensa 900', null, null, 'sin_direccion');
    insertar.run('r-noenc', 'Bolivar 1', null, null, 'no_encontrada');
    insertar.run('r-vacio', '', null, null, 'sin_direccion'); // sin dirección: no se puede
    insertar.run('r-bien', 'Tacuari 10', -58.38, -34.61, 'ok'); // ya ubicado: no se toca
    // Una "no encontrada" de las claves viejas (las del 25/10/2026, cuando USIG falló) no frena nada.
    db.setGeocodeCache({ queryKey: 'usig:bolivar 1', status: 'not_found' });
    raw.close();

    respuestas['Peru 300'] = usig('-58.374', '-34.611');
    respuestas['Defensa 900'] = usig('-58.372', '-34.622');
    respuestas['Bolivar 1'] = usig('', ''); // sigue sin punto

    const r = await geoWorker.reintentarSinCoordenadas();
    assert.deepEqual(r, { total: 3, ubicados: 2 });
    assert.deepEqual(pedidos.sort(), ['Bolivar 1', 'Defensa 900', 'Peru 300'], 'el de Bolivar, aunque la caché decía no encontrada');
    const fila = (id) => new DatabaseSync(DB_PATH, { readOnly: true }).prepare('SELECT x, y, geo_status, barrio FROM reclamos WHERE id = ?').get(id);
    assert.deepEqual({ ...fila('r-cero') }, { x: -58.374, y: -34.611, geo_status: 'ok', barrio: 'San Nicolás' });
    assert.equal(fila('r-noenc').geo_status, 'no_encontrada');
    assert.equal(fila('r-noenc').x, null);
    assert.equal(fila('r-vacio').geo_status, 'sin_direccion', 'sin dirección escrita no entra');
    assert.equal(fila('r-bien').x, -58.38);
    assert.ok(db.getRefreshState(geoWorker.MARCA_REINTENTO), 'deja la marca');

    pedidos = [];
    assert.equal(await geoWorker.reintentarSinCoordenadas(), null, 'la segunda vez no hace nada');
    assert.deepEqual(pedidos, []);
  });
});
