// ==========================================================================
// platforms/instagram.js — Adapter de Instagram para el monitoreo.
// --------------------------------------------------------------------------
// Fachada: el resto de la app (monitor, accountStats, metricsRefresh, db,
// server, frontend) ve el contrato de platforms/index.js y no sabe qué
// actor de Apify hay abajo. Hay dos proveedores con la misma interfaz y la
// misma forma normalizada de posteo, elegidos por IG_ACTOR (ver igActor.js):
//   - instagramApidojo.js (default): apidojo/instagram-scraper-api. Cobra
//     por consulta, trae seguidores en cada posteo y busca por palabra
//     clave (scrapeSearch).
//   - instagramApify.js: apify/instagram-scraper, el de siempre. Cobra por
//     resultado, seguidores por consulta aparte, sin búsqueda.
// La dependencia va en un solo sentido: monitor.js importa este módulo,
// nunca al revés. Apify es un detalle interno: el orquestador solo ve
// capabilities, isConfigured() y errores con `code`.
//
// Los métodos se delegan en el momento de la llamada (no se copian las
// funciones) y son propiedades normales del objeto exportado, así los tests
// pueden stubear instagram.scrapeAccount & co. como siempre. scrapeSearch se
// expone solo si el proveedor sabe buscar: el orquestador decide por
// `typeof platform.scrapeSearch === 'function'`, no por el nombre del actor.
// ==========================================================================

const { resolveIgActor } = require('./igActor');

const PLATFORM_ID = 'instagram';

const PROVIDERS = {
  apidojo: require('./instagramApidojo'),
  apify: require('./instagramApify'),
};

// Se resuelve al cargar el módulo (como el resto de la configuración por
// entorno). Un valor inválido tira acá; server.js lo valida antes con un
// mensaje claro.
const PROVIDER_ID = resolveIgActor();
const provider = PROVIDERS[PROVIDER_ID];

function isConfigured() {
  return Boolean((process.env.APIFY_API_TOKEN || '').trim());
}

const adapter = {
  id: PLATFORM_ID,
  label: 'Instagram',
  // Metadata propia de este adapter, no parte del contrato genérico.
  provider: PROVIDER_ID,
  actorId: provider.ACTOR_ID,
  /**
   * Qué sabe hacer esta plataforma además de detectar posteos (ver
   * platforms/index.js). Instagram tiene todo: benchmark por cuenta
   * (mediana de likes/comentarios), seguidores y refresco de métricas de
   * posteos ya guardados. Es igual con los dos proveedores.
   */
  capabilities: { benchmark: true, followers: true, metricsRefresh: true },
  isConfigured,
  validateAccount: (account) => provider.validateAccount(account),
  validateHashtag: (tag) => provider.validateHashtag(tag),
  scrapeAccount: (username, options) => provider.scrapeAccount(username, options),
  scrapeHashtag: (tag, options) => provider.scrapeHashtag(tag, options),
  normalizePost: (raw, context) => provider.normalizePost(raw, context),
  buildProfileUrl: (username) => provider.buildProfileUrl(username),
  fetchAccountFollowers: (username) => provider.fetchAccountFollowers(username),
  /**
   * Qué métricas expone esta plataforma, para que el frontend arme las
   * columnas leyendo de acá en vez de hardcodearlas, y para que el
   * orquestador sepa qué campos guardar y refrescar. `label` es el nombre
   * que se muestra en la UI; `primary` marca LA métrica a destacar de la
   * plataforma (en Instagram son los likes; en TikTok va a ser playCount).
   */
  metrics: [
    { key: 'likes', label: 'Likes', primary: true },
    { key: 'comments', label: 'Coment.', primary: false },
  ],
};

if (typeof provider.scrapeSearch === 'function') {
  adapter.scrapeSearch = (term, options) => provider.scrapeSearch(term, options);
}

module.exports = adapter;
