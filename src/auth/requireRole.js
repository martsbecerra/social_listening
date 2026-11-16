// ==========================================================================
// requireRole.js
// --------------------------------------------------------------------------
// Permisos por rol (los roles y su orden, en allowlist.js).
//
// La regla general vive en el gate (gate.js): todo pedido a /api/ que no sea
// GET, HEAD u OPTIONS exige `operador`, salvo /api/auth/*. Así una ruta nueva
// que escriba o gaste queda cubierta sola. requireRole(rol) es para los casos
// explícitos que la regla no ve (un GET que gastara o escribiera): va en la
// ruta, después del gate. Hoy ningún GET lo necesita (revisado en
// noviembre 2026, rama roles-y-sesion).
// ==========================================================================

const { ROLE_RANK } = require('./allowlist');

const FORBIDDEN_BODY = Object.freeze({ error: 'No tenés permiso para esta acción.' });
const UNAUTHENTICATED_BODY = Object.freeze({ error: 'Tenés que iniciar sesión.' });

/** ¿El rol `actual` alcanza para `requerido`? Un rol desconocido no alcanza. */
function hasRole(actual, requerido) {
  if (!Object.hasOwn(ROLE_RANK, requerido)) return false;
  if (!Object.hasOwn(ROLE_RANK, String(actual))) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[requerido];
}

function requireRole(requerido) {
  if (!Object.hasOwn(ROLE_RANK, requerido)) {
    throw new Error(`requireRole: rol desconocido "${requerido}"`);
  }
  return function requireRoleMiddleware(req, res, next) {
    if (!req.auth) return res.status(401).json(UNAUTHENTICATED_BODY);
    if (!hasRole(req.auth.role, requerido)) return res.status(403).json(FORBIDDEN_BODY);
    return next();
  };
}

module.exports = { requireRole, hasRole, FORBIDDEN_BODY, UNAUTHENTICATED_BODY };
