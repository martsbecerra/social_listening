'use strict';

// Las rutas del Mapa de reclamos de la fase H (src/reclamosRoutes.js,
// openspec/changes/geo-pro): el listado con la precisión, el motivo y los
// de fuera de la Ciudad, el filtro de precisión, corregir (con el mismo
// resolver; lo que no se ubica no pisa nada) y descartar, y las comunas.
// El correo de quien corrigió no sale. Express con una sesión simulada,
// USIG simulado, los datasets de test/fixtures/geo y una base temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-reclamos-rutas-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.MONITORING_GEO_DIR = tmp;
const FIXTURES = path.join(__dirname, 'fixtures', 'geo');
for (const f of ['barrios.geojson', 'comunas.geojson']) fs.copyFileSync(path.join(FIXTURES, f), path.join(tmp, f));
fs.writeFileSync(path.join(tmp, 'geo-config.json'), JSON.stringify({ lugares_extra: [] }));

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const reclamosRoutes = require('../src/reclamosRoutes');

const RECORTES = {
  'barrios_populares_badata_WGS84.geojson': 'villas.geojson',
  'espacio_verde_publico.csv': 'verdes.csv',
  'estaciones_de_subte.geojson': 'subte.geojson',
  'estaciones-de-ferrocarril.geojson': 'trenes.geojson',
  'hospitales.geojson': 'hospitales.geojson',
  'clubes.geojson': 'clubes.geojson',
  'espacios-culturales.geojson': 'culturales.geojson',
  'establecimientos_educativos_WGS84.geojson': 'escuelas.geojson',
};
let usigCaido = false;
const fetchReal = global.fetch;
global.fetch = async (recurso, opts) => {
  const url = new URL(String(recurso));
  if (url.hostname === '127.0.0.1') return fetchReal(recurso, opts);
  if (url.host === 'cdn.buenosaires.gob.ar') return new Response(fs.readFileSync(path.join(FIXTURES, RECORTES[path.basename(url.pathname)])), { status: 200 });
  if (usigCaido) return new Response('caído', { status: 503 });
  if (url.pathname === '/geocoder/2.2/reversegeocoding/') return new Response('({"puerta":"RIVADAVIA AV. 2800"})', { status: 200 });
  // El normalizador y ws no conocen ninguna dirección.
  if (url.pathname === '/normalizar') return new Response(JSON.stringify({ direccionesNormalizadas: [] }), { status: 200 });
  return new Response(JSON.stringify({ Normalizacion: { TipoResultado: 'ErrorCalleInexistente' } }), { status: 200 });
};

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { email: 'equipo@buenosaires.gob.ar' };
    next();
  });
  reclamosRoutes.register(app);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const pedir = (ruta, cuerpo) =>
  fetch(`${base}${ruta}`, cuerpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : undefined);

const reclamo = (id, extra = {}) => ({
  id, comentarioId: id, plataforma: 'instagram', textoOriginal: 'Está sucio', categoria: 'Higiene urbana', detectedAt: '2026-10-25T10:00:00.000Z', ...extra,
});

beforeEach(() => {
  usigCaido = false;
});

