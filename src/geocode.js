// ==========================================================================
// geocode.js
// --------------------------------------------------------------------------
// Nominatim solo para el CLI de import. El mapa y el GET nunca geocodifican:
// leen lat/lng ya guardados. Cache en geocode_cache + copia a reclamos.
// ==========================================================================

const db = require('./db');
const { buildGeocodeQueryKey } = require('./reclamosAddress');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100;
const AMBA_VIEWBOX = '-58.75,-34.40,-58.25,-34.85';

let lastNominatimAt = 0;

function requireNominatimUserAgent() {
  const ua = (process.env.NOMINATIM_USER_AGENT || '').trim();
  if (!ua) {
    const err = new Error(
      'Falta NOMINATIM_USER_AGENT en el .env. Nominatim exige un User-Agent que identifique la app.'
    );
    err.userMessage = err.message;
    throw err;
  }
  return ua;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitNominatimSlot() {
  const wait = lastNominatimAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatimAt = Date.now();
}

/**
 * @param {string} direccionNormalizada
 * @returns {Promise<{ lat: number|null, lng: number|null, displayName: string|null, status: string }>}
 */
async function geocodeNormalizedAddress(direccionNormalizada) {
  const queryKey = buildGeocodeQueryKey(direccionNormalizada);
  const cached = db.getGeocodeCache(queryKey);
  if (cached) {
    return {
      lat: cached.lat,
      lng: cached.lng,
      displayName: cached.displayName,
      status: cached.status,
    };
  }

  const ua = requireNominatimUserAgent();
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'ar');
  url.searchParams.set('viewbox', AMBA_VIEWBOX);
  url.searchParams.set('bounded', '0');
  url.searchParams.set('accept-language', 'es');
  url.searchParams.set('q', queryKey);

  await waitNominatimSlot();

  let status = 'error';
  let lat = null;
  let lng = null;
  let displayName = null;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: 'application/json' },
    });
    if (resp.status === 429) {
      status = 'error';
    } else if (!resp.ok) {
      status = 'error';
    } else {
      const items = await resp.json();
      const hit = Array.isArray(items) && items[0];
      if (hit && hit.lat && hit.lon) {
        lat = Number(hit.lat);
        lng = Number(hit.lon);
        displayName = hit.display_name || null;
        status = 'ok';
      } else {
        status = 'not_found';
      }
    }
  } catch {
    status = 'error';
  }

  db.setGeocodeCache({
    queryKey,
    lat,
    lng,
    displayName,
    status,
    fetchedAt: new Date().toISOString(),
  });

  return { lat, lng, displayName, status };
}

/**
 * Geocodifica claves pendientes y copia lat/lng + status a las filas.
 * @returns {Promise<{ pending: number, fromCache: number, fetched: number }>}
 */
async function geocodePendingReclamos() {
  const pending = db.listPendingGeocode();
  let fromCache = 0;
  let fetched = 0;

  for (const norm of pending) {
    const queryKey = buildGeocodeQueryKey(norm);
    const hadCache = Boolean(db.getGeocodeCache(queryKey));
    const result = await geocodeNormalizedAddress(norm);
    if (hadCache) fromCache += 1;
    else fetched += 1;
    db.applyGeocodeToReclamos(norm, result);
  }

  return { pending: pending.length, fromCache, fetched };
}

module.exports = {
  requireNominatimUserAgent,
  geocodeNormalizedAddress,
  geocodePendingReclamos,
  buildGeocodeQueryKey,
};
