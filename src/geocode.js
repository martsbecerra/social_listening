// ==========================================================================
// geocode.js
// --------------------------------------------------------------------------
// Una dirección escrita de cualquier forma → un punto, con USIG (servicio
// del GCBA), cacheada por dirección limpia en geocode_cache. Desde la fase H
// (openspec/changes/geo-pro) es un envoltorio de src/geo/usig.js
// (textoLibre): el normalizador sin `geocodificar` para los candidatos y el
// geocodificador de ws.usig para el punto (`geocodificar=true` se colgaba
// el 25/10/2026). Lo usa el importador (scripts/import-reclamos.js); los
// reclamos del análisis pasan por src/geo/resolver.js.
// ==========================================================================

const db = require('./db');
const { cleanAddress, isInvalidAddress } = require('./addressClean');
const usig = require('./geo/usig');

// "usig2:": las claves de antes ("usig:") quedaron con "no encontrada" por
// la falla de USIG del 25/10/2026; no se reusan.
function buildCacheKey(direccionLimpia) {
  return `usig2:${direccionLimpia.toLowerCase()}`;
}

const VACIO = { direccionNormalizada: null, calle: null, altura: null, cruce: null, x: null, y: null, precision: null };

/**
 * Geocodifica una dirección ya detectada (por el modelo o por el import de
 * Excel) contra USIG, con caché por dirección limpia.
 * @param {string} direccionDetectada
 * @param {{ soloLectura?: boolean, sinCacheFallida?: boolean }} [opts]
 *   soloLectura: consulta y lee la caché, pero no la escribe (el --dry-run
 *   del importador). sinCacheFallida: una dirección que la caché tiene como
 *   no encontrada (o ambigua) se vuelve a consultar.
 * @returns {Promise<{
 *   direccionNormalizada: string|null, calle: string|null, altura: number|null,
 *   cruce: string|null, x: number|null, y: number|null, precision: string|null,
 *   geoStatus: 'ok'|'no_encontrada'|'invalida'|'fuera_caba', motivo?: string
 * }>}
 */
async function geocodeAddress(direccionDetectada, { soloLectura = false, sinCacheFallida = false } = {}) {
  const guardarCache = (entry) => {
    if (!soloLectura) db.setGeocodeCache(entry);
  };
  const limpia = cleanAddress(direccionDetectada);
  if (isInvalidAddress(limpia)) return { ...VACIO, geoStatus: 'invalida' };

  const cacheKey = buildCacheKey(limpia);
  const cached = db.getGeocodeCache(cacheKey);
  if (cached && cached.status === 'ok' && usig.puntoValido(cached.lng, cached.lat)) {
    return {
      direccionNormalizada: cached.displayName,
      calle: cached.calle,
      altura: cached.altura,
      cruce: cached.cruce,
      x: cached.lng, // geocode_cache guarda X (longitud) en la columna lng
      y: cached.lat, // e Y (latitud) en lat.
      precision: cached.cruce ? 'cruce' : 'puntual',
      geoStatus: 'ok',
    };
  }
  if (cached && cached.status === 'fuera_caba') return { ...VACIO, direccionNormalizada: cached.displayName, geoStatus: 'fuera_caba' };
  if (cached && cached.status !== 'ok' && !sinCacheFallida) {
    return { ...VACIO, geoStatus: 'no_encontrada', ...(cached.status === 'ambigua' ? { motivo: 'ambigua' } : {}) };
  }

  let r;
  try {
    r = await usig.textoLibre(limpia);
  } catch (err) {
    // Falla de red o de USIG: no se cachea, el worker lo vuelve a intentar.
    const e = new Error(`USIG falló para "${limpia}": ${err.message}`);
    e.transient = true;
    throw e;
  }

  const ahora = new Date().toISOString();
  if (r.estado === 'ok') {
    guardarCache({ queryKey: cacheKey, lat: r.y, lng: r.x, displayName: r.direccion, status: 'ok', fetchedAt: ahora, calle: r.calle, altura: r.altura, cruce: r.cruce });
    return { direccionNormalizada: r.direccion, calle: r.calle, altura: r.altura, cruce: r.cruce, x: r.x, y: r.y, precision: r.cruce ? 'cruce' : 'puntual', geoStatus: 'ok' };
  }
  if (r.estado === 'fuera_caba') {
    guardarCache({ queryKey: cacheKey, displayName: r.direccion, status: 'fuera_caba', fetchedAt: ahora });
    return { ...VACIO, direccionNormalizada: r.direccion, geoStatus: 'fuera_caba' };
  }
  guardarCache({ queryKey: cacheKey, status: r.estado === 'ambigua' ? 'ambigua' : 'not_found', fetchedAt: ahora });
  return { ...VACIO, geoStatus: 'no_encontrada', ...(r.estado === 'ambigua' ? { motivo: 'ambigua' } : {}) };
}

module.exports = { geocodeAddress };