describe('el listado', { concurrency: false }, () => {
  test('pide la plataforma', async () => {
    assert.equal((await pedir('/api/reclamos')).status, 400);
  });

  test('trae la precisión, el motivo y los de fuera de la Ciudad; ni el correo ni la respuesta del modelo', async () => {
    db.upsertReclamo(reclamo('ig:1', { direccionDetectada: 'Salta 250', ubicacion: { tipo: 'calle_altura' } }));
    db.updateReclamoGeo('ig:1', { geoStatus: 'ok', x: -58.38, y: -34.61, precision: 'puntual', direccionNormalizada: 'SALTA 250', comuna: 1, barrio: 'Monserrat' });
    db.upsertReclamo(reclamo('ig:2', { direccionDetectada: 'Tigre' }));
    db.updateReclamoGeo('ig:2', { geoStatus: 'fuera_caba', precision: 'ninguna', motivoSinUbicar: 'fuera_de_caba' });
    db.marcarReclamoCorregido('ig:1', { corregidaPor: 'alguien@buenosaires.gob.ar', texto: 'Salta 250' });
    const r = await (await pedir('/api/reclamos?plataforma=instagram')).json();
    const porId = Object.fromEntries(r.reclamos.map((x) => [x.id, x]));
    assert.equal(porId['ig:1'].precision, 'puntual');
    assert.equal(porId['ig:1'].corregida, true);
    assert.equal(porId['ig:2'].motivoSinUbicar, 'fuera_de_caba');
    assert.ok(!JSON.stringify(r).includes('buenosaires.gob.ar'), 'el correo no sale');
    assert.ok(!('ubicacion' in porId['ig:1']) && !('corregidaPor' in porId['ig:1']));
    assert.equal(r.etiquetas.PRECISION.lugar, 'Lugar con nombre · ubicación aproximada');
  });

  test('"se leyó": lo que extrajo el modelo, no la dirección de antes', async () => {
    const leido = async (id, extra) => {
      db.upsertReclamo(reclamo(id, { direccionDetectada: '24 DE NOVIEMBRE 11, CABA', ...extra }));
      db.updateReclamoGeo(id, { geoStatus: 'no_encontrada', precision: 'ninguna', motivoSinUbicar: 'no_encontrada' });
      const r = await (await pedir('/api/reclamos?plataforma=instagram')).json();
      return r.reclamos.find((x) => x.id === id).leido;
    };
    assert.equal(await leido('ig:l1', { ubicacionTipo: 'lugar', ubicacion: { tipo: 'lugar', nombre_lugar: 'escuela 24 de 11', texto_original: '' } }), 'escuela 24 de 11');
    assert.equal(await leido('ig:l2', { ubicacionTipo: 'ninguna', ubicacion: { tipo: 'ninguna', texto_original: '' } }), null, 'el modelo no leyó ningún lugar');
    assert.equal(await leido('ig:l3', {}), '24 DE NOVIEMBRE 11, CABA', 'sin la ubicación del modelo, la de antes');
  });

  test('el filtro de precisión', async () => {
    const r = await (await pedir('/api/reclamos?plataforma=instagram&precision=puntual')).json();
    assert.deepEqual(r.reclamos.map((x) => x.id), ['ig:1']);
  });
});

describe('corregir y descartar', { concurrency: false }, () => {
  test('corregir: lo escrito se resuelve con el mismo resolver y queda marcado', async () => {
    db.upsertReclamo(reclamo('ig:3', { direccionDetectada: 'la plaza de Once' }));
    db.updateReclamoGeo('ig:3', { geoStatus: 'no_encontrada', precision: 'ninguna', motivoSinUbicar: 'no_encontrada' });
    const resp = await pedir('/api/reclamos/ig:3/corregir', { texto: 'Plaza Miserere' });
    assert.equal(resp.status, 200);
    const { reclamo: r } = await resp.json();
    assert.deepEqual([r.precision, r.nombreLugar, r.barrio, r.corregida, r.motivoSinUbicar], ['lugar', 'Plaza Miserere', 'Balvanera', true, null]);
    const enLaBase = db.getReclamo('ig:3');
    assert.equal(enLaBase.corregidaPor, 'equipo@buenosaires.gob.ar');
    assert.equal(enLaBase.ubicacion.correccion.texto, 'Plaza Miserere');
  });

  test('lo que no se ubica no pisa nada', async () => {
    const antes = db.getReclamo('ig:3');
    const resp = await pedir('/api/reclamos/ig:3/corregir', { texto: 'Calle Inventada 99999' });
    assert.equal(resp.status, 422);
    assert.match((await resp.json()).error, /No se pudo ubicar «Calle Inventada 99999»/);
    assert.deepEqual(db.getReclamo('ig:3'), antes);
  });

  test('con USIG caído, 503 y nada cambia', async () => {
    usigCaido = true;
    const resp = await pedir('/api/reclamos/ig:3/corregir', { texto: 'Juramento 3109' });
    assert.equal(resp.status, 503);
  });

  test('sin texto, 400; un reclamo que no existe, 404', async () => {
    assert.equal((await pedir('/api/reclamos/ig:3/corregir', { texto: '  ' })).status, 400);
    assert.equal((await pedir('/api/reclamos/nada/corregir', { texto: 'Salta 250' })).status, 404);
  });

  test('descartar: sin punto, con el motivo', async () => {
    assert.equal((await pedir('/api/reclamos/ig:3/descartar', {})).status, 400);
    const resp = await pedir('/api/reclamos/ig:3/descartar', { motivo: 'Es una opinión, no un reclamo' });
    const { reclamo: r } = await resp.json();
    assert.deepEqual([r.motivoSinUbicar, r.descarteMotivo, r.x, r.precision, r.corregida], ['descartado', 'Es una opinión, no un reclamo', null, 'ninguna', false]);
  });
});

describe('las comunas', () => {
  test('los 15 polígonos', async () => {
    const r = await (await pedir('/api/geo/comunas')).json();
    assert.equal(r.type, 'FeatureCollection');
    assert.equal(r.features.length, 15);
  });
});
