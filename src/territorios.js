// ==========================================================================
// territorios.js
// --------------------------------------------------------------------------
// Comuna + barrio por intersección punto-polígono contra los GeoJSON
// territoriales del GCBA. Se descargan una sola vez y se cachean en disco
// (data/geo/*.geojson); corridas siguientes leen del caché. Desde la fase H
// también el barrio oficial de un nombre (con los nombres informales de
// config/geo-config.json: "Once" es Balvanera) y los polígonos de las
// comunas para la vista "Por comunas" del Mapa.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');
const { geoDir, geoConfig } = require('./geo/config');
const { normalizarLugar } = require('./geo/texto');

const COMUNAS_URL =
  'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/ministerio-de-educacion/comunas/comunas.geojson';
const BARRIOS_URL =
  'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/ministerio-de-educacion/barrios/barrios.geojson';

let comunasFeatures = null;
let barriosFeatures = null;

async function loadOrDownload(url, cachePath) {
  fs.mkdirSync(geoDir(), { recursive: true });
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`No se pudo descargar ${url}: HTTP ${resp.status}`);
  }
  const geojson = await resp.json();
  fs.writeFileSync(cachePath, JSON.stringify(geojson));
  return geojson;
}

async function ensureLoaded() {
  if (!comunasFeatures) {
    const geojson = await loadOrDownload(COMUNAS_URL, path.join(geoDir(), 'comunas.geojson'));
    comunasFeatures = geojson.features || [];
  }
  if (!barriosFeatures) {
    const geojson = await loadOrDownload(BARRIOS_URL, path.join(geoDir(), 'barrios.geojson'));
    barriosFeatures = geojson.features || [];
  }
}

/**
 * @param {number} x Longitud
 * @param {number} y Latitud
 * @returns {Promise<{comuna: number|null, barrio: string|null} | null>}
 *   null si el punto no cae en ninguna comuna (fuera de CABA).
 */
async function ubicarPunto(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  await ensureLoaded();
  const pt = point([x, y]);

  let comuna = null;
  for (const feature of comunasFeatures) {
    if (booleanPointInPolygon(pt, feature)) {
      const raw = feature.properties && feature.properties.comuna;
      comuna = Number.isFinite(Number(raw)) ? Number(raw) : null;
      break;
    }
  }
  if (comuna == null) return null;

  let barrio = null;
  for (const feature of barriosFeatures) {
    if (booleanPointInPolygon(pt, feature)) {
      barrio = (feature.properties && feature.properties.nombre) || null;
      break;
    }
  }

  return { comuna, barrio };
}

/**
 * El barrio oficial (y su comuna) de un nombre: "Palermo", "palermo soho",
 * "Once" (Balvanera, por barrios_informales), o una comuna sola ("Comuna 7",
 * sin barrio). null si no es ni un barrio ni una comuna de la Ciudad.
 * @returns {Promise<{ barrio: string|null, comuna: number } | null>}
 */
async function barrioPorNombre(nombre) {
  // El nombre de uso se busca entero ANTES de sacar "barrio" de adelante:
  // "Barrio Norte" es Recoleta, no "Norte".
  const entero = normalizarLugar(nombre);
  const clave = entero.replace(/^(?:barrio de|barrio|el barrio de|el barrio)\s+/, '');
  if (!clave) return null;
  await ensureLoaded();
  const comunaSola = clave.match(/^comuna (\d{1,2})$/);
  if (comunaSola) {
    const n = Number(comunaSola[1]);
    return comunasFeatures.some((f) => Number(f.properties && f.properties.comuna) === n) ? { barrio: null, comuna: n } : null;
  }
  const informales = geoConfig().barrios_informales || {};
  const alias =
    Object.entries(informales).find(([k]) => normalizarLugar(k) === entero) || Object.entries(informales).find(([k]) => normalizarLugar(k) === clave);
  const buscado = normalizarLugar(alias ? alias[1] : clave);
  const f = barriosFeatures.find((b) => normalizarLugar(b.properties && b.properties.nombre) === buscado);
  if (!f) return null;
  const comuna = Number(f.properties.comuna);
  return { barrio: f.properties.nombre, comuna: Number.isFinite(comuna) ? comuna : null };
}

/** Los polígonos de las 15 comunas (GeoJSON), para el Mapa. */
async function comunasGeojson() {
  await ensureLoaded();
  return { type: 'FeatureCollection', features: comunasFeatures };
}

/** Los nombres oficiales de los 48 barrios, normalizados (para no tomarlos como un lugar). */
async function nombresDeBarrios() {
  await ensureLoaded();
  return barriosFeatures.map((b) => normalizarLugar(b.properties && b.properties.nombre)).filter(Boolean);
}

module.exports = { ubicarPunto, barrioPorNombre, comunasGeojson, nombresDeBarrios };
