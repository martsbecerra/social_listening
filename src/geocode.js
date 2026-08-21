// ==========================================================================
// geocode.js
// --------------------------------------------------------------------------
// Geocoding con USIG (servicio del GCBA): mucho mejor que Nominatim para
// CABA, valida que la altura exista en esa calle. Cachea por dirección
// normalizada en geocode_cache (src/db.js) para nunca pedirle a USIG la
// misma dirección dos veces. No se llama desde /api/analyze (demasiado
// lento): lo usa src/geoWorker.js, en cron o disparado tras un análisis.
// ==========================================================================

const db = require('./db');
const { cleanAddress, isInvalidAddress } = require('./addressClean');

const USIG_URL = 'https://servicios.usig.buenosaires.gob.ar/normalizar/';
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 8000;
const BASE_BACKOFF_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCacheKey(direccionLimpia) {
  return `usig:${direccionLimpia.toLowerCase()}`;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET a USIG con reintentos + backoff exponencial. Lanza si se agotan los intentos. */
async function requestUsig(direccionLimpia) {
  const url = new URL(USIG_URL);
  // Sin calificar "CABA", USIG devuelve un resultado ambiguo por partido
  // (Escobar, Ezeiza, Moreno, Pilar, Quilmes...) y ninguno trae coordenadas
  // hasta que la dirección resuelve a un único partido.
  url.searchParams.set('direccion', `${direccionLimpia}, CABA`);

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
      if (resp.status === 429 || resp.status >= 500) {
        throw new Error(`USIG HTTP ${resp.status}`);
      }
      if (!resp.ok) {
        // 4xx que no sea 429: la dirección no es geocodificable, no reintentar.
        return null;
      }
      return await resp.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}

/**
 * Geocodifica una dirección ya detectada (por Claude o por el import de
 * Excel) contra USIG, con caché por dirección limpia.
 * @param {string} direccionDetectada
 * @returns {Promise<{
 *   direccionNormalizada: string|null, calle: string|null, altura: number|null,
 *   cruce: string|null, x: number|null, y: number|null, precision: string|null,
 *   geoStatus: 'ok'|'sin_direccion'|'invalida'
 * }>}
 */
async function geocodeAddress(direccionDetectada) {
  const limpia = cleanAddress(direccionDetectada);

  if (isInvalidAddress(limpia)) {
    return {
      direccionNormalizada: null,
      calle: null,
      altura: null,
      cruce: null,
      x: null,
      y: null,
      precision: null,
      geoStatus: 'invalida',
    };
  }

  const cacheKey = buildCacheKey(limpia);
  const cached = db.getGeocodeCache(cacheKey);
  if (cached) {
    return {
      direccionNormalizada: cached.displayName,
      calle: cached.calle,
      altura: cached.altura,
      cruce: cached.cruce,
      x: cached.lng, // geocode_cache guarda X (longitud) en la columna lng.
      y: cached.lat, // e Y (latitud) en lat: mismo sentido geográfico real.
      precision: 'exacta',
      geoStatus: cached.status === 'ok' ? 'ok' : 'sin_direccion',
    };
  }

  let data;
  try {
    data = await requestUsig(limpia);
  } catch (err) {
    // Falla de red/timeout agotando reintentos: no cachear, para reintentar
    // en la próxima corrida del worker en vez de quedar "sin_direccion" para siempre.
    const e = new Error(`USIG falló para "${limpia}": ${err.message}`);
    e.transient = true;
    throw e;
  }

  // cod_partido: por si la desambiguación por ", CABA" no alcanzara, no
  // geocodificamos un reclamo de CABA a un partido del conurbano.
  const hits = (data && Array.isArray(data.direccionesNormalizadas) && data.direccionesNormalizadas) || [];
  const hit = hits.find((h) => h && h.coordenadas && h.cod_partido === 'caba') || null;
  if (!hit) {
    db.setGeocodeCache({
      queryKey: cacheKey,
      lat: null,
      lng: null,
      displayName: null,
      status: 'not_found',
      fetchedAt: new Date().toISOString(),
    });
    return {
      direccionNormalizada: null,
      calle: null,
      altura: null,
      cruce: null,
      x: null,
      y: null,
      precision: null,
      geoStatus: 'sin_direccion',
    };
  }

  const x = Number(hit.coordenadas.x);
  const y = Number(hit.coordenadas.y);
  const calle = hit.nombre_calle || null;
  const altura = hit.altura != null && hit.altura !== '' ? Number(hit.altura) : null;
  const cruce = hit.nombre_calle_cruce || null;
  const direccionNormalizada = hit.direccion || limpia;

  db.setGeocodeCache({
    queryKey: cacheKey,
    lat: Number.isFinite(y) ? y : null,
    lng: Number.isFinite(x) ? x : null,
    displayName: direccionNormalizada,
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    calle,
    altura,
    cruce,
  });

  return {
    direccionNormalizada,
    calle,
    altura,
    cruce,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    precision: 'exacta',
    geoStatus: Number.isFinite(x) && Number.isFinite(y) ? 'ok' : 'sin_direccion',
  };
}

module.exports = { geocodeAddress };
