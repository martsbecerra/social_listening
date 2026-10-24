'use strict';

// La tabla `analisis` (src/db.js, openspec/changes/analisis-v4): abrir,
// cerrar bien o mal, leer entero y liviano, el último de un link, los temas
// editados, los "en curso" que quedan de un arranque anterior y el gasto de
// Apify atado por analisis_id. Y los reclamos de un análisis que se repite:
// conservan su estado y, si la dirección no cambió, su geocodificado.
// Base temporal: nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-base-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

const URL_A = 'https://www.instagram.com/p/AAA/';

function terminar(id, extra = {}) {
  db.finishAnalisis(id, 'instagram', {
    traidos: 120,
    unicos: 118,
    enviados: 118,
    analizados: 110,
    tonos: { positivos: 40, neutrales: 30, negativos: 35, ruido: 5 },
    positivoPct: 55,
    negativoPct: 45,
    nivel: 'Medio',
    resultado: { lecturaEstrategica: 'Una lectura.' },
    temas: [{ titulo: 'Tránsito', texto: 'Quejas.', comentarios: [1, 2, 3] }],
    comentarios: [{ n: 1, usuario: 'u1', texto: 'hola', tono: 'positivo' }],
    cuando: null,
    reporteAntes: 'antes',
    reporteDespues: 'después',
    csv: 'a,b\n',
    reclamos: 0,
    usdApify: 0.28,
    usdModelo: 0.04,
    tokens: 9000,
    ...extra,
  });
}

describe('tabla analisis', { concurrency: false }, () => {
  test('sin plataforma tira (no hay default)', () => {
    assert.throws(() => db.startAnalisis({ url: URL_A }), /falta plataforma/);
    assert.throws(() => db.getAnalisis(1), /falta plataforma/);
    assert.throws(() => db.listAnalisis({}), /falta plataforma/);
  });

  test('abre en curso, guarda la publicación y cierra bien con todo', () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: URL_A, postCode: 'AAA', analizadoPor: 'a@b.ar' });
    assert.equal(db.getAnalisis(id, 'instagram').estado, 'en curso');
    db.saveAnalisisPost(id, 'instagram', {
      id: '3700000000000000001',
      ownerUsername: 'cuenta',
      ownerFullName: 'La Cuenta',
      caption: 'Texto',
      postedAt: '2026-10-20T12:00:00.000Z',
      postType: 'reel',
      likesCount: null, // ocultos: quedan null, no 0
      commentsCount: 1480,
      videoPlayCount: 5000,
    });
    terminar(id);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'ok');
    assert.equal(a.cuenta, 'cuenta');
    assert.equal(a.likes, null);
    assert.equal(a.comentariosTotal, 1480);
    assert.equal(a.analizados, 110);
    assert.deepEqual(a.tonos, { positivos: 40, neutrales: 30, negativos: 35, ruido: 5 });
    assert.deepEqual(a.temas, [{ titulo: 'Tránsito', texto: 'Quejas.', comentarios: [1, 2, 3] }]);
    assert.equal(a.resultado.lecturaEstrategica, 'Una lectura.');
    assert.equal(a.cuando, null);
    assert.equal(db.getAnalisis(id, 'x'), null, 'desde otra plataforma no existe');
  });

  test('los recientes son los terminados bien, el último primero, y el último de un link', async () => {
    const otro = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/BBB/' });
    db.failAnalisis(otro, 'instagram', { estado: 'error', error: 'falló Apify' });
    await new Promise((r) => setTimeout(r, 5));
    const nuevo = db.startAnalisis({ plataforma: 'instagram', url: URL_A });
    terminar(nuevo, { analizados: 200 });
    const lista = db.listAnalisis({ plataforma: 'instagram', limit: 10 });
    assert.equal(lista[0].id, nuevo);
    assert.ok(lista.every((a) => a.estado === 'ok'));
    assert.ok(!lista.some((a) => a.id === otro), 'el que falló no está en los recientes');
    assert.equal(lista[0].comentarios, undefined, 'liviano: sin comentarios');
    assert.equal(db.findAnalisisByUrl({ plataforma: 'instagram', url: URL_A }).id, nuevo);
    assert.equal(db.findAnalisisByUrl({ plataforma: 'instagram', url: 'https://www.instagram.com/p/BBB/' }), null);
    assert.equal(db.getAnalisis(otro, 'instagram').error, 'falló Apify');
  });

  test('los temas editados se guardan solo en uno terminado', () => {
    const id = db.listAnalisis({ plataforma: 'instagram', limit: 1 })[0].id;
    assert.equal(db.updateAnalisisTemas(id, 'instagram', [{ titulo: 'Nuevo', texto: 'Uno.' }]), true);
    assert.deepEqual(db.getAnalisis(id, 'instagram').temas, [{ titulo: 'Nuevo', texto: 'Uno.' }]);
    const enCurso = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/CCC/' });
    assert.equal(db.updateAnalisisTemas(enCurso, 'instagram', []), false);
  });

  test('los en curso de un arranque anterior pasan a interrumpido, con lo que ya gastaron en Apify', () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/DDD/' });
    db.insertApifyCall({ phase: 'analisis', plataforma: 'instagram', items: 300, ok: true, usd: 0.69, analisisId: id });
    assert.ok(db.markInterruptedAnalisis() >= 1);
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.estado, 'interrumpido');
    assert.ok(a.finishedAt);
    assert.ok(Math.abs(a.usdApify - 0.69) < 1e-9);
  });

  test('el gasto de Apify de un análisis es la suma de sus filas', () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/EEE/' });
    for (const usd of [0.23, 0.0023]) {
      db.insertApifyCall({ phase: 'analisis', plataforma: 'instagram', items: 1, ok: true, usd, analisisId: id });
    }
    db.insertApifyCall({ phase: 'monitoreo', plataforma: 'instagram', items: 1, ok: true, usd: 5 });
    const gasto = db.sumApifyUsdForAnalisis(id);
    assert.equal(gasto.calls, 2);
    assert.ok(Math.abs(gasto.usd - 0.2323) < 1e-9);
  });

  test('sin cuenta en la corrida, la fila queda sin dato (no "N/D")', () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/NDND/' });
    db.saveAnalisisPost(id, 'instagram', { ownerUsername: 'N/D', ownerFullName: 'N/D', caption: '', likesCount: null, commentsCount: null });
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.cuenta, null);
    assert.equal(a.cuentaNombre, null);
  });

  test('la foto anotada', () => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: 'https://www.instagram.com/p/FFF/' });
    db.markAnalisisImage(id, 'instagram', { sourceUrl: 'https://scontent.cdninstagram.com/x.jpg', status: 'ok', savedAt: '2026-10-24T10:00:00.000Z', width: 640, height: 800 });
    const a = db.getAnalisis(id, 'instagram');
    assert.equal(a.image.savedAt, '2026-10-24T10:00:00.000Z');
    assert.equal(a.imageSavedAt, '2026-10-24T10:00:00.000Z');
    assert.equal(a.image.width, 640);
  });
});

