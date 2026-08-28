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

/**
 * GET a USIG con reintentos + backoff exponencial. Lanza si se agotan los intentos.
 * @param {string} direccionLimpia
 * @param {{ calificarCaba?: boolean }} [opts] `calificarCaba: false` consulta la
 *   dirección tal cual, sin forzar CABA — se usa sólo para averiguar A QUÉ
 *   partido pertenece una dirección que CABA no reconoció (ver geocodeAddress).
 */
async function requestUsig(direccionLimpia, { calificarCaba = true } = {}) {
  const url = new URL(USIG_URL);
  // Sin calificar "CABA", USIG devuelve un resultado ambiguo por partido
  // (Escobar, Ezeiza, Moreno, Pilar, Quilmes...) y ninguno trae coordenadas
  // hasta que la dirección resuelve a un único partido.
  url.searchParams.set('direccion', calificarCaba ? `${direccionLimpia}, CABA` : direccionLimpia);
  // Sin esto USIG normaliza pero no siempre devuelve el punto: las esquinas
  // resolvían de forma inconsistente ("Nazca y Rivadavia" traía coordenadas,
  // "Cabildo y Juramento" no), y las que no traían terminaban en
  // 'sin_direccion' aunque fueran cruces perfectamente válidos de CABA.
  url.searchParams.set('geocodificar', 'true');

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
 * Segunda consulta, sin forzar CABA, para saber si una dirección que CABA no
 * reconoció pertenece a otro partido. Sólo corre en el camino de fallo (que
 * además queda cacheado), así que no agrega tráfico al caso normal.
 * @returns {Promise<{ direccion: string, partido: string } | null>}
 */
async function buscarEnOtroPartido(direccionLimpia) {
  // Un fallo transitorio acá se propaga como transitorio: preferimos
  // reintentar en la próxima corrida antes que cachear un 'sin_direccion'
  // que quizá era un fuera_caba.
  const data = await requestUsig(direccionLimpia, { calificarCaba: false });

  const hits = (data && Array.isArray(data.direccionesNormalizadas) && data.direccionesNormalizadas) || [];
  const afuera = hits.find((h) => h && h.cod_partido && h.cod_partido !== 'caba');
  if (!afuera) return null;

  return {
    direccion: afuera.direccion || direccionLimpia,
    partido: afuera.cod_partido,
  };
}

/**
 * Geocodifica una dirección ya detectada (por Claude o por el import de
 * Excel) contra USIG, con caché por dirección limpia.
 * @param {string} direccionDetectada
 * @returns {Promise<{
 *   direccionNormalizada: string|null, calle: string|null, altura: number|null,
 *   cruce: string|null, x: number|null, y: number|null, precision: string|null,
 *   geoStatus: 'ok'|'no_encontrada'|'invalida'|'fuera_caba'
 * }>}
 */
async function geocodeAddress(direccionDetectada, { soloLectura = false } = {}) {
  // soloLectura: consulta y lee la cache, pero no la escribe. Lo usa el
  // --dry-run del importador, que no debe dejar rastro en la base.
  const guardarCache = (entry) => { if (!soloLectura) db.setGeocodeCache(entry); };
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
    // 'fuera_caba' se cachea igual que los demás: una dirección de otro
    // partido no cambia de partido, no hay por qué volver a preguntar.
    const geoStatus =
      cached.status === 'ok' ? 'ok' : cached.status === 'fuera_caba' ? 'fuera_caba' : 'no_encontrada';
    return {
      direccionNormalizada: cached.displayName,
      calle: cached.calle,
      altura: cached.altura,
      cruce: cached.cruce,
      x: cached.lng, // geocode_cache guarda X (longitud) en la columna lng.
      y: cached.lat, // e Y (latitud) en lat: mismo sentido geográfico real.
      precision: geoStatus === 'ok' ? 'exacta' : null,
      geoStatus,
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
    const ahora = new Date().toISOString();

    // OJO con la diferencia entre "USIG no la reconoce" y "USIG la reconoce
    // pero no puede darle un punto". Para "Plaza Italia" o "Cabildo y
    // Juramento" devuelve candidatos con cod_partido 'caba' SIN coordenadas:
    // son direcciones porteñas que no pudo precisar, no direcciones de afuera.
    // Si en ese caso saliéramos a buscar en otros partidos, encontraríamos
    // homónimos (Plaza Italia existe en La Plata) y las marcaríamos fuera_caba,
    // que las saca del mapa por completo. Sólo se busca afuera cuando CABA no
    // reconoció NADA.
    const hayCandidatoCaba = hits.some((h) => h && h.cod_partido === 'caba');
    if (hayCandidatoCaba) {
      guardarCache({
        queryKey: cacheKey,
        lat: null,
        lng: null,
        displayName: null,
        status: 'not_found',
        fetchedAt: ahora,
      });
      return {
        direccionNormalizada: null,
        calle: null,
        altura: null,
        cruce: null,
        x: null,
        y: null,
        precision: null,
        geoStatus: 'no_encontrada',
      };
    }

    // CABA no reconoció nada. Antes se devolvía 'sin_direccion' acá y se perdía
    // una distinción importante: "el comentario no traía dirección" y "la
    // dirección es de otro municipio" quedaban idénticas, así que no había
    // forma de ver que el geocoding estaba trayendo cosas de afuera.
    // Consultamos de nuevo SIN forzar CABA: si USIG la ubica en otro partido,
    // es fuera_caba; si no la ubica en ningún lado, sí es sin_direccion.
    const afuera = await buscarEnOtroPartido(limpia);

    if (afuera) {
      guardarCache({
        queryKey: cacheKey,
        lat: null,
        lng: null,
        // Guardamos la dirección tal como la ve el otro partido: es el rastro
        // que sirve para auditar de dónde vienen. No se filtra a la UI —
        // listReclamosFiltered excluye siempre los fuera_caba.
        displayName: afuera.direccion,
        status: 'fuera_caba',
        fetchedAt: ahora,
      });
      return {
        direccionNormalizada: afuera.direccion,
        calle: null,
        altura: null,
        cruce: null,
        x: null,
        y: null,
        precision: null,
        geoStatus: 'fuera_caba',
      };
    }

    guardarCache({
      queryKey: cacheKey,
      lat: null,
      lng: null,
      displayName: null,
      status: 'not_found',
      fetchedAt: ahora,
    });
    return {
      direccionNormalizada: null,
      calle: null,
      altura: null,
      cruce: null,
      x: null,
      y: null,
      precision: null,
      geoStatus: 'no_encontrada',
    };
  }

  const x = Number(hit.coordenadas.x);
  const y = Number(hit.coordenadas.y);
  const calle = hit.nombre_calle || null;
  const altura = hit.altura != null && hit.altura !== '' ? Number(hit.altura) : null;
  const cruce = hit.nombre_calle_cruce || null;
  const direccionNormalizada = hit.direccion || limpia;

  guardarCache({
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
