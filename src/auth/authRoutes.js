// ==========================================================================
// authRoutes.js
// --------------------------------------------------------------------------
// Las rutas de /api/auth/* (antes en server.js; aparte desde noviembre 2026
// para probarlas con la sesión real en test/session.test.js):
//   POST /api/auth/magic-link  pide el link (allowlist + rate limit + mail)
//   POST /api/auth/verify      canjea el token: SIEMPRE una sesión nueva, y
//                              la que traiga la cookie se revoca
//   GET  /api/auth/me          { email, role }
//   POST /api/auth/logout      revoca la sesión y borra la cookie
// Las cuatro pasan el gate como públicas (PUBLIC_API, escritas exactas) y
// quedan fuera de la regla de roles: un lector tiene que poder salir. Solo
// reciben JSON (server.js no monta express.urlencoded).
// ==========================================================================

const { normalizeEmail, isEmailAllowed } = require('./allowlist');
const { issueMagicLink, redeemMagicLink } = require('./magicLink');
const { setSessionCookie, clearSessionCookie, revokeRequestSession, isAuthConfigured } = require('./session');
const { isMagicLinkRateLimited, isResendBlocked, markMagicLinkSent, RESEND_COOLDOWN_MS } = require('./rateLimit');
const { rutaAsync } = require('../asyncRoute');

// La respuesta es SIEMPRE esta, pase lo que pase (email no autorizado,
// cooldown de reenvío, envío OK): no revela qué direcciones existen.
// retryAfterSeconds alimenta la cuenta regresiva del frontend y es idéntico
// en toda respuesta, así el "2 minutos" vive en una sola constante.
const MAGIC_LINK_GENERIC = Object.freeze({
  ok: true,
  message: 'Si el email está autorizado, te mandamos un link. Revisá tu casilla.',
  retryAfterSeconds: RESEND_COOLDOWN_MS / 1000,
});

function logAuth(phase, detail = {}) {
  const payload = Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[auth] ${phase}${payload}`);
}

/**
 * @param {import('express').Express} app
 * @param {{ sendMagicLinkEmail?: Function }} [deps] el envío del mail (los
 *   tests pasan uno de mentira; por defecto, src/mailer.js).
 */
function register(app, deps = {}) {
  const sendMagicLinkEmail = deps.sendMagicLinkEmail || ((...args) => require('../mailer').sendMagicLinkEmail(...args));

  app.post('/api/auth/magic-link', rutaAsync(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    logAuth('pedido de magic link', { email: email || null });

    if (isMagicLinkRateLimited({ ip, email })) {
      logAuth('rate limit', { email: email || null });
      return res.status(429).json({ error: 'Demasiados intentos. Probá en unos minutos.' });
    }

    // Las variables que faltan, solo en el log: al cliente, el genérico.
    if (!isAuthConfigured()) {
      logAuth('config incompleta', { falta: 'APP_BASE_URL' });
      return res.status(503).json({ error: 'Falta configuración del servidor.' });
    }

    if (!email || !isEmailAllowed(email)) {
      logAuth('email no autorizado o vacío', { email: email || null });
      return res.json(MAGIC_LINK_GENERIC);
    }

    // Cooldown de reenvío (un link cada 2 min por email): se responde el mismo
    // genérico y NO se manda nada — deshabilitar el botón en el frontend no
    // alcanza, porque recargando la página se saltea.
    if (isResendBlocked(email)) {
      logAuth('cooldown de reenvío activo', { email });
      return res.json(MAGIC_LINK_GENERIC);
    }

    try {
      const { rawToken } = issueMagicLink(email);
      logAuth('enviando mail', { email, smtp: process.env.SMTP_HOST || null });
      await sendMagicLinkEmail({ email, rawToken });
      markMagicLinkSent(email);
      logAuth('mail enviado', { email });
    } catch (err) {
      logAuth('error enviando mail', { email, message: err.message });
      console.error('[auth] Error enviando magic link:', err.message);
    }

    return res.json(MAGIC_LINK_GENERIC);
  }));

  app.post('/api/auth/verify', (req, res) => {
    const token = (req.body && typeof req.body.token === 'string' && req.body.token) || '';
    const result = redeemMagicLink(token);
    if (!result.ok) {
      logAuth('verify fallido', { motivo: 'token inválido, usado o expirado' });
      return res
        .status(400)
        .type('html')
        .send(
          '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Link inválido</title></head><body>' +
            '<p>El link expiró o ya fue usado. <a href="/">Pedí uno nuevo</a>.</p></body></html>'
        );
    }
    // Siempre una sesión nueva; la que traiga la cookie, si había, se revoca:
    // nadie hereda un id anterior al login.
    revokeRequestSession(req);
    setSessionCookie(res, result.email);
    logAuth('sesión iniciada', { email: result.email });
    return res.redirect(302, '/dashboard.html');
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
    }
    // El rol (lector | operador) lo usa el frontend para mostrar o no los
    // controles que gastan o escriben (public/js/sesion.js); quien decide es
    // el gate.
    return res.json({ email: req.auth.email, role: req.auth.role });
  });

  app.post('/api/auth/logout', (req, res) => {
    logAuth('logout', { email: req.auth ? req.auth.email : null });
    // Se revoca en la base: la cookie copiada a otro lado tampoco sirve más.
    revokeRequestSession(req);
    clearSessionCookie(res);
    return res.status(204).end();
  });
}

module.exports = { register, MAGIC_LINK_GENERIC };
