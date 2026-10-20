// ==========================================================================
// replicaGuard.js — Lo que reemplaza al login en una réplica.
// --------------------------------------------------------------------------
// En APP_MODE=replica, server.js monta esto en vez de src/auth/gate.js (ver
// openspec/changes/replicas-solo-lectura). En este orden:
//
//   1. Solo local. El server ya escucha en 127.0.0.1, pero una página de
//      afuera puede hacer que su dominio resuelva a 127.0.0.1 (DNS
//      rebinding) y leer los datos desde el navegador de la persona. Por eso
//      el Host tiene que ser localhost, 127.0.0.1 o [::1] con el puerto del
//      server; cualquier otro, 421.
//   2. Solo lectura. Todo lo que no sea GET/HEAD responde 403, sin llegar a
//      ningún handler: por método y no por ruta, así cubre lo que escribe o
//      gasta (análisis, "Actualizar ahora", ignorar, sentimiento, reclamos,
//      cuentas, búsquedas, login) y cualquier ruta que se agregue después.
//      Única excepción: LOCAL_ACTIONS, dos POST que no tocan los datos sino
//      la copia misma (buscar datos nuevos, guardar el token de lectura), y
//      solo con Origin de la app en esta máquina. Sin ese chequeo, cualquier
//      página abierta en el navegador podría mandarlos con un formulario.
//   3. Sin login. La página de login redirige al dashboard y las rutas que
//      leen req.auth ven una sesión fija.
// ==========================================================================

const READ_METHODS = new Set(['GET', 'HEAD']);
const LOCAL_ACTIONS = new Set(['/api/replica/refresh', '/api/replica/token']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOGIN_PAGES = new Set(['/', '/index.html', '/login-verify.html']);
const REPLICA_AUTH = Object.freeze({ email: 'copia.local' });
const READ_ONLY_MESSAGE = 'Esta copia es de solo lectura.';

function isLocalHost(hostHeader, port) {
  const host = String(hostHeader || '').trim().toLowerCase();
  const sep = host.lastIndexOf(':');
  if (sep <= 0 || host.endsWith(']')) return false;
  return LOCAL_HOSTNAMES.has(host.slice(0, sep)) && host.slice(sep + 1) === String(port);
}

function isLocalOrigin(originHeader, port) {
  const origin = String(originHeader || '').trim().toLowerCase();
  return origin.startsWith('http://') && isLocalHost(origin.slice('http://'.length), port);
}

function isLocalAction(req, port) {
  return req.method === 'POST' && LOCAL_ACTIONS.has(req.path) && isLocalOrigin(req.headers.origin, port);
}

/**
 * @param {{ getPort: () => number|string }} options el puerto en que escucha
 *   el server (función: en los tests se conoce recién al escuchar).
 */
function createReplicaGuard({ getPort }) {
  return function replicaGuard(req, res, next) {
    if (!isLocalHost(req.headers.host, getPort())) {
      return res.status(421).json({ error: 'Esta copia solo atiende desde esta misma máquina (localhost).' });
    }
    if (!READ_METHODS.has(req.method) && !isLocalAction(req, getPort())) {
      return res.status(403).json({ error: READ_ONLY_MESSAGE });
    }
    if (LOGIN_PAGES.has(req.path)) {
      return res.redirect('/dashboard.html');
    }
    req.auth = REPLICA_AUTH;
    return next();
  };
}

module.exports = { createReplicaGuard, READ_ONLY_MESSAGE };
