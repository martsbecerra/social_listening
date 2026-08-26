// ==========================================================================
// gate.js
// --------------------------------------------------------------------------
// Corre ANTES de express.static. Páginas de la app y /api/* piden sesión;
// login, css, logo y las rutas de auth públicas pasan.
// ==========================================================================

const { readSession } = require('./session');

const PUBLIC_EXACT = new Set([
  '/',
  '/index.html',
  '/login-verify.html',
  '/logo.png',
  '/favicon.ico',
]);

const PUBLIC_PREFIXES = ['/css/', '/icons/', '/js/login.js'];

const PUBLIC_API = new Set([
  'POST /api/auth/magic-link',
  'POST /api/auth/verify',
  'GET /api/auth/me',
  'POST /api/auth/logout',
]);

function isPublicPath(urlPath) {
  if (PUBLIC_EXACT.has(urlPath)) return true;
  if (urlPath === '/js/login.js') return true;
  return PUBLIC_PREFIXES.some((prefix) => urlPath.startsWith(prefix) && prefix.endsWith('/'));
}

function createAuthGate() {
  return function authGate(req, res, next) {
    const urlPath = req.path;
    const session = readSession(req);
    if (session) req.auth = session;

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html') && session) {
      return res.redirect('/dashboard.html');
    }

    if (isPublicPath(urlPath)) return next();

    const apiKey = `${req.method} ${urlPath}`;
    if (PUBLIC_API.has(apiKey)) return next();

    if (urlPath.startsWith('/api/')) {
      if (!session) {
        return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
      }
      return next();
    }

    if (urlPath.endsWith('.html')) {
      if (!session) return res.redirect('/');
      return next();
    }

    return next();
  };
}

module.exports = { createAuthGate };
