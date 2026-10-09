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
// ==========================================================================

const { readSession } = require('./session');

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

const PUBLIC_API = new Set([
  'POST /api/auth/magic-link',
  'POST /api/auth/verify',
  'GET /api/auth/me',
  'POST /api/auth/logout',
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

// Una página: cualquier camino que nombre un .html, esté donde esté la
// extensión dentro del camino (".htm" cubre también el nombre corto de
// Windows y lo que venga pegado después: ".html.", ".html::$DATA", ".html/").
function isPagePath(canonical) {
  return canonical.includes('.htm');
}

function createAuthGate() {
  return function authGate(req, res, next) {
    const urlPath = req.path;
    const session = readSession(req);
    if (session) req.auth = session;

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html') && session) {
      return res.redirect('/dashboard.html');
    }

    if (PUBLIC_EXACT.has(urlPath)) return next();
    if (PUBLIC_API.has(`${req.method} ${urlPath}`)) return next();

    const canonical = canonicalPath(urlPath);
    if (canonical === null) return res.status(400).json({ error: 'Dirección inválida.' });

    if (isApiPath(canonical)) {
      if (!session) {
        return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
      }
      return next();
    }

    if (isPagePath(canonical)) {
      if (!session) return res.redirect('/');
      return next();
    }

    return next();
  };
}

module.exports = { createAuthGate, canonicalPath };
