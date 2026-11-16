// ==========================================================================
// gate.js
// --------------------------------------------------------------------------
// Corre ANTES de express.static. Páginas de la app y /api/* piden sesión;
// login, css, logo, favicon y las rutas de auth públicas pasan.
//
// Lo PÚBLICO se reconoce por el camino exacto, tal como llegó escrito. Lo
// PROTEGIDO, por el camino como lo van a entender los que vienen después
// del gate, que no siempre es como llegó escrito:
//   - las rutas de Express no distinguen mayúsculas: /API/monitoring/posts
//     llega al mismo handler que /api/monitoring/posts;
//   - express.static decodifica el camino (%2e, %5c...) y, en Windows, el
//     disco tampoco distingue mayúsculas, ignora los puntos y espacios del
//     final del nombre y acepta formas como "dashboard.html::$DATA" o el
//     nombre corto "DASHBO~1.HTM".
// Por eso la decisión se toma sobre canonicalPath: el camino decodificado,
// en minúsculas, con "\" como "/" y las barras repetidas como una sola.
// Comparar el camino crudo con startsWith('/api/') dejaba pasar /API/... sin
// sesión hasta el handler (octubre 2026). Test: test/authGate.test.js.
//
// Roles (noviembre 2026): con sesión, el rol sale de la allowlist en cada
// pedido (req.auth.role); un correo que ya no está pierde la sesión. En
// /api/, todo lo que no sea GET, HEAD u OPTIONS exige `operador`, salvo
// /api/auth/*: 403 { error: 'No tenés permiso para esta acción.' }. Tests:
// test/requireRole.test.js y test/session.test.js.
// ==========================================================================

const { readSession, clearSessionCookie, sessionIdFromRequest, revokeSessionsForEmail } = require('./session');
const { hasRole, FORBIDDEN_BODY } = require('./requireRole');

// Roles (noviembre 2026): en /api/, todo método que no sea uno de estos
// exige `operador`, salvo /api/auth/* (un lector tiene que poder salir).
// La decisión va sobre canonicalPath, como el resto: /API/... no la saltea.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Públicos: solo estas formas exactas. Los demás archivos estáticos que no
// son páginas (css, íconos, js) pasan más abajo, sin sesión, como siempre.
const PUBLIC_EXACT = new Set([
  '/',
  '/index.html',
  '/login-verify.html',
  '/logo.png',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/js/login.js',
]);

// /api/public/resumen: los números del login (src/publicResumen.js), solo
// cantidades y nombres de tema. Exacta, como las demás: NUNCA un prefijo
// "/api/public/", que dejaría pasar cualquier ruta futura.
const PUBLIC_API = new Set([
  'POST /api/auth/magic-link',
  'POST /api/auth/verify',
  'GET /api/auth/me',
  'POST /api/auth/logout',
  'GET /api/public/resumen',
]);

/**
 * El camino como lo van a entender Express y el disco: decodificado, en
 * minúsculas, con "\" como "/" y sin barras repetidas.
 * @returns {string|null} null si viene mal codificado.
 */
function canonicalPath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPath || ''));
  } catch (err) {
    return null;
  }
  return decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function isApiPath(canonical) {
  return canonical === '/api' || canonical.startsWith('/api/');
}

// /api/auth/*, la única excepción de la regla de roles. Un camino con "." o
// ".." no cuenta (canonicalPath no los resuelve): /api/auth/../monitoring/x
// no es de auth.
function isAuthApiPath(canonical) {
  if (!canonical.startsWith('/api/auth/')) return false;
  return !canonical.split('/').some((parte) => parte === '.' || parte === '..');
}

// Una página: cualquier camino que nombre un .html, esté donde esté la
// extensión dentro del camino (".htm" cubre también el nombre corto de
// Windows y lo que venga pegado después: ".html.", ".html::$DATA", ".html/").
function isPagePath(canonical) {
  return canonical.includes('.htm');
}

function createAuthGate() {
  return function authGate(req, res, next) {
    const urlPath = req.path;
    // readSession ya descarta las revocadas, inactivas y vencidas, y trae el
    // rol de la allowlist, que se lee en cada pedido: sacar un correo del
    // archivo le corta el acceso ya, sin esperar a que venza la sesión.
    let session = readSession(req);
    let cookieLimpia = false;
    if (session && !session.role) {
      const revocadas = revokeSessionsForEmail(session.email);
      console.log(`[auth] sesión revocada: el correo ya no está en la allowlist (${revocadas} sesión/es)`);
      clearSessionCookie(res);
      cookieLimpia = true;
      session = null;
    }
    if (session) req.auth = session;
    // Una cookie que ya no es una sesión (vencida, revocada) se borra cuando
    // el pedido termina en el login o en un 401.
    const limpiarCookieVieja = () => {
      if (!session && !cookieLimpia && sessionIdFromRequest(req)) clearSessionCookie(res);
    };

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html') && session) {
      return res.redirect('/dashboard.html');
    }

    if (PUBLIC_EXACT.has(urlPath)) return next();
    if (PUBLIC_API.has(`${req.method} ${urlPath}`)) return next();

    const canonical = canonicalPath(urlPath);
    if (canonical === null) return res.status(400).json({ error: 'Dirección inválida.' });

    if (isApiPath(canonical)) {
      if (!session) {
        limpiarCookieVieja();
        return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
      }
      if (!SAFE_METHODS.has(req.method) && !isAuthApiPath(canonical) && !hasRole(session.role, 'operador')) {
        return res.status(403).json(FORBIDDEN_BODY);
      }
      return next();
    }

    if (isPagePath(canonical)) {
      if (!session) {
        limpiarCookieVieja();
        return res.redirect('/');
      }
      return next();
    }

    return next();
  };
}

module.exports = { createAuthGate, canonicalPath };
