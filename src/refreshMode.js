// ==========================================================================
// refreshMode.js — Interruptor REFRESH_MODE del refresco de métricas.
// --------------------------------------------------------------------------
// Cómo refresca likes/comentarios de los posteos ya guardados
// src/metricsRefresh.js (ver openspec/changes/refresco-url):
//   - "url" (default): cada publicación vencida se pide por su URL al actor
//     oficial apify/instagram-scraper (instagram.fetchPostDetails, el mismo
//     camino del detalle de búsqueda): un run por ciclo con todas las URLs,
//     en lotes de hasta 100, 0,0023 usd por posteo, decidido por publicación.
//   - "perfil": lo anterior al cambio, sin modificaciones: una consulta de
//     perfil por cuenta con posteos vencidos (apidojo, últimos
//     BENCHMARK_POST_LIMIT posteos, tope MAX_ACCOUNTS_PER_REFRESH).
// Un valor desconocido aborta el arranque (server.js lo valida antes de
// cargar los módulos), igual que IG_ACTOR: un typo no puede caer en
// silencio a un modo que cobra distinto.
// ==========================================================================

const REFRESH_MODES = ['url', 'perfil'];
const DEFAULT_REFRESH_MODE = 'url';

/**
 * @param {string} [raw] valor de REFRESH_MODE (por defecto, el del entorno).
 * @returns {'url'|'perfil'}
 * @throws {Error} con userMessage si el valor no es válido.
 */
function resolveRefreshMode(raw = process.env.REFRESH_MODE) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (value === '') return DEFAULT_REFRESH_MODE;
  if (REFRESH_MODES.includes(value)) return value;
  const e = new Error(
    `REFRESH_MODE="${raw}" no es válido. Valores posibles: ${REFRESH_MODES.map((v) => `"${v}"`).join(' o ')} ` +
      `(vacío = "${DEFAULT_REFRESH_MODE}"). Revisá el archivo .env.`
  );
  e.userMessage = e.message;
  throw e;
}

module.exports = { REFRESH_MODES, DEFAULT_REFRESH_MODE, resolveRefreshMode };
