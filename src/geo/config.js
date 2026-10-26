// ==========================================================================
// geo/config.js
// --------------------------------------------------------------------------
// Las listas de la georreferenciación (fase H, openspec/changes/geo-pro):
// config/geo-config.json, versionado; si existe data/geo/geo-config.json,
// cada clave que traiga reemplaza a la del versionado (se edita sin commit).
// Se leen una vez y quedan en memoria; recargar() vuelve a leer (tests).
//
// La carpeta de los cachés (data/geo) se puede cambiar con
// MONITORING_GEO_DIR (solo los tests, para no tocar data/), y el archivo
// versionado con MONITORING_GEO_CONFIG_PATH.
// ==========================================================================

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');

function geoDir() {
  return process.env.MONITORING_GEO_DIR || path.join(RAIZ, 'data', 'geo');
}

function rutaVersionada() {
  return process.env.MONITORING_GEO_CONFIG_PATH || path.join(RAIZ, 'config', 'geo-config.json');
}

function rutaLocal() {
  return path.join(geoDir(), 'geo-config.json');
}

let cargada = null;

function leerJson(ruta) {
  return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

/**
 * La configuración en uso. Un data/geo/geo-config.json roto no frena nada:
 * se avisa y vale la versionada.
 * @returns {object}
 */
function geoConfig() {
  if (cargada) return cargada;
  const base = leerJson(rutaVersionada());
  let local = null;
  if (fs.existsSync(rutaLocal())) {
    try {
      local = leerJson(rutaLocal());
    } catch (err) {
      console.warn(`[geo] ${rutaLocal()} no se pudo leer (${err.message}): vale config/geo-config.json`);
    }
  }
  cargada = { ...base, ...(local && typeof local === 'object' ? local : {}) };
  return cargada;
}

function recargar() {
  cargada = null;
  return geoConfig();
}

module.exports = { geoConfig, recargar, geoDir };
