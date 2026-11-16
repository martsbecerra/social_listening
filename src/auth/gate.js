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
// pedido (req.auth.role); un correo que ya no está pierde la sesión (se
// confirma con una segunda lectura: CONFIRMAR_BAJA_MS). En
// /api/, todo lo que no sea GET, HEAD u OPTIONS exige `operador`, salvo
// /api/auth/*: 403 { error: 'No tenés permiso para esta acción.' }. Y esos
// métodos tienen que venir de una página de la app (mismoOrigen), también en
// /api/auth/*. Tests: test/requireRole.test.js y test/session.test.js.
// ==========================================================================

const { readSession, clearSessionCookie, sessionIdFromRequest, revokeSessionsForEmail } = require('./session');
const { hasRole, FORBIDDEN_BODY } = require('./requireRole');
// Por el objeto del módulo (no desarmado): los tests lo stubean.
const allowlist = require('./allowlist');

// Antes de revocar a un correo que "ya no está", la allowlist se vuelve a
// leer un rato después: un editor que guarda el archivo lo vacía y lo
// reescribe, y una lectura en ese instante lo ve vacío o cortado. Revocar es
// para siempre (revisión de noviembre 2026).
const CONFIRMAR_BAJA_MS = 300;
const SIN_VERIFICAR_BODY = Object.freeze({ error: 'No se pudo verificar el acceso. Probá de nuevo en unos segundos.' });
const OTRO_SITIO_BODY = Object.freeze({ error: 'Pedido rechazado: no salió de esta app.' });

// Las páginas a las que el login puede volver (?volver=). La cookie es
// sameSite strict: un link a /instagram.html#analisis-57 abierto desde Gmail
// o WhatsApp llega sin ella aunque haya sesión, y el gate lo manda al login.
// Con ?volver=, el login (public/js/login.js, con la misma lista) confirma
// la sesión con /api/auth/me y vuelve a esa página; el navegador conserva el
// # en las redirecciones. Solo estas: nunca un camino escrito por otro
// (revisión de noviembre 2026).
const PAGINAS_VOLVER = new Set(['/dashboard.html', '/instagram.html', '/x.html']);

function destinoVolver(req) {
  const volver = req.query ? req.query.volver : null;
  return typeof volver === 'string' && PAGINAS_VOLVER.has(volver) ? volver : null;
}

/**
 * ¿El pedido salió de una página de esta app? Para todo lo que no es GET,
 * HEAD u OPTIONS bajo /api (revisión de noviembre 2026): la cookie es
 * sameSite strict, pero eso no frena a otra página del MISMO sitio (otro
 * puerto de localhost, otro subdominio), y un formulario text/plain con
 * ?plataforma= en la URL llegaba a run-now, al backfill o a ignorar sin
 * cuerpo JSON. Sec-Fetch-Site manda (el navegador lo pone y una página no lo
 * puede cambiar): solo same-origin o none. Sin él, Origin tiene que ser el
 * del Host o el de APP_BASE_URL. Sin ninguno de los dos no hay navegador de
 * por medio (curl, los tests): pasa, y la sesión sigue siendo obligatoria.
 */
function mismoOrigen(req) {
  const sitio = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (sitio) return sitio === 'same-origin' || sitio === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (iframes con sandbox, algunas redirecciones) u otra cosa
  }
  if (url.host && url.host === String(req.headers.host || '').toLowerCase()) return true;
  try {
    return url.origin === new URL(process.env.APP_BASE_URL || '').origin;
  } catch {
    return false;
  }
}

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

// La decisión, con la sesión ya resuelta (null si no hay). cookieLimpia: el
// gate ya mandó a borrar la cookie.
function decidir(req, res, next, session, cookieLimpia) {
  const urlPath = req.path;
  // Escrituras de otra página (también /api/auth/*: un sitio ajeno no pide
  // links ni cierra sesiones). Va primero, con o sin sesión.
  if (!SAFE_METHODS.has(req.method)) {
    const canonicalEscritura = canonicalPath(urlPath);
    if (canonicalEscritura !== null && isApiPath(canonicalEscritura) && !mismoOrigen(req)) {
      return res.status(403).json(OTRO_SITIO_BODY);
    }
  }
  if (session) req.auth = session;
  // Una cookie que ya no es una sesión (vencida, revocada) se borra cuando
  // el pedido termina en el login o en un 401.
  const limpiarCookieVieja = () => {
    if (!session && !cookieLimpia && sessionIdFromRequest(req)) clearSessionCookie(res);
  };

  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html') && session) {
    return res.redirect(destinoVolver(req) || '/dashboard.html');
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
      return res.redirect(PAGINAS_VOLVER.has(canonical) ? `/?volver=${encodeURIComponent(canonical)}` : '/');
    }
    return next();
  }

  return next();
}

/**
 * @param {object} [opts]
 * @param {number} [opts.confirmarBajaMs] la espera antes de releer la
 *   allowlist para confirmar una baja (CONFIRMAR_BAJA_MS; los tests la achican).
 */
function createAuthGate({ confirmarBajaMs = CONFIRMAR_BAJA_MS } = {}) {
  return function authGate(req, res, next) {
    // readSession ya descarta las revocadas, inactivas y vencidas, y trae el
    // rol de la allowlist, que se lee en cada pedido: sacar un correo del
    // archivo le corta el acceso ya, sin esperar a que venza la sesión.
    const session = readSession(req);
    if (!session || session.role) return decidir(req, res, next, session, false);

    // Con sesión y sin rol: se confirma con otra lectura antes de revocar.
    setTimeout(() => {
      try {
        const { role, archivoLeido } = allowlist.resolveRole(session.email);
        if (role) return decidir(req, res, next, { ...session, role }, false);
        if (!archivoLeido) {
          // No se pudo leer el archivo y la última lectura buena no lo tiene
          // (o no hubo ninguna): sin confirmar no se revoca nada.
          console.warn('[auth] no se pudo leer la allowlist para confirmar una baja: no se revoca nada.');
          return res.status(503).json(SIN_VERIFICAR_BODY);
        }
        let revocadas = 0;
        try {
          revocadas = revokeSessionsForEmail(session.email);
        } catch (err) {
          console.error('[auth] no se pudieron revocar las sesiones:', err.message);
        }
        if (revocadas > 0) console.log(`[auth] sesión revocada: el correo ya no está en la allowlist (${revocadas} sesión/es)`);
        clearSessionCookie(res);
        return decidir(req, res, next, null, true);
      } catch (err) {
        return next(err);
      }
    }, confirmarBajaMs);
  };
}

module.exports = { createAuthGate, canonicalPath, CONFIRMAR_BAJA_MS };
