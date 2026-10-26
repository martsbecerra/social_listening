'use strict';

// La base de la fase H (src/db.js, openspec/changes/geo-pro): sobre una
// tabla `reclamos` como la dejó la fase G (precisión exacta | aproximada,
// sin las columnas nuevas), al cargar db.js aparecen ubicacion_tipo,
// nombre_lugar, motivo_sin_ubicar, ubicacion_json, corregida_por y
// descarte_motivo, la precisión pasa a puntual | cruce | lugar | ninguna y
// la tabla lugar_cache. Después: conservarGestion con un reclamo corregido
// o descartado, el filtro de precisión, los de fuera de la Ciudad y la
// caché de lugares. Base temporal armada a mano antes del require.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geo-base-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH; // ANTES de cargar db.js

const vieja = new DatabaseSync(DB_PATH);
vieja.exec(`
  CREATE TABLE reclamos (
    id TEXT PRIMARY KEY, comentario_id TEXT UNIQUE,
    plataforma TEXT NOT NULL CHECK(plataforma IN ('instagram','x','tiktok','facebook')),
    post_url TEXT, comment_url TEXT, autor TEXT, fecha TEXT, detected_at TEXT NOT NULL, texto_original TEXT NOT NULL,
    categoria TEXT NOT NULL, subcategoria TEXT, precision_fecha TEXT, import_origen TEXT, direccion_detectada TEXT,
    direccion_normalizada TEXT, calle TEXT, altura INTEGER, cruce TEXT, x REAL, y REAL, comuna INTEGER, barrio TEXT,
    precision TEXT,
    geo_status TEXT CHECK(geo_status IN ('pendiente','ok','sin_direccion','no_encontrada','invalida','fuera_caba')),
    estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK(estado IN ('Pendiente','En tratamiento','Resuelto','Desestimado'))
  )
`);
const meter = vieja.prepare(`
  INSERT INTO reclamos (id, comentario_id, plataforma, detected_at, texto_original, categoria, direccion_detectada,
    direccion_normalizada, cruce, x, y, precision, geo_status)
  VALUES (?, ?, ?, '2026-10-01T10:00:00.000Z', 'texto', 'Higiene urbana', ?, ?, ?, ?, ?, ?, ?)
`);
meter.run('a', 'a', 'x', 'Salta 250', 'SALTA 250', null, -58.38, -34.61, 'exacta', 'ok');
meter.run('b', 'b', 'x', 'Nazca y Rivadavia', 'NAZCA AV. y RIVADAVIA AV.', 'RIVADAVIA AV.', -58.47, -34.62, 'exacta', 'ok');
meter.run('c', 'c', 'instagram', 'Plaza Italia', 'Plaza Italia', null, -58.42, -34.58, 'aproximada', 'ok');
meter.run('d', 'd', 'instagram', 'cancha de Huracan', null, null, null, null, null, 'no_encontrada');
meter.run('e', 'e', 'x', 'Corrientes 9000, Tigre', 'CORRIENTES 9000', null, -58.58, -34.42, 'exacta', 'fuera_caba');
meter.run('f', 'f', 'x', 'Salta 300', null, null, null, null, 'exacta', 'pendiente');
meter.run('g', 'g', 'x', 'pista vieja', null, null, null, null, null, 'sin_direccion');
vieja.close();

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');

