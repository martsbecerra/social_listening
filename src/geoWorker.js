// ==========================================================================
// geoWorker.js
// --------------------------------------------------------------------------
// Procesa reclamos con geo_status = 'pendiente': geocodifica con USIG
// (geocode.js) y asigna comuna/barrio (territorios.js). /api/analyze nunca
// geocodifica en el momento — deja las filas en 'pendiente' y responde
// enseguida; este worker las resuelve después (cron de scheduler.js, o
// disparado sin esperar tras un análisis).
// ==========================================================================

const db = require('./db');
const { geocodeAddress } = require('./geocode');
const { ubicarPunto } = require('./territorios');

/**
 * @returns {Promise<{ pending: number, processed: number, errors: number, fueraDeCaba: number }>}
 */
async function processPendingReclamos() {
  const pending = db.listPendingGeoReclamos();
  let processed = 0;
  let errors = 0;
  let fueraDeCaba = 0;

  for (const reclamo of pending) {
    if (!reclamo.direccionDetectada || !reclamo.direccionDetectada.trim()) {
      db.updateReclamoGeo(reclamo.id, {
        direccionNormalizada: null,
        calle: null,
        altura: null,
        cruce: null,
        x: null,
        y: null,
        comuna: null,
        barrio: null,
        precision: null,
        geoStatus: 'sin_direccion',
      });
      processed += 1;
      continue;
    }

    try {
      const geo = await geocodeAddress(reclamo.direccionDetectada);

      if (geo.geoStatus !== 'ok') {
        // USIG puede resolver la dirección en otro partido (ver geocode.js):
        // eso es fuera_caba, no "no había dirección". Se cuenta acá también,
        // no sólo en el chequeo de polígonos de más abajo.
        if (geo.geoStatus === 'fuera_caba') fueraDeCaba += 1;
        db.updateReclamoGeo(reclamo.id, {
          direccionNormalizada: geo.direccionNormalizada,
          calle: geo.calle,
          altura: geo.altura,
          cruce: geo.cruce,
          x: geo.x,
          y: geo.y,
          comuna: null,
          barrio: null,
          precision: geo.precision,
          geoStatus: geo.geoStatus,
        });
        processed += 1;
        continue;
      }

      const territorio = await ubicarPunto(geo.x, geo.y);
      const geoStatus = territorio ? 'ok' : 'fuera_caba';
      if (geoStatus === 'fuera_caba') fueraDeCaba += 1;
      db.updateReclamoGeo(reclamo.id, {
        direccionNormalizada: geo.direccionNormalizada,
        calle: geo.calle,
        altura: geo.altura,
        cruce: geo.cruce,
        x: geo.x,
        y: geo.y,
        comuna: territorio ? territorio.comuna : null,
        barrio: territorio ? territorio.barrio : null,
        // USIG siempre devuelve 'exacta' cuando resuelve, porque para él la
        // consulta resolvió y punto. Pero si el LLM dijo que la ubicación era
        // un lugar con nombre propio ("Plaza Italia"), el punto es el centroide
        // del lugar, no una altura: esa marca la puso reclamosFromAnalysis y no
        // se pisa. Ver el pin punteado del mapa.
        precision: reclamo.precision === 'aproximada' ? 'aproximada' : geo.precision,
        geoStatus,
      });
      processed += 1;
    } catch (err) {
      // Falla transitoria (red/timeout de USIG): se deja 'pendiente' para
      // reintentar en la próxima corrida, no se pierde el reclamo.
      console.warn(`[geoWorker] "${reclamo.direccionDetectada}" (${reclamo.id}): ${err.message}`);
      errors += 1;
    }
  }

  if (pending.length > 0) {
    console.log(
      `[geoWorker] ${processed}/${pending.length} reclamos geocodificados ` +
        `(${errors} con error transitorio, ${fueraDeCaba} fuera_caba)`
    );
    // Muchos fuera_caba en una tanda suele ser una señal de que el
    // geocoding está resolviendo mal las direcciones, no de reclamos
    // legítimamente fuera de la ciudad. Estos reclamos quedan guardados pero
    // nunca se muestran ni se exportan (ver listReclamosFiltered).
    if (fueraDeCaba > 0) {
      console.warn(
        `[geoWorker] ${fueraDeCaba} reclamo(s) quedaron fuera_caba en esta corrida ` +
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

module.exports = { processPendingReclamos, processPendingReclamosInBackground };
