'use strict';

// El reproceso de los reclamos sin punto (fase H: src/geo/extraccion.js,
// src/geo/reproceso.js, scripts/geo-reprocesar.js; openspec/changes/geo-pro):
// la extracción por tandas con el modelo simulado (la validación, una tanda
// caída, el tope), el costo sin llamar a nada, quiénes entran, el JSON y su
// aplicación una sola vez (los que tienen punto, los corregidos, los
// descartados y los que cambiaron de texto no se tocan), el resumen y los
// resguardos del script. Base temporal; ningún modelo de verdad.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geo-reproceso-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH; // ANTES de cargar db.js
process.env.MONITORING_GEO_DIR = tmp;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const extraccion = require('../src/geo/extraccion');
const reproceso = require('../src/geo/reproceso');
const script = require('../scripts/geo-reprocesar');

const ubic = (tipo, extra = {}) => ({ tipo, calle: '', altura: 0, calle2: '', nombre_lugar: '', barrio_o_comuna: '', texto_original: '', confianza: 'alta', fuera_de_caba: false, ...extra });

// Un modelo que contesta cada texto con "lugar" y el texto como nombre;
// `fallar` hace caer la tanda que contiene ese texto.
function modeloFalso({ fallar = null, costo = 0.01 } = {}) {
  const llamadas = [];
  return {
    llamadas,
    requestStructuredAnalysis: async ({ userPrompt, schemaName }) => {
      llamadas.push({ schemaName, userPrompt });
      if (fallar && userPrompt.includes(fallar)) {
        const err = new Error('caída');
        err.tokenUsage = { totalTokens: 50, costUsd: 0.002 };
        throw err;
      }
      const filas = [...userPrompt.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ i: Number(m[1]), ubicacion: ubic('lugar', { nombre_lugar: m[2], texto_original: m[2], calle: 'no va' }) }));
      return { parsed: { ubicaciones: filas }, usage: { totalTokens: 500, costUsd: costo } };
    },
  };
}

const items = (n) => Array.from({ length: n }, (_, k) => ({ id: `r${k + 1}`, texto: `texto ${k + 1}` }));

describe('la extracción', () => {
  test('por tandas de 15, cada respuesta a su reclamo y validada', async () => {
    const m = modeloFalso();
    const r = await extraccion.extraerUbicaciones(items(32), { modelo: m });
    assert.equal(m.llamadas.length, 3);
    assert.ok(m.llamadas.every((l) => l.schemaName === 'ubicacion_reclamos'));
    assert.equal(r.ubicaciones.size, 32);
    assert.deepEqual([r.ubicaciones.get('r17').nombre_lugar, r.ubicaciones.get('r17').calle], ['texto 17', ''], 'lo que el tipo no usa queda vacío');
    assert.equal(Math.round(r.usd * 100) / 100, 0.03);
  });

  test('una tanda que cae deja esos reclamos sin ubicación, y lo gastado cuenta', async () => {
    const r = await extraccion.extraerUbicaciones(items(20), { modelo: modeloFalso({ fallar: 'texto 16' }) });
    assert.equal(r.fallidas, 1);
    assert.equal(r.ubicaciones.size, 15);
    assert.ok(!r.ubicaciones.has('r16'));
    assert.ok(Math.abs(r.usd - 0.012) < 1e-9);
  });

  test('con lo gastado en el tope no sale ninguna llamada más', async () => {
    const m = modeloFalso({ costo: 0.2 });
    const r = await extraccion.extraerUbicaciones(items(60), { modelo: m, tope: 0.3 });
    assert.equal(m.llamadas.length, 2);
    assert.equal(r.cortadoPorTope, true);
  });

  test('el mensaje: la pista y el texto de la publicación, si los hay', () => {
    const p = extraccion.buildPrompt([{ texto: 'Está oscuro acá', pista: 'la plaza', caption: 'Inauguramos la Plaza X' }]);
    assert.match(p, /^1\. Está oscuro acá\n   lo que se había leído: la plaza\n   texto de la publicación: Inauguramos la Plaza X$/);
  });

  test('el costo, sin llamar a nada: llamadas, tokens de entrada y un rango', () => {
    const c = extraccion.estimarCosto(items(31));
    assert.equal(c.llamadas, 3);
    assert.ok(c.tokensEntrada > 0 && c.usd.minimo < c.usd.maximo);
    assert.ok(Math.abs(c.usd.minimo - (c.tokensEntrada * 2 + c.tokensSalida.minimo * 10) / 1e6) < 1e-12);
  });
});

