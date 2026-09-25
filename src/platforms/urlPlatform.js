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

module.exports = { platformForUrl, hostnameOf, HOSTS };
