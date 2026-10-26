'use strict';

// El resolver de la fase H (src/geo/resolver.js, usig.js, geoWorker.js;
// openspec/changes/geo-pro): de la ubicación que extrae el modelo a un punto
// con su precisión, o a un motivo. USIG simulado con las formas reales de
// sus respuestas (ws.usig: normalizar_y_geocodificar_direcciones, geocoder
// 2.2; servicios.usig: normalizar sin geocodificar) y los datasets con los
// recortes de test/fixtures/geo. Base y carpeta de datos temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-geo-resolver-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.MONITORING_GEO_DIR = tmp;
const FIXTURES = path.join(__dirname, 'fixtures', 'geo');
for (const f of ['barrios.geojson', 'comunas.geojson']) fs.copyFileSync(path.join(FIXTURES, f), path.join(tmp, f));
// Dos lugares extra: uno por el dataset de clubes, uno por dirección (USIG).
fs.writeFileSync(
  path.join(tmp, 'geo-config.json'),
  JSON.stringify({
    lugares_extra: [
      { nombre: 'Estadio Tomás A. Ducó (Huracán)', club: 'Atlético Huracán Estadio Tomás Adolfo Ducó', barrio: 'Parque Patricios', variantes: ['cancha de huracan'] },
      { nombre: 'Obelisco', direccion: 'Corrientes Av. y Cerrito', barrio: 'San Nicolas', variantes: ['obelisco', 'el obelisco'] },
    ],
  })
);

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const { lonLatAGkBa } = require('../src/geo/proyecciones');
const resolver = require('../src/geo/resolver');
const geoWorker = require('../src/geoWorker');

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

const gk = (lon, lat) => {
  const p = lonLatAGkBa(lon, lat);
  return { x: p.x.toFixed(6), y: p.y.toFixed(6) };
};
// Lo que contesta cada servicio de USIG, por consulta.
let ws; // "calle|altura" → respuesta de normalizar_y_geocodificar_direcciones
let geocoder; // "cod|altura" o "cod1|cod2" → { x, y } Gauss-Krüger
let normalizador; // texto → direccionesNormalizadas
let pedidos;
let caido;
global.fetch = async (recurso) => {
  const url = new URL(String(recurso));
  const archivo = RECORTES[path.basename(url.pathname)];
  if (url.host === 'cdn.buenosaires.gob.ar') return new Response(fs.readFileSync(path.join(FIXTURES, archivo)), { status: 200 });
  const p = url.searchParams;
  pedidos.push(`${url.host.split('.')[0]}${url.pathname} ${[...p.values()].join(' ')}`);
  if (caido) return new Response('caído', { status: 503 });
  if (url.pathname === '/rest/normalizar_y_geocodificar_direcciones') {
    const r = ws[`${p.get('calle')}|${p.get('altura')}`];
    return new Response(JSON.stringify(r || { Normalizacion: { TipoResultado: 'ErrorCalleInexistente' } }), { status: 200 });
  }
  if (url.pathname === '/geocoder/2.2/geocoding/') {
    const k = p.get('cod_calle1') ? `${p.get('cod_calle1')}|${p.get('cod_calle2')}` : `${p.get('cod_calle')}|${p.get('altura')}`;
    return new Response(geocoder[k] ? `(${JSON.stringify(geocoder[k])})` : '"Parametros incorrectos."', { status: 200 });
  }
  if (url.pathname === '/geocoder/2.2/reversegeocoding/') {
    return new Response(`(${JSON.stringify({ puerta: 'LIMA 1500', esquina: 'LIMA y BRASIL AV.' })})`, { status: 200 });
  }
  if (url.pathname === '/normalizar') {
    return new Response(JSON.stringify({ direccionesNormalizadas: normalizador[p.get('direccion')] || [] }), { status: 200 });
  }
  return new Response('no', { status: 404 });
};

