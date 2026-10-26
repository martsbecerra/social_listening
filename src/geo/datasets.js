// ==========================================================================
// geo/datasets.js
// --------------------------------------------------------------------------
// Bajar los datos abiertos del GCBA y guardarlos en data/geo (fase H). Lo
// que se guarda es lo YA LEÍDO (las filas de cada índice: nombre, tipo,
// punto, dirección), con la fecha; vale `refresco_dias` (30) y después se
// vuelve a armar. Si rearmar falla (red, un archivo que cambió de forma),
// sigue valiendo lo guardado y se avisa: un fallo nunca pisa un caché
// bueno. Sin caché y sin red, tira un error pasajero (el reclamo queda
// pendiente, no "no encontrado").
//
// Todos los pedidos de la georreferenciación (datasets y USIG) pasan por
// geoLimiter, un limitador PROPIO: nunca el de Apify (ver CLAUDE.md, el
// deadlock de compartir limitadores entre capas).
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { createLimiter } = require('../concurrencyLimiter');
const { geoDir } = require('./config');

const geoLimiter = createLimiter(2, 'geo', { quiet: true });
const DESCARGA_TIMEOUT_MS = 120000;

/** Un error que no dice nada del lugar buscado: se reintenta, nunca se cachea. */
function errorPasajero(mensaje) {
  const err = new Error(mensaje);
  err.transient = true;
  return err;
}

/** GET por el limitador, con tope de tiempo. `formato`: 'json' | 'texto'. */
async function bajar(url, { formato = 'json', timeoutMs = DESCARGA_TIMEOUT_MS } = {}) {
  return geoLimiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } catch (err) {
      throw errorPasajero(`no se pudo bajar ${new URL(url).pathname}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw errorPasajero(`${new URL(url).pathname}: HTTP ${resp.status}`);
    return formato === 'texto' ? resp.text() : resp.json();
  }, new URL(url).host);
}

function rutaCache(nombre) {
  return path.join(geoDir(), `${nombre}.json`);
}

function leerCache(nombre) {
  try {
    return JSON.parse(fs.readFileSync(rutaCache(nombre), 'utf8'));
  } catch {
    return null;
  }
}

// A un temporal y después rename: un corte a mitad no deja un archivo roto.
function guardarCache(nombre, datos) {
  fs.mkdirSync(geoDir(), { recursive: true });
  const tmp = `${rutaCache(nombre)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos));
  fs.renameSync(tmp, rutaCache(nombre));
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Lo guardado si está al día; si no, lo arma (`construir`, que devuelve las
 * filas) y lo guarda.
 * @param {string} nombre archivo en data/geo (sin .json)
 * @param {number} version del formato: otra versión se vuelve a armar
 * @param {() => Promise<object[]>} construir
 * @param {{ dias: number, ahora?: Date, forzar?: boolean }} opts
 * @returns {Promise<{ version: number, fetchedAt: string, filas: object[] }>}
 */
async function conCache(nombre, version, construir, { dias, ahora = new Date(), forzar = false }) {
  const cache = leerCache(nombre);
  const valido = cache && cache.version === version && Array.isArray(cache.filas);
  const alDia = valido && ahora.getTime() - Date.parse(cache.fetchedAt) < dias * DIA_MS;
  if (alDia && !forzar) return cache;
  try {
    const filas = await construir();
    const nuevo = { version, fetchedAt: ahora.toISOString(), filas };
    guardarCache(nombre, nuevo);
    console.log(`[geo] ${nombre}: ${filas.length} filas, guardadas en ${rutaCache(nombre)}`);
    return nuevo;
  } catch (err) {
    if (valido) {
      console.warn(`[geo] ${nombre}: no se pudo actualizar (${err.message}); sigue el del ${cache.fetchedAt.slice(0, 10)}`);
      return cache;
    }
    throw err.transient ? err : errorPasajero(`${nombre}: ${err.message}`);
  }
}

module.exports = { bajar, conCache, leerCache, geoLimiter, errorPasajero };
