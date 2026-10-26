'use strict';

// Los datasets de la fase H (src/geo/datasets.js, villas.js, gazetteer.js;
// openspec/changes/geo-pro): con recortes de los datos abiertos reales del
// GCBA (test/fixtures/geo/, armados el 25/10/2026) servidos por un fetch
// simulado. La caché de 30 días, las villas (Gauss-Krüger, grupos,
// variantes, tramos) y el índice de lugares (fuentes, filtros, búsqueda,
// lugares extra). Nada sale a la red ni toca data/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures', 'geo');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geo-datasets-'));
process.env.MONITORING_GEO_DIR = tmp; // ANTES de cargar src/geo
for (const f of ['barrios.geojson', 'comunas.geojson']) fs.copyFileSync(path.join(FIXTURES, f), path.join(tmp, f));

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// La URL de cada fuente de config/geo-config.json → su recorte.
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
let pedidos = [];
let redCaida = false;
global.fetch = async (url) => {
  const archivo = RECORTES[path.basename(new URL(String(url)).pathname)];
  pedidos.push(path.basename(String(url)));
  if (redCaida) throw new Error('sin red');
  if (!archivo) return new Response('no', { status: 404 });
  return new Response(fs.readFileSync(path.join(FIXTURES, archivo)), { status: 200 });
};

const datasets = require('../src/geo/datasets');
const villas = require('../src/geo/villas');
const gazetteer = require('../src/geo/gazetteer');
const territorios = require('../src/territorios');

const DIA = 24 * 60 * 60 * 1000;

describe('la caché de los datasets', { concurrency: false }, () => {
  beforeEach(() => {
    pedidos = [];
    redCaida = false;
  });

  test('arma, guarda y no vuelve a bajar antes de 30 días', async () => {
    const ahora = new Date('2026-10-25T12:00:00.000Z');
    const armar = async () => [{ a: 1 }];
    const primera = await datasets.conCache('prueba', 1, armar, { dias: 30, ahora });
    assert.deepEqual(primera.filas, [{ a: 1 }]);
    assert.ok(fs.existsSync(path.join(tmp, 'prueba.json')));
    let llamadas = 0;
    await datasets.conCache('prueba', 1, async () => (llamadas++, [{ a: 2 }]), { dias: 30, ahora: new Date(ahora.getTime() + 29 * DIA) });
    assert.equal(llamadas, 0);
    const vieja = await datasets.conCache('prueba', 1, async () => (llamadas++, [{ a: 2 }]), { dias: 30, ahora: new Date(ahora.getTime() + 31 * DIA) });
    assert.equal(llamadas, 1);
    assert.deepEqual(vieja.filas, [{ a: 2 }]);
  });

  test('si rearmar falla, sigue lo guardado; sin nada guardado, un error pasajero', async () => {
    const avisos = [];
    const original = console.warn;
    console.warn = (m) => avisos.push(String(m));
    try {
      const r = await datasets.conCache('prueba', 1, async () => { throw new Error('sin red'); }, { dias: 30, ahora: new Date('2027-01-01T00:00:00.000Z') });
      assert.deepEqual(r.filas, [{ a: 2 }]);
      assert.ok(avisos.some((m) => m.includes('no se pudo actualizar')));
      await assert.rejects(
        datasets.conCache('otra', 1, async () => { throw new Error('sin red'); }, { dias: 30 }),
        (err) => err.transient === true
      );
    } finally {
      console.warn = original;
    }
  });

  test('otra versión del formato se vuelve a armar', async () => {
    let llamadas = 0;
    await datasets.conCache('prueba', 2, async () => (llamadas++, []), { dias: 30, ahora: new Date('2027-01-02T00:00:00.000Z') });
    assert.equal(llamadas, 1);
  });

  test('una descarga que no es 200 es pasajera', async () => {
    await assert.rejects(datasets.bajar('https://cdn.buenosaires.gob.ar/no/existe.geojson'), (err) => err.transient === true && /HTTP 404/.test(err.message));
  });
});

describe('villas', { concurrency: false }, () => {
  test('el dataset en Gauss-Krüger: disuelto por nombre, en lat/lng, con barrio y comuna; sin los tipos que no van', async () => {
    const { entradas } = await villas.obtenerVillas();
    const v1114 = entradas.find((e) => e.nombre.startsWith('Villa 1-11-14'));
    assert.ok(v1114, 'la del grupo');
    assert.ok(v1114.x > -58.46 && v1114.x < -58.42 && v1114.y > -34.66 && v1114.y < -34.63, `${v1114.x}, ${v1114.y}`);
    assert.equal(v1114.barrio, 'Flores');
    assert.equal(v1114.comuna, 7);
    const v31 = entradas.filter((e) => e.nombre.includes('31'));
    assert.equal(v31.length, 1, 'Villa 31, 31 bis y La Containera son un solo grupo');
    assert.equal(v31[0].barrio, 'Retiro');
    assert.ok(!entradas.some((e) => e.nombre === 'Barrio Rivadavia II'), 'Barrios municipales no es un tipo incluido');
  });

  test('las variantes, tolerantes; y los tramos para que no lleguen a USIG', async () => {
    const V = await villas.obtenerVillas();
    for (const texto of ['en la 1-11-14 no pasa la basura', 'la 1.11.14', 'once catorce', 'BARRIO PADRE RICCIARDELLI']) {
      assert.match(villas.buscarVilla(texto, V).villa.nombre, /1-11-14/, texto);
    }
    assert.match(villas.buscarVilla('la 31 bis', V).villa.nombre, /31/);
    const { villa, tramos } = villas.buscarVilla('Corrientes 1500 y la 1-11-14', V);
    assert.ok(villa);
    assert.equal(villas.enmascarar('Corrientes 1500 y la 1-11-14', tramos), 'Corrientes 1500 y');
    assert.equal(villas.buscarVilla('Fragata Sarmiento 1200', V).villa, null);
  });
});