const unaDireccion = (calle, altura, punto) => ({
  Normalizacion: { TipoResultado: 'DireccionNormalizada', DireccionesCalleAltura: { direcciones: [{ CodigoCalle: '1', Calle: calle, Altura: String(altura) }] } },
  GeoCodificacion: gk(...punto),
});

// El Obelisco de los lugares extra, que se ubica al armar el índice.
const NORMALIZADOR_BASE = {
  'Corrientes avenida y Cerrito, CABA': [
    { cod_partido: 'caba', tipo: 'calle_y_calle', cod_calle: 1, cod_calle_cruce: 2, nombre_calle: 'CORRIENTES AV.', nombre_calle_cruce: 'CERRITO', direccion: 'CORRIENTES AV. y CERRITO, CABA', coordenadas: { srid: 4326, x: '-58.38157', y: '-34.60373' } },
  ],
};

beforeEach(() => {
  ws = {};
  geocoder = {};
  normalizador = { ...NORMALIZADOR_BASE };
  pedidos = [];
  caido = false;
});

describe('calle y altura', { concurrency: false }, () => {
  test('USIG la ubica: punto, precisión puntual, comuna y barrio', async () => {
    ws['Combate de los Pozos|1881'] = unaDireccion('COMBATE DE LOS POZOS', 1881, [-58.39153, -34.63084]);
    const r = await resolver.resolver({ tipo: 'calle_altura', calle: 'Combate de los Pozos', altura: 1881, texto_original: 'Combate de los Pozos 1881' });
    assert.equal(r.precision, 'puntual');
    assert.equal(r.ubicacionTipo, 'calle_altura');
    assert.ok(Math.abs(r.x + 58.39153) < 1e-5 && Math.abs(r.y + 34.63084) < 1e-5);
    assert.deepEqual([r.barrio, r.comuna, r.geoStatus, r.direccionNormalizada], ['Parque Patricios', 4, 'ok', 'COMBATE DE LOS POZOS 1881']);
  });

  test('la segunda vez sale de la caché, sin pedir nada', async () => {
    await resolver.resolver({ tipo: 'calle_altura', calle: 'Combate de los Pozos', altura: 1881 });
    assert.deepEqual(pedidos, []);
  });

  test('dos opciones: la del nombre buscado; más de dos: ambigua, sin elegir', async () => {
    ws['San Martin|450'] = {
      Normalizacion: { TipoResultado: 'Ambiguedad', DireccionesCalleAltura: { direcciones: [{ CodigoCalle: '5069', Calle: 'ESCALADA DE SAN MARTIN, R.', Altura: '450' }, { CodigoCalle: '20044', Calle: 'SAN MARTIN', Altura: '450' }] } },
    };
    geocoder['20044|450'] = gk(-58.37391, -34.60277);
    const r = await resolver.resolver({ tipo: 'calle_altura', calle: 'San Martin', altura: 450 });
    assert.equal(r.direccionNormalizada, 'SAN MARTIN 450');
    ws['Mitre|100'] = {
      Normalizacion: { TipoResultado: 'Ambiguedad', DireccionesCalleAltura: { direcciones: ['MITRE', 'MITRE, BARTOLOME', 'MITRE, EMILIO'].map((c, i) => ({ CodigoCalle: String(i), Calle: c, Altura: '100' })) } },
    };
    const a = await resolver.resolver({ tipo: 'calle_altura', calle: 'Mitre', altura: 100 });
    assert.deepEqual([a.motivoSinUbicar, a.x, a.geoStatus], ['ambigua', null, 'no_encontrada']);
  });

  test('un horario no es una altura: "hasta las 18" queda lineal, sin preguntarle a USIG', async () => {
    const r = await resolver.resolver(
      { tipo: 'calle_altura', calle: 'Serrano', altura: 18, texto_original: 'Serrano hasta las 18' },
      { texto: 'el camión pasa por Serrano hasta las 18' }
    );
    assert.deepEqual([r.motivoSinUbicar, r.ubicacionTipo], ['lineal', 'lineal']);
    assert.deepEqual(pedidos, []);
  });

  test('una altura menor a 10 solo vale pegada a su calle', async () => {
    ws['Caffarena|2'] = unaDireccion('CAFFARENA', 2, [-58.3561, -34.6286]);
    const bien = await resolver.resolver({ tipo: 'calle_altura', calle: 'Caffarena', altura: 2, texto_original: 'la Usina en Caffarena 2' });
    assert.equal(bien.precision, 'puntual');
    const mal = await resolver.resolver({ tipo: 'calle_altura', calle: 'Serrano', altura: 6, texto_original: 'en Serrano van a ser 6' });
    assert.equal(mal.motivoSinUbicar, 'lineal');
  });

  test('USIG no la conoce: no encontrada', async () => {
    const r = await resolver.resolver({ tipo: 'calle_altura', calle: 'Calle Inventada', altura: 1234 });
    assert.equal(r.motivoSinUbicar, 'no_encontrada');
  });

  test('un punto fuera de la Ciudad: fuera_de_caba, sin punto', async () => {
    ws['Cazon|1000'] = unaDireccion('CAZON', 1000, [-58.579, -34.426]); // Tigre
    const r = await resolver.resolver({ tipo: 'calle_altura', calle: 'Cazon', altura: 1000 });
    assert.deepEqual([r.motivoSinUbicar, r.geoStatus, r.x], ['fuera_de_caba', 'fuera_caba', null]);
  });

  test('USIG caído: un error pasajero, y nada queda en la caché', async () => {
    caido = true;
    await assert.rejects(resolver.resolver({ tipo: 'calle_altura', calle: 'Juramento', altura: 3109 }), (err) => err.transient === true);
    assert.equal(db.getGeocodeCache('usig2:ca:juramento|3109'), null);
  });
});