describe('reclamos de un análisis que se repite', { concurrency: false }, () => {
  const base = {
    id: 'ig:900',
    comentarioId: 'ig:900',
    plataforma: 'instagram',
    postUrl: URL_A,
    autor: 'vecina',
    detectedAt: '2026-10-01T10:00:00.000Z',
    textoOriginal: 'Hay un bache en Salta 250',
    categoria: 'Infraestructura',
    direccionDetectada: 'Salta 250',
    geoStatus: 'pendiente',
    estado: 'Pendiente',
  };
  const fila = () => db.listReclamosFiltered({ plataforma: 'instagram' }).find((r) => r.id === 'ig:900');
  const gestionar = () => {
    db.updateEstado('ig:900', 'En tratamiento');
    db.updateReclamoGeo('ig:900', {
      geoStatus: 'ok',
      direccionNormalizada: 'SALTA 250',
      calle: 'SALTA',
      altura: 250,
      cruce: null,
      x: 100,
      y: 200,
      comuna: 1,
      barrio: 'Monserrat',
    });
  };

  test('con conservarGestion: el estado y el geocodificado quedan', () => {
    db.upsertReclamo(base);
    gestionar();
    db.upsertReclamo({ ...base, detectedAt: '2026-10-24T10:00:00.000Z', textoOriginal: 'Sigue el bache en Salta 250' }, { conservarGestion: true });
    const r = fila();
    assert.equal(r.estado, 'En tratamiento');
    assert.equal(r.geoStatus, 'ok');
    assert.equal(r.x, 100);
    assert.equal(r.textoOriginal, 'Sigue el bache en Salta 250');
    assert.equal(r.detectedAt, '2026-10-01T10:00:00.000Z', 'la primera detección');
  });

  test('con conservarGestion y otra dirección: se vuelve a geocodificar, el estado queda', () => {
    db.upsertReclamo({ ...base, direccionDetectada: 'Salta 300' }, { conservarGestion: true });
    const r = fila();
    assert.equal(r.estado, 'En tratamiento');
    assert.equal(r.geoStatus, 'pendiente');
    assert.equal(r.x, null);
  });

  test('sin la opción (el importador): pisa todo, como siempre', () => {
    gestionar();
    db.upsertReclamo(base);
    const r = fila();
    assert.equal(r.estado, 'Pendiente');
    assert.equal(r.geoStatus, 'pendiente');
  });
});

