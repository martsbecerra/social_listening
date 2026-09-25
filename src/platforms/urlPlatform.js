// ==========================================================================
// platforms/urlPlatform.js — ¿De qué red es esta url?
// --------------------------------------------------------------------------
// Un solo lugar para decidir, por el dominio, a qué plataforma pertenece un
// link. Lo usan el guard de db.saveDetectedPost (una publicación de X nunca
// se guarda etiquetada como Instagram, ni al revés), el análisis de
// publicación (server.js) y el registro de adapters (platforms/index.js).
//
// Sin dependencias a propósito: db.js lo requiere, y db.js no puede requerir
// el registro de adapters (platforms/index.js → instagram.js → apify.js →
// apifyCost.js → db.js sería circular).
//
// Un dominio desconocido devuelve null: no es "Instagram por defecto". Una
// plataforma nueva se suma acá con sus dominios.
// ==========================================================================

const HOSTS = {
  instagram: ['instagram.com'],
  x: ['x.com', 'twitter.com'],
};

/** @returns {string|null} hostname en minúsculas, o null si no es una url. */
function hostnameOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {unknown} url
 * @returns {'instagram'|'x'|null} la plataforma del dominio (subdominios
 *   incluidos: www., mobile., …), o null si no es una url o el dominio no
 *   es de ninguna red conocida.
 */
function platformForUrl(url) {
  const host = hostnameOf(url);
  if (!host) return null;
  for (const [id, domains] of Object.entries(HOSTS)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return id;
  }
  return null;
}

// --------------------------------------------------------------------------
// Guard del análisis de publicación (POST /api/analyze, POST /api/x/analyze).
// --------------------------------------------------------------------------
const LABEL = { instagram: 'Instagram', x: 'X' };
const EJEMPLO = { instagram: 'https://www.instagram.com/p/XXXXXXXX/', x: 'https://x.com/usuario/status/1234567890' };
// Qué path es "una publicación" en cada red. Instagram: post, reel o tv. X:
// el mismo criterio que src/x/url.js (parseXPostUrl), sin depender de él.
const POST_PATH = {
  instagram: /^\/(p|reel|reels|tv)\/[\w-]+/,
  x: /^\/([A-Za-z0-9_]+\/status\/\d+|i\/web\/status\/\d+)/i,
};

/** ¿La url es una publicación (no un perfil, story, etc.) de esa red? */
function isPostUrlOf(url, plataforma) {
  if (platformForUrl(url) !== plataforma) return false;
  try {
    return Boolean(POST_PATH[plataforma] && POST_PATH[plataforma].test(new URL(url.trim()).pathname));
  } catch {
    return false;
  }
}

/**
 * ¿Este link se puede analizar en la solapa `plataforma`? Se corre ANTES de
 * pedirle nada a Apify/Grok. Tres respuestas:
 *   - ok: true
 *   - no_es_url: el texto no es una url → mensaje de formato.
 *   - otra_red: es una url pero de otro dominio → "Esta sección solo analiza
 *     publicaciones de <red>", con el consejo de la otra solapa si el link
 *     es de una red conocida.
 *   - no_es_posteo: es de la red pero no es una publicación (perfil, story)
 *     → mensaje de formato con un ejemplo.
 * @param {unknown} url
 * @param {'instagram'|'x'} plataforma solapa desde la que se analiza
 * @returns {{ ok: true } | { ok: false, motivo: 'no_es_url'|'otra_red'|'no_es_posteo', error: string }}
 */
function checkAnalyzeUrl(url, plataforma) {
  const label = LABEL[plataforma];
  if (!label) throw new Error(`checkAnalyzeUrl: plataforma desconocida "${plataforma}"`);
  const formato = `Ingresá un link válido de una publicación de ${label} (por ejemplo: ${EJEMPLO[plataforma]}).`;
  if (!hostnameOf(url)) return { ok: false, motivo: 'no_es_url', error: formato };
  const red = platformForUrl(url);
  if (red !== plataforma) {
    const otraSolapa = red && LABEL[red] ? ` Usá la solapa de ${LABEL[red]}.` : '';
    return { ok: false, motivo: 'otra_red', error: `Esta sección solo analiza publicaciones de ${label}.${otraSolapa}` };
  }
  if (!isPostUrlOf(url, plataforma)) return { ok: false, motivo: 'no_es_posteo', error: formato };
  return { ok: true };
}

module.exports = { platformForUrl, hostnameOf, HOSTS, isPostUrlOf, checkAnalyzeUrl };
