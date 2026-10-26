// ==========================================================================
// geoWorker.js
// --------------------------------------------------------------------------
// Procesa reclamos con geo_status = 'pendiente': los resuelve con
// src/geo/resolver.js (villas, USIG, lugares con nombre, barrios; fase H) y
// guarda el punto, la precisión y la comuna y el barrio, o el motivo.
// /api/analyze nunca geocodifica en el momento — deja las filas en
// 'pendiente' y responde enseguida; este worker las resuelve después (cron
// de scheduler.js, o disparado sin esperar tras un análisis), de a una.
// reintentarSinCoordenadas, una sola vez al arrancar, vuelve a mandar los
// que quedaron sin punto.
// ==========================================================================

const db = require('./db');
const resolver = require('./geo/resolver');

/**
 * La ubicación con la que se resuelve un reclamo: la del modelo (fase H,
 * ubicacion_json) o, si no la tiene (X, el importador, los de antes), su
 * dirección detectada como texto libre.
 */
function ubicacionDe(reclamo) {
  const u = reclamo.ubicacion;
  if (u && u.tipo) return u;
  const tipoViejo = reclamo.precision === 'aproximada' || reclamo.precision === 'lugar' ? 'lugar_nombrado' : null;
  return resolver.desdeTextoLibre(reclamo.direccionDetectada, tipoViejo);
}

/**
 * @returns {Promise<{ pending: number, processed: number, errors: number, fueraDeCaba: number }>}
 */
async function processPendingReclamos() {
  const pending = db.listPendingGeoReclamos();
  let processed = 0;
  let errors = 0;
  let fueraDeCaba = 0;

  for (const reclamo of pending) {
    const ubicacion = ubicacionDe(reclamo);
    try {
      const r = ubicacion
        ? await resolver.resolver(ubicacion, { texto: reclamo.textoOriginal })
        : { precision: 'ninguna', geoStatus: 'sin_direccion', motivoSinUbicar: 'sin_direccion' };
      if (r.geoStatus === 'fuera_caba') fueraDeCaba += 1;
      db.updateReclamoGeo(reclamo.id, r);
      processed += 1;
    } catch (err) {
      // Falla pasajera (USIG o un dataset sin respuesta): queda 'pendiente'
      // para la próxima corrida, no se pierde el reclamo. Cualquier otra
      // cosa es un error nuestro: queda sin ubicar, con el log, para no
      // volver a probarlo en cada ciclo.
      if (!err.transient) {
        console.error(`[geoWorker] "${reclamo.direccionDetectada}" (${reclamo.id}): ${err.message}`);
        db.updateReclamoGeo(reclamo.id, { precision: 'ninguna', geoStatus: 'no_encontrada', motivoSinUbicar: 'no_encontrada' });
      } else {
        console.warn(`[geoWorker] "${reclamo.direccionDetectada}" (${reclamo.id}): ${err.message}`);
      }
      errors += 1;
    }
  }

  if (pending.length > 0) {
    console.log(
      `[geoWorker] ${processed}/${pending.length} reclamos resueltos ` +
        `(${errors} con error, ${fueraDeCaba} fuera de la Ciudad)`
    );
    // Muchos fuera de la Ciudad en una tanda suele ser una señal de que el
    // geocoding está resolviendo mal las direcciones, no de reclamos
    // legítimamente afuera. Quedan guardados, con su motivo, pero nunca
    // tienen pin (ver listReclamosFiltered).
    if (fueraDeCaba > 0) {
      console.warn(
        `[geoWorker] ${fueraDeCaba} reclamo(s) quedaron fuera de la Ciudad en esta corrida ` +
        `(dirección real, pero de otro partido). No se muestran en el mapa.`
      );
    }
  }

  return { pending: pending.length, processed, errors, fueraDeCaba };
}

/** Dispara el worker sin esperar (usado tras /api/analyze). */
function processPendingReclamosInBackground() {
  processPendingReclamos().catch((err) => {
    console.error('[geoWorker] Error inesperado:', err.message);
  });
}

// La marca en refresh_state: el reintento corre una sola vez, en el primer
// arranque con el arreglo del (0,0) (los siguientes no vuelven a gastar
// consultas a USIG en direcciones que ya no se encontraron).
const MARCA_REINTENTO = 'geo_reintento_sin_coordenadas';

/**
 * Una sola vez: vuelve a ubicar todos los reclamos con dirección escrita y
 * sin un punto válido (sin coordenadas o en el (0,0)), con el mismo worker
 * de siempre (de a uno, con el backoff de USIG). Lo llama server.js al
 * arrancar. Deja la marca antes de empezar: si el proceso se corta, los que
 * quedaron 'pendiente' los termina el worker del ciclo.
 * @returns {Promise<{ total: number, ubicados: number } | null>} null si ya se había hecho.
 */
async function reintentarSinCoordenadas({ ahora = new Date().toISOString() } = {}) {
  if (db.getRefreshState(MARCA_REINTENTO)) return null;
  const ids = db.reabrirSinCoordenadas();
  db.setRefreshState(MARCA_REINTENTO, ahora);
  if (!ids.length) {
    console.log('[geo] reintento de los reclamos sin coordenadas: no había ninguno');
    return { total: 0, ubicados: 0 };
  }
  console.log(`[geo] reintento de los reclamos sin coordenadas: ${ids.length} vuelven a USIG`);
  await processPendingReclamos();
  const ubicados = db.contarUbicados(ids);
  console.log(`[geo] reintento de los reclamos sin coordenadas: ${ubicados} de ${ids.length} ubicados`);
  return { total: ids.length, ubicados };
}

module.exports = { processPendingReclamos, processPendingReclamosInBackground, reintentarSinCoordenadas, MARCA_REINTENTO };