describe('fase F: galería, anteriores de la cuenta, reclamos de un posteo', { concurrency: false }, () => {
  // Cada uno con su cuenta, sus columnas y su hora: el orden de la galería
  // es el del fin del análisis.
  const nuevo = ({ code, cuenta, caption, finishedAt, pctNeg, tieneHecho = false, nVerificados = 0, temaEstrella = null, comentariosTotal = 100 }) => {
    const id = db.startAnalisis({ plataforma: 'instagram', url: `https://www.instagram.com/p/${code}/`, postCode: code, startedAt: finishedAt });
    db.saveAnalisisPost(id, 'instagram', { ownerUsername: cuenta, caption, commentsCount: comentariosTotal });
    terminar(id, { finishedAt, pctNeg, tieneHecho, nVerificados, temaEstrella });
    return id;
  };
  const ids = {};

  test('la galería: búsqueda sin acentos, filtros, orden, total y desde', () => {
    ids.g1 = nuevo({ code: 'GAL1', cuenta: 'jorgemacri', caption: 'Reabrimos el Parque Centenario', finishedAt: '2026-10-21T10:00:00.000Z', pctNeg: 53, tieneHecho: true, nVerificados: 6, temaEstrella: 'Vendedor de churros', comentariosTotal: 1284 });
    ids.g2 = nuevo({ code: 'GAL2', cuenta: 'jorgemacri', caption: 'Nueva estación Sáenz', finishedAt: '2026-10-22T10:00:00.000Z', pctNeg: 42, nVerificados: 1, temaEstrella: 'Operativo', comentariosTotal: 2140 });
    ids.g3 = nuevo({ code: 'GAL3', cuenta: 'gcba', caption: 'Veredas nuevas en Caballito', finishedAt: '2026-10-23T10:00:00.000Z', pctNeg: 12, temaEstrella: 'Veredas', comentariosTotal: 640 });
    const g = (args) =>
      db
        .listAnalisisGaleria({ plataforma: 'instagram', ...args })
        .items.filter((a) => /^GAL/.test(a.postCode))
        .map((a) => a.postCode);
    assert.deepEqual(g({}), ['GAL3', 'GAL2', 'GAL1'], 'el más reciente primero');
    assert.deepEqual(g({ q: 'SAENZ' }), ['GAL2'], 'sin acentos ni mayúsculas');
    assert.deepEqual(g({ q: 'churros' }), ['GAL1'], 'también por el tema estrella');
    assert.deepEqual(g({ q: 'gcba' }), ['GAL3'], 'y por la cuenta');
    assert.deepEqual(g({ f: 'ev' }), ['GAL1']);
    assert.deepEqual(g({ f: 'neg' }), ['GAL2', 'GAL1'], '40 % negativo o más');
    assert.deepEqual(g({ f: 'ver' }), ['GAL2', 'GAL1']);
    assert.deepEqual(g({ ord: 'c' }), ['GAL2', 'GAL1', 'GAL3']);
    assert.deepEqual(g({ ord: 'neg' }), ['GAL1', 'GAL2', 'GAL3']);
    assert.deepEqual(g({ ord: 'ver' }), ['GAL1', 'GAL2', 'GAL3']);
    const todo = db.listAnalisisGaleria({ plataforma: 'instagram', f: 'ev' });
    assert.ok(todo.total > todo.items.length, 'total es de todos, no del filtro');
    assert.ok(todo.desde && todo.desde <= '2026-10-21T10:00:00.000Z');
    assert.throws(() => db.listAnalisisGaleria({}), /plataforma/);
  });

  test('los reclamos del posteo: cuántos en la lista y cuáles tienen pin', () => {
    const url = 'https://www.instagram.com/p/GAL1/';
    const r = (id, extra = {}) => ({
      id,
      comentarioId: id,
      plataforma: 'instagram',
      postUrl: url,
      autor: 'vecina',
      detectedAt: '2026-10-21T10:00:00.000Z',
      textoOriginal: 'Luz en el lago',
      categoria: 'Infraestructura',
      direccionDetectada: 'Parque Centenario',
      geoStatus: 'pendiente',
      estado: 'Pendiente',
      ...extra,
    });
    db.upsertReclamo(r('ig:g1'));
    db.upsertReclamo(r('ig:g2'));
    db.updateReclamoGeo('ig:g2', { geoStatus: 'ok', direccionNormalizada: 'PARQUE CENTENARIO', x: -58.435, y: -34.606, comuna: 6, barrio: 'Caballito' });
    db.upsertReclamo(r('ig:g3', { postUrl: 'https://www.instagram.com/p/OTRO/' }));
    const lista = db.listReclamosDePost({ plataforma: 'instagram', postUrl: url });
    assert.deepEqual(
      lista.map((x) => [x.id, x.enMapa]),
      [
        ['ig:g1', false],
        ['ig:g2', true],
      ]
    );
    assert.equal(lista[1].barrio, 'Caballito');
    const enGaleria = db.listAnalisisGaleria({ plataforma: 'instagram' }).items.find((a) => a.postCode === 'GAL1');
    assert.equal(enGaleria.nReclamos, 2);
  });

  test('los anteriores de la cuenta: sin el actual, sin otros de la misma publicación, solo los de antes', () => {
    const repetido = nuevo({ code: 'GAL1', cuenta: 'jorgemacri', caption: 'Reabrimos el Parque Centenario', finishedAt: '2026-10-24T10:00:00.000Z', pctNeg: 50 });
    const actual = db.getAnalisis(repetido, 'instagram');
    const previos = db.listAnterioresDeCuenta({ plataforma: 'instagram', cuenta: 'jorgemacri', id: repetido, antesDe: actual.startedAt, postCode: actual.postCode });
    assert.deepEqual(
      previos.map((p) => p.id),
      [ids.g2],
      'el otro de GAL1 no entra'
    );
    assert.equal(previos[0].pctNeg, 42);
    assert.ok(Array.isArray(previos[0].comentarios));
    assert.deepEqual(db.listAnterioresDeCuenta({ plataforma: 'instagram', cuenta: 'jorgemacri', id: ids.g1, antesDe: '2026-10-21T10:00:00.000Z', postCode: 'GAL1' }), []);
    assert.deepEqual(db.listAnterioresDeCuenta({ plataforma: 'instagram', cuenta: null, id: 1, antesDe: 'z' }), []);
  });

  test('de una publicación anterior analizada varias veces, la comparación toma solo su último análisis', () => {
    const otraVez = nuevo({ code: 'GAL2', cuenta: 'jorgemacri', caption: 'Nueva estación Sáenz', finishedAt: '2026-10-22T18:00:00.000Z', pctNeg: 70 });
    const actualId = nuevo({ code: 'GAL9', cuenta: 'jorgemacri', caption: 'Otra', finishedAt: '2026-10-25T10:00:00.000Z', pctNeg: 10 });
    const actual = db.getAnalisis(actualId, 'instagram');
    const previos = db.listAnterioresDeCuenta({ plataforma: 'instagram', cuenta: 'jorgemacri', id: actualId, antesDe: actual.startedAt, postCode: 'GAL9' });
    const idsPrevios = previos.map((p) => p.id);
    assert.equal(previos.length, 2, 'GAL1 y GAL2, una vez cada una');
    assert.ok(idsPrevios.includes(otraVez) && !idsPrevios.includes(ids.g2), 'de GAL2, el último');
    assert.ok(!idsPrevios.includes(ids.g1), 'de GAL1, el último (el repetido del test anterior)');
  });

  test('la galería sin búsqueda ni filtro va directo con LIMIT (lo mismo que el camino largo); claves raras no rompen', () => {
    const rapido = db.listAnalisisGaleria({ plataforma: 'instagram', limit: 2 });
    const largo = db.listAnalisisGaleria({ plataforma: 'instagram', f: 'all', ord: 'c', limit: 200 });
    const porFin = [...largo.items].sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || b.id - a.id);
    assert.deepEqual(
      rapido.items.map((a) => a.id),
      porFin.slice(0, 2).map((a) => a.id)
    );
    assert.equal(rapido.total, largo.total);
    assert.equal(rapido.desde, largo.desde);
    const raro = db.listAnalisisGaleria({ plataforma: 'instagram', f: 'constructor', ord: 'toString', limit: 2 });
    assert.deepEqual(
      raro.items.map((a) => a.id),
      rapido.items.map((a) => a.id)
    );
  });

  test('renombrar el tema estrella actualiza su columna', () => {
    const temas = { version: 2, lista: [{ id: 1, nombre: 'Veredas y baldosas' }] };
    assert.equal(db.updateAnalisisTemas(ids.g3, 'instagram', temas, { temaEstrella: 'Veredas y baldosas' }), true);
    const a = db.listAnalisisGaleria({ plataforma: 'instagram' }).items.find((x) => x.id === ids.g3);
    assert.equal(a.temaEstrella, 'Veredas y baldosas');
    assert.deepEqual(db.getAnalisis(ids.g3, 'instagram').temas, temas);
  });
});
