// ==========================================================================
// httpSecurity.js
// --------------------------------------------------------------------------
// Seguridad HTTP de la app (noviembre 2026, rama hardening-http):
//   - securityHeaders(): helmet con una CSP explícita. Va PRIMERO en
//     server.js, antes del gate: también llevan los headers los 401 y las
//     redirecciones al login.
//   - errorHandler: el último middleware de server.js. Al cliente nunca le
//     llega un stack ni un mensaje interno; el error completo va al log.
//   - installProcessHandlers(): una promesa rechazada o una excepción sin
//     manejar se loguea y el proceso termina con 1 (Railway, o
//     scripts/iniciar-con-reinicio.bat, lo levanta de nuevo). Node 22 ya
//     terminaba en los dos casos; lo que cambia es que queda el log.
// Sin dependencias de la base: los tests lo cargan solo.
// ==========================================================================

const helmet = require('helmet');

// Lo único de afuera que carga la página. Tabulator y Leaflet van en
// public/vendor (nunca desde un CDN), así que el script es solo 'self'.
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';
// Las fotos de los posteos y de los análisis se sirven desde la app
// (src/postImageRoutes.js, /api/analisis/:id/image): el link original de
// Instagram nunca llega al navegador. Las únicas imágenes de afuera son los
// mosaicos del mapa (public/js/claimsMap.js): Google (mt0 a mt3) y, de
// respaldo, OpenStreetMap (a, b, c).
const MAP_TILE_HOSTS = [
  'https://mt0.google.com',
  'https://mt1.google.com',
  'https://mt2.google.com',
  'https://mt3.google.com',
  'https://*.tile.openstreetmap.org',
];

// HSTS dura 180 días y no se extiende a los subdominios (el dominio puede
// ser compartido, como *.up.railway.app).
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

function isHttpsBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().toLowerCase().startsWith('https://');
}

function cspDirectives({ https }) {
  const directives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    // Ni onclick="…" ni javascript: en el HTML.
    scriptSrcAttr: ["'none'"],
    // Sin 'unsafe-inline': un style="…" en el HTML no se aplica (los estilos
    // van en public/css/styles.css). Lo que el JS pone por element.style sí.
    styleSrc: ["'self'", GOOGLE_FONTS_CSS],
    fontSrc: ["'self'", GOOGLE_FONTS_FILES],
    // data: por los íconos SVG en línea de styles.css.
    imgSrc: ["'self'", 'data:', ...MAP_TILE_HOSTS],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  };
  // Solo detrás de https: en http://localhost subiría los pedidos a https.
  if (https) directives.upgradeInsecureRequests = [];
  return directives;
}

/**
 * Middleware de helmet con la CSP de la app. HSTS y upgrade-insecure-requests
 * solo si APP_BASE_URL es https.
 */
function securityHeaders({ baseUrl = process.env.APP_BASE_URL } = {}) {
  const https = isHttpsBaseUrl(baseUrl);
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: cspDirectives({ https }) },
    strictTransportSecurity: https ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: false } : false,
    // No el no-referrer de helmet: los mosaicos de OpenStreetMap rechazan
    // pedidos sin Referer. Afuera va solo el origen, nunca el camino.
    // login-verify.html pone su propio no-referrer (lleva el token).
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' },
  });
}

function httpStatusOf(err) {
  const status = Number(err && (err.status || err.statusCode));
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

/**
 * Manejador de errores de Express (el último app.use de server.js). Un 4xx
 * que arma Express (JSON mal formado, cuerpo demasiado grande) conserva su
 * status; todo lo demás es 500. El cliente recibe solo el mensaje genérico.
 * Al log: el 5xx con su stack; el 4xx, una línea (sin el cuerpo del pedido,
 * que body-parser adjunta al error y puede traer un token).
 */
function errorHandler(err, req, res, next) {
  const status = httpStatusOf(err);
  const where = `${req.method} ${req.path}`;
  if (status >= 500) {
    console.error(`[http] error ${status} en ${where}:`, err);
  } else {
    console.warn(`[http] pedido rechazado ${status} en ${where}: ${(err && (err.type || err.code)) || 'sin tipo'}`);
  }
  if (res.headersSent) return next(err);
  return res.status(status).json({ error: status >= 500 ? 'Error interno.' : 'Pedido inválido.' });
}

/**
 * unhandledRejection y uncaughtException: log y exit(1). Lo llama solo
 * server.js; los tests pasan su propio proceso y su propio exit.
 */
function installProcessHandlers({ proc = process, exit = (code) => process.exit(code), log = console.error } = {}) {
  proc.on('unhandledRejection', (reason) => {
    log('[proceso] promesa rechazada sin manejar; el proceso termina:', reason);
    exit(1);
  });
  proc.on('uncaughtException', (err) => {
    log('[proceso] excepción sin manejar; el proceso termina:', err);
    exit(1);
  });
}

module.exports = {
  securityHeaders,
  errorHandler,
  installProcessHandlers,
  cspDirectives,
  isHttpsBaseUrl,
  MAP_TILE_HOSTS,
};