describe('cruce', { concurrency: false }, () => {
  test('los candidatos del normalizador (dos iguales cuentan como uno) y el punto de ws', async () => {
    normalizador['RUIZ DE LOS LLANOS y BACACAY, CABA'] = [
      { cod_partido: 'caba', tipo: 'calle_y_calle', cod_calle: 19092, cod_calle_cruce: 2002, nombre_calle: 'RUIZ DE LOS LLANOS', nombre_calle_cruce: 'BACACAY', direccion: 'RUIZ DE LOS LLANOS y BACACAY, CABA' },
      { cod_partido: 'caba', tipo: 'calle_y_calle', cod_calle: 19092, cod_calle_cruce: 2002, nombre_calle: 'RUIZ DE LOS LLANOS', nombre_calle_cruce: 'BACACAY AV.', direccion: 'RUIZ DE LOS LLANOS y BACACAY AV., CABA' },
    ];
    geocoder['19092|2002'] = gk(-58.50709, -34.63589);
    const r = await resolver.resolver({ tipo: 'cruce', calle: 'RUIZ DE LOS LLANOS', calle2: 'BACACAY', texto_original: 'cruce peatonal de Ruiz de los Llanos y Bacacay' });
    assert.deepEqual([r.precision, r.ubicacionTipo, r.cruce, r.comuna], ['cruce', 'cruce', 'BACACAY', 10]);
    assert.equal(r.direccionNormalizada, 'RUIZ DE LOS LLANOS y BACACAY');
  });

  test('sin la segunda calle es una calle sola: lineal', async () => {
    const r = await resolver.resolver({ tipo: 'cruce', calle: 'Rivadavia', calle2: '' });
    assert.equal(r.motivoSinUbicar, 'lineal');
  });
});

