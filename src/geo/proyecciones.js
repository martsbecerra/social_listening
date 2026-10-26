// ==========================================================================
// geo/proyecciones.js
// --------------------------------------------------------------------------
// Conversión entre las coordenadas planas que usan el GCBA y USIG y la
// latitud / longitud del mapa (fase H, openspec/changes/geo-pro). Sin red y
// sin librerías: la Mercator transversa (serie de Snyder, "Map Projections
// — A Working Manual", 1987) y, para Gauss-Krüger, el corrimiento de datum
// de tres parámetros.
//
// - Gauss-Krüger Buenos Aires: el sistema del dataset de barrios populares
//   (declara WGS84 pero no lo es, ver villas.py del proyecto original) y el
//   de los servicios de ws.usig (geocoder, normalizar_y_geocodificar).
//   Elipsoide Internacional 1924, datum Campo Inchauspe → WGS84 con
//   -148, 136, 90 (el crs_local de villas.py).
// - EPSG:9498, POSGAR 2007 / CABA 2019: hospitales y escuelas. GRS80, que a
//   los fines del mapa es WGS84: sin corrimiento.
// Los dos comparten el origen (-34,6297166, -58,4627). Un test los compara
// contra convertir_coordenadas de USIG.
// ==========================================================================

const RAD = Math.PI / 180;

const INTERNACIONAL_1924 = { a: 6378388, f: 1 / 297 };
const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const WGS84 = { a: 6378137, f: 1 / 298.257223563 };

const ORIGEN = { lat0: -34.6297166, lon0: -58.4627 };

const GK_BA = { ...ORIGEN, k0: 1, fe: 100000, fn: 100000, elipsoide: INTERNACIONAL_1924, aWgs84: [-148, 136, 90] };
const CABA_2019 = { ...ORIGEN, k0: 0.999998, fe: 20000, fn: 70000, elipsoide: GRS80, aWgs84: null };

function constantes({ a, f }) {
  const e2 = f * (2 - f);
  return { a, e2, ep2: e2 / (1 - e2) };
}

// Arco de meridiano desde el ecuador hasta la latitud phi (radianes).
function arcoMeridiano(phi, a, e2) {
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return (
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

/** Latitud / longitud (grados, en el elipsoide del sistema) → x, y planas. */
function tmercDirecta(lat, lon, sis) {
  const { a, e2, ep2 } = constantes(sis.elipsoide);
  const phi = lat * RAD;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = (lon - sis.lon0) * RAD * Math.cos(phi);
  const M = arcoMeridiano(phi, a, e2);
  const M0 = arcoMeridiano(sis.lat0 * RAD, a, e2);
  const x = sis.fe + sis.k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120);
  const y =
    sis.fn +
    sis.k0 *
      (M - M0 + N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x, y };
}

/** x, y planas → latitud / longitud (grados, en el elipsoide del sistema). */
function tmercInversa(x, y, sis) {
  const { a, e2, ep2 } = constantes(sis.elipsoide);
  const M0 = arcoMeridiano(sis.lat0 * RAD, a, e2);
  const M = M0 + (y - sis.fn) / sis.k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sen = Math.sin(phi1);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * sen * sen);
  const R1 = (a * (1 - e2)) / (1 - e2 * sen * sen) ** 1.5;
  const D = (x - sis.fe) / (N1 * sis.k0);
  const phi =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lambda = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(phi1);
  return { lat: phi / RAD, lon: sis.lon0 + lambda / RAD };
}

// Geodésicas (altura 0) ↔ cartesianas geocéntricas.
function aGeocentricas(lat, lon, elipsoide) {
  const { a, e2 } = constantes(elipsoide);
  const phi = lat * RAD;
  const lam = lon * RAD;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [N * Math.cos(phi) * Math.cos(lam), N * Math.cos(phi) * Math.sin(lam), N * (1 - e2) * Math.sin(phi)];
}

function aGeodesicas([X, Y, Z], elipsoide) {
  const { a, e2 } = constantes(elipsoide);
  const p = Math.hypot(X, Y);
  let phi = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const h = p / Math.cos(phi) - N;
    phi = Math.atan2(Z, p * (1 - (e2 * N) / (N + h)));
  }
  return { lat: phi / RAD, lon: Math.atan2(Y, X) / RAD };
}

function correrDatum(lat, lon, desde, hacia, [dx, dy, dz], signo) {
  const [X, Y, Z] = aGeocentricas(lat, lon, desde);
  return aGeodesicas([X + signo * dx, Y + signo * dy, Z + signo * dz], hacia);
}

/** x, y de un sistema plano → { lon, lat } WGS84. */
function aLonLat(x, y, sis) {
  const { lat, lon } = tmercInversa(Number(x), Number(y), sis);
  if (!sis.aWgs84) return { lon, lat };
  const w = correrDatum(lat, lon, sis.elipsoide, WGS84, sis.aWgs84, 1);
  return { lon: w.lon, lat: w.lat };
}

/** { lon, lat } WGS84 → x, y de un sistema plano. */
function desdeLonLat(lon, lat, sis) {
  let p = { lat: Number(lat), lon: Number(lon) };
  if (sis.aWgs84) p = correrDatum(p.lat, p.lon, WGS84, sis.elipsoide, sis.aWgs84, -1);
  return tmercDirecta(p.lat, p.lon, sis);
}

const gkBaALonLat = (x, y) => aLonLat(x, y, GK_BA);
const lonLatAGkBa = (lon, lat) => desdeLonLat(lon, lat, GK_BA);
const caba2019ALonLat = (x, y) => aLonLat(x, y, CABA_2019);

/** Coordenadas que no pueden ser grados (x, y del orden de 100.000): un sistema plano. */
function esPlana(x, y) {
  return Math.abs(Number(x)) > 180 || Math.abs(Number(y)) > 90;
}

module.exports = { gkBaALonLat, lonLatAGkBa, caba2019ALonLat, esPlana, GK_BA, CABA_2019 };
