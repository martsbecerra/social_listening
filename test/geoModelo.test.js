'use strict';

// La ubicación estructurada que extrae el modelo en la tanda de Instagram
// (fase H, openspec/changes/geo-pro): el schema, las reglas del prompt, el
// lugar de la publicación, la validación en el servidor, las filas de
// reclamos y el CSV de reclamos armado con lo que resolvió el servidor.
// Sin modelo ni red; base temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geo-modelo-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TANDA_JSON_SCHEMA } = require('../src/analysisSchema');
const { TANDA_SYSTEM_PROMPT } = require('../src/prompt');
const { sanitizeUbicacion, normalizeBatchClassifications } = require('../src/validateAnalysis');
const { buildReclamosFromAnalysis } = require('../src/reclamosFromAnalysis');
const { buildReclamosCsv, buildReclamosCsvDeBase } = require('../src/reportBuilder');
const { normalizePost } = require('../src/apify');
const { buildBatchPrompt } = require('../src/userPrompt');

const vacia = { tipo: 'ninguna', calle: '', altura: 0, calle2: '', nombre_lugar: '', barrio_o_comuna: '', texto_original: '', confianza: 'alta', fuera_de_caba: false };

describe('el schema y el prompt', () => {
  test('cada reclamo trae su ubicación, con todos los campos y sin null', () => {
    const item = TANDA_JSON_SCHEMA.properties.classifications.items.properties.reclamosGeo.items;
    assert.deepEqual(item.required, ['ubicacion', 'tematica', 'categoria']);
    const u = item.properties.ubicacion;
    assert.deepEqual(u.properties.tipo.enum, ['calle_altura', 'cruce', 'lugar', 'villa', 'barrio', 'lineal', 'ninguna']);
    assert.deepEqual(u.required.sort(), Object.keys(u.properties).sort());
    assert.ok(!JSON.stringify(TANDA_JSON_SCHEMA).includes('"null"'));
  });

  test('las reglas de SPEC.md: sin coordenadas, lineal, barrio, fuera de la Ciudad, números que no son alturas, "acá"', () => {
    for (const regla of [
      /NUNCA des coordenadas/,
      /Una avenida sola es lineal, no un punto/,
      /Un barrio o una comuna solos son barrio, no un punto/,
      /fuera_de_caba true/,
      /"hasta las 18"/,
      /"ruta nacional 1"/,
      /"la 2da sección"/,
      /Una altura menor a 10 solo si viene pegada a su calle/,
      /LUGAR DE LA PUBLICACIÓN/,
      /Sin ningún lugar nombrado no hay entrada/,
    ]) {
      assert.match(TANDA_SYSTEM_PROMPT, regla);
    }
  });

  test('el lugar de la publicación: lo trae el actor y va en los datos del posteo', () => {
    const post = normalizePost([{ id: '1', ownerUsername: 'gcba', caption: 'Inauguramos', locationName: 'Parque Centenario' }], [], 'https://www.instagram.com/p/X/');
    assert.equal(post.locationName, 'Parque Centenario');
    assert.equal(normalizePost([{ id: '1' }], [], 'u').locationName, null);
    const prompt = buildBatchPrompt({ url: 'https://www.instagram.com/p/X/', post, batch: [{ username: 'v', text: 'acá no hay luz' }], numero: 1, tandas: 1, temas: [] });
    assert.match(prompt, /LUGAR DE LA PUBLICACIÓN: Parque Centenario/);
  });
});