describe('lugares, barrios y villas', { concurrency: false }, () => {
  test('un lugar extra del dataset de clubes: precisión lugar, la dirección del dataset', async () => {
    const r = await resolver.resolver({ tipo: 'lugar', nombre_lugar: 'cancha de Huracán', texto_original: 'la cancha de Huracán' });
    assert.deepEqual([r.precision, r.ubicacionTipo, r.nombreLugar, r.barrio, r.comuna], ['lugar', 'lugar', 'Estadio Tomás A. Ducó (Huracán)', 'Parque Patricios', 4]);
    assert.equal(r.direccionNormalizada, 'Alcorta, Amancio Av. 2570');
  });

  test('un lugar extra por dirección se ubica con USIG al armar el índice', async () => {
    const r = await resolver.resolver({ tipo: 'lugar', nombre_lugar: 'el Obelisco' });
    assert.deepEqual([r.nombreLugar, r.barrio, r.precision], ['Obelisco', 'San Nicolas', 'lugar']);
  });

  test('un lugar sin dirección en el dataset: la inversa de USIG, cacheada para siempre', async () => {
    const r = await resolver.resolver({ tipo: 'lugar', nombre_lugar: 'plaza constitución' });
    assert.deepEqual([r.nombreLugar, r.direccionNormalizada, r.barrio], ['Plaza de la Constitución', 'LIMA 1500', 'Constitucion']);
    pedidos = [];
    await resolver.resolver({ tipo: 'lugar', nombre_lugar: 'plaza constitución' });
    assert.ok(!pedidos.some((p) => p.includes('reversegeocoding')));
  });

  test('"locales de Once" no es un lugar: es una mención de Balvanera, sin punto', async () => {
    const r = await resolver.resolver({ tipo: 'lugar', nombre_lugar: 'locales de Once' });
    assert.deepEqual([r.ubicacionTipo, r.barrio, r.comuna, r.x, r.precision, r.motivoSinUbicar], ['barrio', 'Balvanera', 3, null, 'ninguna', null]);
  });

  test('un barrio o una comuna solos: mención territorial', async () => {
    const soho = await resolver.resolver({ tipo: 'barrio', barrio_o_comuna: 'Palermo Soho' });
    assert.deepEqual([soho.barrio, soho.comuna, soho.ubicacionTipo], ['Palermo', 14, 'barrio']);
    const c7 = await resolver.resolver({ tipo: 'barrio', barrio_o_comuna: 'Comuna 7' });
    assert.deepEqual([c7.barrio, c7.comuna], [null, 7]);
    const nada = await resolver.resolver({ tipo: 'barrio', barrio_o_comuna: 'Springfield' });
    assert.equal(nada.motivoSinUbicar, 'no_encontrada');
  });

  test('una villa: precisión de área; "1 11 14" no llega a USIG como una altura', async () => {
    const v = await resolver.resolver({ tipo: 'villa', nombre_lugar: 'la 1-11-14', texto_original: 'en la 1-11-14 no pasa la basura' });
    assert.deepEqual([v.precision, v.ubicacionTipo, v.barrio], ['area', 'villa', 'Flores']);
    const disfrazada = await resolver.resolver({ tipo: 'calle_altura', calle: '1', altura: 11, texto_original: 'la 1 11 14' });
    assert.equal(disfrazada.ubicacionTipo, 'villa');
    assert.ok(!pedidos.some((p) => p.includes('normalizar_y_geocodificar')));
  });

  test('fuera de la Ciudad, lineal y ninguna', async () => {
    assert.equal((await resolver.resolver({ tipo: 'ninguna', fuera_de_caba: true })).motivoSinUbicar, 'fuera_de_caba');
    assert.equal((await resolver.resolver({ tipo: 'lineal', calle: 'General Paz' })).motivoSinUbicar, 'lineal');
    assert.equal((await resolver.resolver({ tipo: 'ninguna' })).motivoSinUbicar, 'sin_direccion');
  });
});

