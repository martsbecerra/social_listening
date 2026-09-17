// ==========================================================================
// platforms/errors.js — Errores tipificados que un adapter puede lanzar.
// --------------------------------------------------------------------------
// El orquestador (src/monitor.js), el refresco de métricas y los scripts no
// tienen que saber qué fuente usa cada plataforma para reaccionar a un
// error: el adapter marca `err.code` y acá se interpreta. Códigos:
//   - NOT_CONFIGURED: faltan credenciales (APIFY_API_TOKEN, clave de Grok).
//   - QUOTA_EXCEEDED: la fuente agotó su cuota / créditos; no tiene sentido
//                     seguir consultando esa plataforma en esta corrida.
//   - RATE_LIMITED:   pedido rechazado por rate limit; reintentar más tarde.
//   - AUTH_INVALID:   credencial inválida.
//
// Los cuatro son "errores de plataforma": no fallan por UNA fuente (una
// cuenta privada, un hashtag sin resultados) sino porque la plataforma
// entera no se puede consultar. El orquestador los trata distinto de un
// fallo puntual: en "Actualizar ahora" de esa solapa el error le llega al
// usuario en vez de un "0 nuevos" que parece un éxito; en el cron se anota y
// se sigue con las demás redes. Los errores sin `code` siguen siendo fallos
// de una fuente, que solo se loguean.
// ==========================================================================

const { isQuotaExceededError } = require('../apify');

const PLATFORM_ERROR_CODES = ['NOT_CONFIGURED', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'AUTH_INVALID'];

/** Cuota agotada, por código del adapter o (fallback) por el texto de Apify. */
function isQuotaExceeded(err) {
  return Boolean(err && (err.code === 'QUOTA_EXCEEDED' || isQuotaExceededError(err)));
}

function isNotConfigured(err) {
  return Boolean(err && err.code === 'NOT_CONFIGURED');
}

/**
 * true si el error deja fuera de servicio a la plataforma entera (ver
 * códigos arriba), no solo a la fuente que lo tiró.
 */
function isPlatformError(err) {
  return Boolean(err && (PLATFORM_ERROR_CODES.includes(err.code) || isQuotaExceeded(err)));
}

module.exports = { PLATFORM_ERROR_CODES, isQuotaExceeded, isNotConfigured, isPlatformError };
