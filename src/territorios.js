// ==========================================================================
// territorios.js
// --------------------------------------------------------------------------
// Comuna + barrio por intersección punto-polígono contra los GeoJSON
// territoriales del GCBA. Se descargan una sola vez y se cachean en disco
// (data/geo/*.geojson); corridas siguientes leen del caché.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');

const GEO_DIR = path.join(__dirname, '..', 'data', 'geo');
const COMUNAS_URL =
  'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/ministerio-de-educacion/comunas/comunas.geojson';
const BARRIOS_URL =
  'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/ministerio-de-educacion/barrios/barrios.geojson';
const COMUNAS_PATH = path.join(GEO_DIR, 'comunas.geojson');
const BARRIOS_PATH = path.join(GEO_DIR, 'barrios.geojson');

let comunasFeatures = null;
let barriosFeatures = null;

async function loadOrDownload(url, cachePath) {
  fs.mkdirSync(GEO_DIR, { recursive: true });
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
    const geojson = await loadOrDownload(COMUNAS_URL, COMUNAS_PATH);
    comunasFeatures = geojson.features || [];
  }
  if (!barriosFeatures) {
    const geojson = await loadOrDownload(BARRIOS_URL, BARRIOS_PATH);
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

module.exports = { ubicarPunto };
