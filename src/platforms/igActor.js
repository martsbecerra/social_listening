// ==========================================================================
// platforms/igActor.js — Interruptor IG_ACTOR del adapter de Instagram.
// --------------------------------------------------------------------------
// Qué actor de Apify usa el MONITOREO de Instagram (detección, benchmark,
// refresco de métricas, validación de cuentas y hashtags, script de
// recálculo):
//   - "apidojo" (default): apidojo/instagram-scraper-api. Cobra por consulta
//     con posteos incluidos y trae seguidores en cada posteo y búsqueda por
//     palabra clave (ver instagramApidojo.js).
//   - "apify": apify/instagram-scraper, el actor de siempre. Cobra por
//     resultado. Con este valor todo funciona exactamente como antes del
//     cambio (ver instagramApify.js).
// El ANÁLISIS de una publicación (comentarios, src/apify.js) no pasa por
// acá: sigue siempre con apify/instagram-scraper, porque el otro actor no
// devuelve comentarios.
//
// Un valor desconocido aborta el arranque (server.js lo valida antes de
// cargar los módulos), igual que LLM_PROVIDER: un typo no puede caer en
// silencio a un actor que cobra distinto.
// ==========================================================================

const IG_ACTORS = ['apidojo', 'apify'];
const DEFAULT_IG_ACTOR = 'apidojo';

/**
 * @param {string} [raw] valor de IG_ACTOR (por defecto, el del entorno).
 * @returns {'apidojo'|'apify'}
 * @throws {Error} con userMessage si el valor no es válido.
 */
function resolveIgActor(raw = process.env.IG_ACTOR) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (value === '') return DEFAULT_IG_ACTOR;
  if (IG_ACTORS.includes(value)) return value;
  const e = new Error(
    `IG_ACTOR="${raw}" no es válido. Valores posibles: ${IG_ACTORS.map((v) => `"${v}"`).join(' o ')} ` +
      `(vacío = "${DEFAULT_IG_ACTOR}"). Revisá el archivo .env.`
  );
  e.userMessage = e.message;
  throw e;
}

module.exports = { IG_ACTORS, DEFAULT_IG_ACTOR, resolveIgActor };