describe('la validación en el servidor', () => {
  test('un tipo que no existe, ninguna; una altura en texto, número; la confianza, baja si no vino', () => {
    assert.equal(sanitizeUbicacion({ ...vacia, tipo: 'esquina' }).tipo, 'ninguna');
    const u = sanitizeUbicacion({ tipo: 'calle_altura', calle: '  Salta ', altura: '250', texto_original: 'Salta 250' });
    assert.deepEqual([u.tipo, u.calle, u.altura, u.confianza], ['calle_altura', 'Salta', 250, 'baja']);
  });

  test('al que le falta lo suyo se le baja el tipo; los campos que no usa quedan vacíos', () => {
    assert.equal(sanitizeUbicacion({ ...vacia, tipo: 'calle_altura', calle: 'Serrano', altura: 0 }).tipo, 'lineal');
    assert.equal(sanitizeUbicacion({ ...vacia, tipo: 'cruce', calle: 'Rivadavia' }).tipo, 'lineal');
    assert.equal(sanitizeUbicacion({ ...vacia, tipo: 'lugar' }).tipo, 'ninguna');
    assert.equal(sanitizeUbicacion({ ...vacia, tipo: 'barrio' }).tipo, 'ninguna');
    const l = sanitizeUbicacion({ ...vacia, tipo: 'lugar', nombre_lugar: 'Plaza Italia', calle: 'Santa Fe', altura: 3000, calle2: 'x', barrio_o_comuna: 'Palermo' });
    assert.deepEqual([l.calle, l.altura, l.calle2, l.nombre_lugar, l.barrio_o_comuna], ['', 0, '', 'Plaza Italia', 'Palermo']);
  });

  test('un reclamo sin ningún lugar nombrado no es un reclamo; uno de fuera de la Ciudad, sí', () => {
    const [c] = normalizeBatchClassifications(
      [{ index: 1, sentiment: 'negativo', postura: 'critica', tema: 0, sobre_posteo: false, pedido: true, reclamosGeo: [
        { ubicacion: vacia, tematica: 'basura', categoria: 'Higiene urbana' },
        { ubicacion: { ...vacia, fuera_de_caba: true }, tematica: 'basura', categoria: 'Higiene urbana' },
        { ubicacion: { ...vacia, tipo: 'lugar', nombre_lugar: 'la cancha de Huracán', texto_original: 'la cancha de Huracán' }, tematica: 'basura', categoria: 'Higiene urbana' },
      ] }],
      1
    );
    assert.equal(c.reclamosGeo.length, 2);
    assert.equal(c.reclamosGeo[0].ubicacion.fuera_de_caba, true);
    assert.equal(c.reclamosGeo[1].direccionDetectada, 'la cancha de Huracán');
  });

  test('la forma de antes de la fase H va como texto libre', () => {
    const [c] = normalizeBatchClassifications([{ index: 1, reclamosGeo: [{ direccionDetectada: 'Salta 250', direccionNormalizada: 'SALTA 250', tematica: 'bache', categoria: 'Infraestructura', tipoUbicacion: 'calle_altura' }] }], 1);
    assert.deepEqual(c.reclamosGeo[0].ubicacion, { tipo: 'texto', texto: 'Salta 250', tipoUbicacion: 'calle_altura' });
  });
});

describe('las filas y el CSV', () => {
  const ubicacion = { ...vacia, tipo: 'cruce', calle: 'Ruiz de los Llanos', calle2: 'Bacacay', texto_original: 'cruce peatonal de Ruiz de los Llanos y Bacacay' };
  const sample = [{ apifyId: '77', username: 'vecina', text: 'El cruce peatonal de Ruiz de los Llanos y Bacacay es un peligro', timestamp: '2026-10-20T10:00:00.000Z' }];
  const classifications = [{ reclamosGeo: [{ ubicacion, direccionDetectada: ubicacion.texto_original, tematica: 'cruce peligroso', categoria: 'Tránsito' }] }];

  test('el reclamo queda pendiente con la ubicación del modelo; la precisión la pone el resolver', () => {
    const [r] = buildReclamosFromAnalysis({ url: 'https://www.instagram.com/p/X/', sample, classifications });
    assert.deepEqual([r.id, r.ubicacionTipo, r.precision, r.geoStatus, r.direccionDetectada], ['ig:77', 'cruce', null, 'pendiente', ubicacion.texto_original]);
    assert.deepEqual(r.ubicacion, ubicacion);
  });

  test('el CSV que se guarda: las cuatro columnas de la metodología', () => {
    const csv = buildReclamosCsv(sample, classifications);
    assert.match(csv, /"vecina","cruce peatonal de Ruiz de los Llanos y Bacacay","Ruiz de los Llanos y Bacacay","cruce peligroso"/);
  });

  test('el CSV que se descarga: lo que resolvió el servidor, la temática del guardado y las columnas nuevas', () => {
    const guardado = buildReclamosCsv(sample, classifications);
    const csv = buildReclamosCsvDeBase(
      [
        { autor: 'vecina', direccionDetectada: ubicacion.texto_original, direccionNormalizada: 'RUIZ DE LOS LLANOS y BACACAY', categoria: 'Tránsito', subcategoria: 'Cruces', ubicacionTipo: 'cruce', precision: 'cruce', nombreLugar: null, barrio: 'Velez Sarsfield', comuna: 10, motivoSinUbicar: null },
        { autor: '=otra', direccionDetectada: 'la General Paz', direccionNormalizada: null, categoria: 'Tránsito', subcategoria: '', ubicacionTipo: 'lineal', precision: 'ninguna', nombreLugar: null, barrio: null, comuna: null, motivoSinUbicar: 'lineal' },
      ],
      guardado
    );
    const [encabezado, uno, dos] = csv.trim().split('\n');
    assert.match(encabezado, /^"Nombre de usuario","Direccion detectada","Direccion normalizada","Tematica detectada","Categoria",.*"Motivo sin ubicar"$/);
    assert.equal(uno, '"vecina","cruce peatonal de Ruiz de los Llanos y Bacacay","RUIZ DE LOS LLANOS y BACACAY","cruce peligroso","Tránsito","Cruces","Cruce de calles","Cruce","","Velez Sarsfield","10",""');
    assert.match(dos, /^"'=otra","la General Paz","N\/D","N\/D",.*"Una calle o avenida sin altura ni cruce"$/);
  });
});