describe('texto libre (X, el importador)', { concurrency: false }, () => {
  test('una dirección que ya trae ", CABA": se manda una sola vez, y el punto sale de ws por el código', async () => {
    normalizador['ESTADOS UNIDOS 75, CABA'] = [{ cod_partido: 'caba', tipo: 'calle_altura', cod_calle: 6077, altura: 75, nombre_calle: 'ESTADOS UNIDOS', direccion: 'ESTADOS UNIDOS 75, CABA' }];
    geocoder['6077|75'] = gk(-58.36696, -34.61812);
    const r = await resolver.resolver(resolver.desdeTextoLibre('ESTADOS UNIDOS 75, CABA'));
    assert.deepEqual([r.precision, r.direccionNormalizada, r.barrio], ['puntual', 'ESTADOS UNIDOS 75', 'San Telmo']);
  });

  test('un tramo ("X entre Y y Z") se busca como el cruce de X y Y', () => {
    assert.equal(resolver.tramoACruce('Cabildo entre Juramento y Mendoza'), 'Cabildo y Juramento');
  });

  test('un lugar nombrado de antes va al índice de lugares', async () => {
    const r = await resolver.resolver(resolver.desdeTextoLibre('Plaza Miserere', 'lugar_nombrado'));
    assert.equal(r.nombreLugar, 'Plaza Miserere');
  });
});

describe('el worker', { concurrency: false }, () => {
  test('resuelve los pendientes: con la ubicación del modelo o con el texto de antes', async () => {
    db.upsertReclamo({ id: 'ig:9', comentarioId: 'ig:9', plataforma: 'instagram', textoOriginal: 'La cancha de Huracán es un desastre', categoria: 'Higiene urbana',
      direccionDetectada: 'la cancha de Huracán', ubicacionTipo: 'lugar', ubicacion: { tipo: 'lugar', nombre_lugar: 'cancha de Huracán', texto_original: 'la cancha de Huracán' } });
    db.upsertReclamo({ id: 'x:9', comentarioId: 'x:9', plataforma: 'x', textoOriginal: 'Sigue el bache', categoria: 'Higiene urbana', direccionDetectada: 'ESTADOS UNIDOS 75, CABA' });
    db.upsertReclamo({ id: 'x:10', comentarioId: 'x:10', plataforma: 'x', textoOriginal: 'sin lugar', categoria: 'Higiene urbana', direccionDetectada: '' });
    normalizador['ESTADOS UNIDOS 75, CABA'] = [{ cod_partido: 'caba', tipo: 'calle_altura', cod_calle: 6077, altura: 75, nombre_calle: 'ESTADOS UNIDOS', direccion: 'ESTADOS UNIDOS 75, CABA' }];
    geocoder['6077|75'] = gk(-58.36696, -34.61812);
    const res = await geoWorker.processPendingReclamos();
    assert.deepEqual(res, { pending: 3, processed: 3, errors: 0, fueraDeCaba: 0 });
    const ig = db.getReclamo('ig:9');
    assert.deepEqual([ig.precision, ig.nombreLugar, ig.geoStatus, ig.ubicacionTipo], ['lugar', 'Estadio Tomás A. Ducó (Huracán)', 'ok', 'lugar']);
    const x = db.getReclamo('x:9');
    assert.deepEqual([x.precision, x.geoStatus], ['puntual', 'ok']);
    assert.deepEqual([db.getReclamo('x:10').geoStatus, db.getReclamo('x:10').motivoSinUbicar], ['sin_direccion', 'sin_direccion']);
  });

  test('con USIG caído, el reclamo queda pendiente', async () => {
    db.upsertReclamo({ id: 'x:11', comentarioId: 'x:11', plataforma: 'x', textoOriginal: 'bache', categoria: 'Higiene urbana', direccionDetectada: 'Juramento 3109' });
    caido = true;
    const avisos = [];
    const original = console.warn;
    console.warn = (m) => avisos.push(String(m));
    try {
      const res = await geoWorker.processPendingReclamos();
      assert.equal(res.errors, 1);
    } finally {
      console.warn = original;
    }
    assert.equal(db.getReclamo('x:11').geoStatus, 'pendiente');
  });
});