describe('el reproceso en la base', { concurrency: false }, () => {
  const meter = (id, extra = {}) =>
    db.upsertReclamo({ id, comentarioId: id, plataforma: 'x', textoOriginal: `texto de ${id}`, categoria: 'Higiene urbana', detectedAt: '2026-10-25T10:00:00.000Z', ...extra });
  test('entran los sin punto; no los ubicados, los corregidos ni los descartados; la pista del Excel no va', () => {
    meter('sin-1', { direccionDetectada: 'cancha de Huracán', geoStatus: 'no_encontrada' });
    meter('sin-2', { direccionDetectada: 'CARRERAS, SANTIAGO DE LAS 18, CABA', importOrigen: 'reclamos_historicos.xlsx', geoStatus: 'no_encontrada' });
    meter('ok-1', { direccionDetectada: 'Salta 250' });
    db.updateReclamoGeo('ok-1', { geoStatus: 'ok', x: -58.38, y: -34.61, precision: 'puntual', direccionNormalizada: 'SALTA 250' });
    meter('corr-1', { geoStatus: 'no_encontrada' });
    db.marcarReclamoCorregido('corr-1', { corregidaPor: 'equipo@buenosaires.gob.ar', texto: 'x' });
    meter('desc-1', { geoStatus: 'no_encontrada' });
    db.descartarReclamo('desc-1', { motivo: 'no', corregidaPor: 'equipo@buenosaires.gob.ar' });
    const c = reproceso.candidatos();
    assert.deepEqual(c.map((x) => x.id).sort(), ['sin-1', 'sin-2']);
    assert.equal(c.find((x) => x.id === 'sin-1').pista, 'cancha de Huracán');
    assert.equal(c.find((x) => x.id === 'sin-2').pista, null);
  });

  test('el JSON y su aplicación, una sola vez', async () => {
    const archivo = path.join(tmp, 'reproceso-ubicaciones.json');
    const c = reproceso.candidatos();
    const ext = { ubicaciones: new Map([['sin-1', ubic('lugar', { nombre_lugar: 'cancha de Huracán' })], ['sin-2', ubic('ninguna')]]), usd: 0.05, tokens: 900, llamadas: 1, fallidas: 0 };
    const datos = reproceso.escribirArchivo(archivo, { items: c, extraccion: ext, modelo: 'prueba' });
    assert.equal(Object.keys(datos.ubicaciones).length, 2);
    // sin-2 cambió de texto después de la extracción: no se toca.
    meter('sin-2', { textoOriginal: 'otro texto', geoStatus: 'no_encontrada' });
    let procesados = 0;
    const procesar = async () => {
      for (const r of db.listPendingGeoReclamos()) {
        procesados += 1;
        db.updateReclamoGeo(r.id, { geoStatus: 'ok', x: -58.4115, y: -34.6438, precision: 'lugar', direccionNormalizada: 'ALCORTA, AMANCIO AV. 2570', nombreLugar: 'Estadio' });
      }
      return {};
    };
    const r = await reproceso.aplicarSiHay({ archivo, procesar });
    assert.deepEqual([r.aplicados, r.salteados, procesados], [1, 1, 1]);
    const sin1 = db.getReclamo('sin-1');
    assert.deepEqual([sin1.ubicacionTipo, sin1.ubicacion.nombre_lugar, sin1.precision], ['lugar', 'cancha de Huracán', 'lugar']);
    assert.equal(r.resumen.x.conPunto, 1);
    assert.ok(db.getRefreshState(reproceso.MARCA));
    assert.equal(await reproceso.aplicarSiHay({ archivo, procesar }), null, 'la segunda vez, nada');
  });

  test('el resumen: con punto, por precisión, menciones y sin ubicar por motivo', () => {
    meter('barrio-1');
    db.updateReclamoGeo('barrio-1', { geoStatus: 'sin_direccion', precision: 'ninguna', ubicacionTipo: 'barrio', comuna: 14, barrio: 'Palermo' });
    meter('lineal-1');
    db.updateReclamoGeo('lineal-1', { geoStatus: 'no_encontrada', precision: 'ninguna', motivoSinUbicar: 'lineal' });
    const x = reproceso.resumen().x;
    assert.equal(x.conPunto, 2);
    assert.deepEqual(x.porPrecision, { puntual: 1, lugar: 1 });
    assert.equal(x.menciones, 1);
    assert.equal(x.sinUbicar.lineal, 1);
    assert.equal(x.descartados, 1);
  });
});

describe('el script', { concurrency: false }, () => {
  const correr = async (...args) => {
    const lineas = [];
    const log = console.log;
    const err = console.error;
    console.log = (m) => lineas.push(String(m));
    console.error = (m) => lineas.push(String(m));
    try {
      return { code: await script.main(['node', 'geo-reprocesar.js', ...args]), salida: lineas.join('\n') };
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  test('--costo informa y no llama a nada', async () => {
    const r = await correr('--base', DB_PATH, '--costo');
    assert.equal(r.code, 0);
    assert.match(r.salida, /Reclamos sin punto: \d+/);
    assert.match(r.salida, /Costo: entre US\$ \d+,\d{3} y US\$ \d+,\d{3}/);
  });

  test('nunca con data/monitoring.db; --si no corre dos veces', async () => {
    assert.equal((await correr('--base', path.join(__dirname, '..', 'data', 'monitoring.db'), '--costo')).code, 1);
    const salida = path.join(tmp, 'ya-hecho.json');
    fs.writeFileSync(salida, '{}');
    const r = await correr('--base', DB_PATH, '--si', '--salida', salida);
    assert.equal(r.code, 1);
    assert.match(r.salida, /una sola vez/);
  });

  test('--simulado escribe el JSON sin modelo', async () => {
    const salida = path.join(tmp, 'simulado.json');
    const r = await correr('--base', DB_PATH, '--simulado', '--salida', salida);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(salida, 'utf8')).modelo, 'simulado');
  });
});