describe('la migración de la fase H', () => {
  test('aparecen las columnas nuevas y lugar_cache', () => {
    const lector = new DatabaseSync(DB_PATH, { readOnly: true });
    const cols = lector.prepare('PRAGMA table_info(reclamos)').all().map((c) => c.name);
    for (const c of ['ubicacion_tipo', 'nombre_lugar', 'motivo_sin_ubicar', 'ubicacion_json', 'corregida_por', 'descarte_motivo']) {
      assert.ok(cols.includes(c), c);
    }
    assert.ok(lector.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lugar_cache'").get());
    lector.close();
  });

  test('la precisión vieja pasa a la nueva, con su tipo o su motivo', () => {
    const r = Object.fromEntries('abcdefg'.split('').map((id) => [id, db.getReclamo(id)]));
    assert.deepEqual([r.a.precision, r.a.ubicacionTipo], ['puntual', 'calle_altura']);
    assert.deepEqual([r.b.precision, r.b.ubicacionTipo], ['cruce', 'cruce']);
    assert.deepEqual([r.c.precision, r.c.ubicacionTipo], ['lugar', 'lugar']);
    assert.deepEqual([r.d.precision, r.d.motivoSinUbicar], ['ninguna', 'no_encontrada']);
    assert.equal(r.e.precision, 'puntual', 'el punto de afuera sigue siendo un punto');
    assert.equal(r.e.geoStatus, 'fuera_caba');
    assert.equal(r.f.precision, 'ninguna', 'un pendiente sin punto: lo resuelve el worker');
    assert.equal(r.f.motivoSinUbicar, null);
    assert.deepEqual([r.g.precision, r.g.motivoSinUbicar], ['ninguna', 'sin_direccion']);
    assert.equal(r.a.corregidaPor, null);
  });
});

describe('reclamos de la fase H', { concurrency: false }, () => {
  const base = {
    id: 'ig:1',
    comentarioId: 'ig:1',
    plataforma: 'instagram',
    postUrl: 'https://www.instagram.com/p/X/',
    detectedAt: '2026-10-25T10:00:00.000Z',
    textoOriginal: 'La cancha de Huracán es un desastre',
    categoria: 'Higiene urbana',
    direccionDetectada: 'cancha de Huracán',
    ubicacionTipo: 'lugar',
    ubicacion: { tipo: 'lugar', nombre_lugar: 'cancha de Huracán', confianza: 'alta' },
  };
  const ubicar = () =>
    db.updateReclamoGeo('ig:1', {
      geoStatus: 'ok',
      direccionNormalizada: 'ALCORTA, AMANCIO AV. 2570',
      x: -58.4115,
      y: -34.6438,
      comuna: 4,
      barrio: 'Parque Patricios',
      precision: 'lugar',
      nombreLugar: 'Atlético Huracán Estadio Tomás Adolfo Ducó',
    });

  test('guarda la ubicación del modelo y lo que resolvió el servidor', () => {
    db.upsertReclamo(base);
    ubicar();
    const r = db.getReclamo('ig:1');
    assert.equal(r.ubicacionTipo, 'lugar', 'sin ubicacionTipo, updateReclamoGeo no lo pisa');
    assert.deepEqual(r.ubicacion, base.ubicacion);
    assert.equal(r.nombreLugar, 'Atlético Huracán Estadio Tomás Adolfo Ducó');
    assert.equal(r.precision, 'lugar');
  });

  test('corregido a mano: un análisis nuevo con otra dirección no lo pisa', () => {
    db.marcarReclamoCorregido('ig:1', { corregidaPor: 'equipo@buenosaires.gob.ar', texto: 'Amancio Alcorta 2570', ahora: '2026-10-25T12:00:00.000Z' });
    db.upsertReclamo({ ...base, direccionDetectada: 'Huracán' }, { conservarGestion: true });
    const r = db.getReclamo('ig:1');
    assert.equal(r.x, -58.4115);
    assert.equal(r.corregidaPor, 'equipo@buenosaires.gob.ar');
    assert.deepEqual(r.ubicacion.correccion, { texto: 'Amancio Alcorta 2570', fecha: '2026-10-25T12:00:00.000Z' });
    assert.equal(r.ubicacion.nombre_lugar, 'cancha de Huracán', 'lo que dijo el modelo sigue');
  });

  test('descartado: queda sin punto, con el motivo, y tampoco lo pisa un análisis nuevo', () => {
    db.descartarReclamo('ig:1', { motivo: 'Es una opinión sobre el club', corregidaPor: 'equipo@buenosaires.gob.ar' });
    db.upsertReclamo({ ...base, direccionDetectada: 'otra' }, { conservarGestion: true });
    const r = db.getReclamo('ig:1');
    assert.equal(r.motivoSinUbicar, 'descartado');
    assert.equal(r.descarteMotivo, 'Es una opinión sobre el club');
    assert.equal(r.x, null);
    assert.equal(r.precision, 'ninguna');
  });

  test('sin conservarGestion (el importador) pisa todo, también la corrección', () => {
    db.upsertReclamo(base);
    const r = db.getReclamo('ig:1');
    assert.equal(r.corregidaPor, null);
    assert.equal(r.descarteMotivo, null);
    assert.equal(r.motivoSinUbicar, null);
  });

  test('el filtro de precisión y los de fuera de la Ciudad', () => {
    const ids = (lista) => lista.map((r) => r.id).sort();
    assert.deepEqual(ids(db.listReclamosFiltered({ plataforma: 'x', precision: ['cruce'] })), ['b']);
    assert.ok(!ids(db.listReclamosFiltered({ plataforma: 'x' })).includes('e'), 'por defecto, afuera');
    assert.ok(ids(db.listReclamosFiltered({ plataforma: 'x' }, { incluirFueraDeCaba: true })).includes('e'));
  });

  test('la caché de lugares', () => {
    assert.equal(db.getLugarCache('plaza constitucion'), null);
    db.setLugarCache({ clave: 'plaza constitucion', nombre: 'Plaza Constitución', x: -58.381, y: -34.627, direccion: 'LIMA y BRASIL AV.', fuente: 'espacio_verde', fetchedAt: '2026-10-25T10:00:00.000Z' });
    assert.deepEqual(db.getLugarCache('plaza constitucion'), {
      clave: 'plaza constitucion',
      nombre: 'Plaza Constitución',
      x: -58.381,
      y: -34.627,
      direccion: 'LIMA y BRASIL AV.',
      fuente: 'espacio_verde',
      fetchedAt: '2026-10-25T10:00:00.000Z',
    });
  });
});