describe('el índice de lugares', { concurrency: false }, () => {
  let indice;
  let barrios;
  test('las fuentes: hospitales y escuelas en EPSG:9498 a lat/lng; trenes, solo los de la Ciudad; las estaciones con dedicatoria, por su nombre', async () => {
    indice = await gazetteer.obtenerIndice();
    barrios = await territorios.nombresDeBarrios();
    const garrahan = indice.entradas.find((e) => e.nombre === 'Hospital Dr. J. Garrahan');
    assert.ok(garrahan.x > -58.40 && garrahan.x < -58.38 && garrahan.y > -34.64 && garrahan.y < -34.62);
    assert.equal(garrahan.direccion, 'Combate De Los Pozos 1881');
    assert.ok(!indice.entradas.some((e) => e.nombre === 'Estación La Plata'), 'La Plata no es de la Ciudad');
    assert.ok(indice.entradas.some((e) => e.nombre === 'Estación Once' && e.tipo === 'estacion_subte'));
    assert.ok(indice.entradas.some((e) => e.nombre === 'Plazoleta Julio Cortázar'), 'el nombre con su clasificación');
  });

  test('los filtros: una palabra, nombres excluidos, entidades lineales; una escuela solo con indicador', () => {
    assert.ok(!indice.entradas.some((e) => e.clave === 'la grieta' || e.clave === 'la ventana'), 'excluidos en la configuración, aun con indicador');
    assert.equal(indice.resumen.descartados.excluido, 2);
    const { resumen } = gazetteer.filtrar([{ nombre: 'Belgrano', tipo: 'club' }, { nombre: 'Av. 9 de Julio', tipo: 'espacio_verde' }, { nombre: 'Plaza', tipo: 'espacio_verde' }]);
    assert.deepEqual(resumen.descartados, { una_sola_palabra: 2, entidad_lineal: 1 });
    assert.equal(indice.entradas.find((e) => e.tipo === 'escuela').requiereIndicador, true);
  });

  const nombre = (r) => (r.lugar ? r.lugar.nombre : `(${r.motivo})`);
  const casos = [
    ['plaza constitución', 'Plaza de la Constitución'],
    ['Plaza Miserere', 'Plaza Miserere'],
    ['Hospital Durand', 'Hospital Dr. C. Durand'],
    ['estación Once', 'Estación Once'],
    ['el Parque Centenario', 'Parque Centenario'],
    ['cancha de Huracán', 'Estadio Tomás A. Ducó (Huracán)'],
    ['la bombonera', 'La Bombonera (Boca Juniors)'],
    ['Plaza de Mayo', 'Plaza de Mayo'],
    ['el bar La Ventana', '(no_encontrado)'],
    ['Palermo', '(barrio_sin_indicador)'],
    ['plaza Palermo Viejo', '(no_encontrado)'],
  ];
  for (const [busco, espero] of casos) {
    test(`"${busco}" → ${espero}`, () => {
      assert.equal(nombre(gazetteer.buscar(busco, indice, { barrios })), espero);
    });
  }

  test('una frase común solo vale con su indicador (adelante en el nombre o en el texto)', () => {
    const { entradas } = gazetteer.filtrar([{ nombre: 'La Casona Azul', tipo: 'espacio_cultural', x: -58.4, y: -34.6, direccion: null }]);
    const chico = { ...gazetteer.indexar(entradas), entradas, extras: new Map() };
    assert.equal(nombre(gazetteer.buscar('La Casona Azul', chico, { barrios })), '(ambiguo_sin_indicador)');
    assert.equal(nombre(gazetteer.buscar('La Casona Azul', chico, { barrios, textoCompleto: 'en el bar La Casona Azul no hay luz' })), 'La Casona Azul');
    assert.equal(nombre(gazetteer.buscar('el bar La Casona Azul', chico, { barrios })), 'La Casona Azul');
  });

  test('una escuela con su indicador sí', () => {
    const r = gazetteer.buscar('colegio Nº 02 Domingo Faustino Sarmiento DE 01', indice, { barrios });
    assert.equal(r.lugar && r.lugar.tipo, 'escuela');
  });

  test('un lugar extra que cae fuera de su barrio no se usa, y se avisa', async () => {
    assert.ok(indice.extrasSinUbicar.includes('Estadio de All Boys') === false, 'All Boys está en Monte Castro y así lo dice la lista');
    const avisos = [];
    const original = console.warn;
    console.warn = (m) => avisos.push(String(m));
    try {
      const { extras, sinUbicar } = await gazetteer.armarExtras(indice.entradas, {
        config: { lugares_extra: [{ nombre: 'Mal puesto', club: 'Atlético Huracán Estadio Tomás Adolfo Ducó', barrio: 'Palermo', variantes: ['mal puesto'] }] },
      });
      assert.equal(extras.size, 0);
      assert.deepEqual(sinUbicar, ['Mal puesto']);
    } finally {
      console.warn = original;
    }
    assert.ok(avisos.some((m) => m.includes('cae en Parque Patricios, no en Palermo')));
  });

  test('las versiones del nombre: entero y sin los indicadores del principio', () => {
    assert.deepEqual(gazetteer.versiones('cruce peatonal de Ruiz de los Llanos').map((v) => v.texto), ['cruce peatonal de ruiz de los llanos', 'ruiz de los llanos']);
    assert.deepEqual(gazetteer.versiones('locales de Once').map((v) => v.texto), ['locales de once', 'once']);
  });
});
