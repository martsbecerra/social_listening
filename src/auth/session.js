// ==========================================================================
// session.js
// --------------------------------------------------------------------------
// Sesión revocable en SQLite (noviembre 2026; antes, una cookie firmada con
// HMAC que valía 7 días y no se podía cortar).
//
// - La cookie sl_session lleva SOLO un id al azar de 32 bytes (base64url).
//   En la tabla sessions queda su SHA-256, como con los magic links: quien
//   lea la base no puede armar una cookie.
// - readSession(req) la busca y la rechaza si está revocada, si no tuvo
//   actividad en SESSION_IDLE_MIN (30) o si pasaron SESSION_MAX_HOURS (8)
//   desde el login. Válida, actualiza last_seen_at como mucho una vez por
//   minuto.
// - Un pedido con `X-SL-Auto: 1` (las consultas automáticas del frontend: la
//   barra superior, el inicio, el progreso) se valida igual pero NO renueva
//   last_seen_at: dejar la pestaña abierta no mantiene viva la sesión. El
//   header solo sirve para no renovar; vencida, la sesión da 401 igual.
// - Cookie httpOnly, sameSite strict, secure con APP_BASE_URL https, maxAge =
//   SESSION_MAX_HOURS.
// No es el token del mail: ese vive en magic_links y se usa una vez.
// Tests: test/session.test.js.
// ==========================================================================

const crypto = require('crypto');
const cookie = require('cookie');
const db = require('../db');
// Por el objeto del módulo (no desarmado): los tests lo stubean.
const allowlist = require('./allowlist');
const { resolveSessionConfig } = require('./sessionConfig');

const COOKIE_NAME = 'sl_session';
const AUTO_HEADER = 'x-sl-auto';
const TOUCH_EVERY_MS = 60 * 1000;
// 32 bytes en base64url, sin relleno: 43 caracteres.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

function hashSessionId(id) {
  return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex');
}

function isSecureCookie() {
  return (process.env.APP_BASE_URL || '').startsWith('https://');
}

function cookieOptions(maxAgeSec) {
  return {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSec,
  };
}

/** El id de la cookie, solo si tiene la forma de uno nuestro; si no, null. */
function sessionIdFromRequest(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const value = cookie.parse(header)[COOKIE_NAME];
  return value && SESSION_ID_RE.test(value) ? value : null;
}

function isAutoRequest(req) {
  return String((req.headers && req.headers[AUTO_HEADER]) || '').trim() === '1';
}

/**
 * Crea una sesión nueva para `email` y pone su cookie. Devuelve el
 * `sessionId` (el SHA-256 del id: el id en claro solo viaja en la cookie).
 */
function setSessionCookie(res, email, { now = Date.now() } = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  const idHash = hashSessionId(id);
  db.createSession({ idHash, email, createdAt: now });
  const { maxHours } = resolveSessionConfig();
  res.append('Set-Cookie', cookie.serialize(COOKIE_NAME, id, cookieOptions(maxHours * 60 * 60)));
  return idHash;
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', cookie.serialize(COOKIE_NAME, '', cookieOptions(0)));
}

/**
 * La sesión del pedido: { email, role, sessionId } o null (sin cookie, id
 * desconocido, revocada, inactiva o vencida). `role` sale de la allowlist y
 * es null si el correo ya no está: lo decide el gate. `sessionId` es el
 * SHA-256 del id.
 */
function readSession(req, { now = Date.now() } = {}) {
  const id = sessionIdFromRequest(req);
  if (!id) return null;
  const idHash = hashSessionId(id);
  const row = db.getSession(idHash);
  if (!row || row.revoked) return null;
  const { idleMs, maxMs } = resolveSessionConfig();
  if (now - row.lastSeenAt > idleMs) return null;
  if (now - row.createdAt > maxMs) return null;
  if (!isAutoRequest(req) && now - row.lastSeenAt >= TOUCH_EVERY_MS) db.touchSession(idHash, now);
  return { email: row.email, role: allowlist.getRole(row.email), sessionId: idHash };
}

/** Revoca la sesión de la cookie del pedido, si hay. */
function revokeRequestSession(req) {
  const id = sessionIdFromRequest(req);
  return id ? db.revokeSession(hashSessionId(id)) : false;
}

function revokeSessionsForEmail(email) {
  return db.revokeSessionsByEmail(email);
}

/** Borra de la tabla las revocadas y las vencidas; devuelve cuántas. */
function purgeExpiredSessions({ now = Date.now() } = {}) {
  const { idleMs, maxMs } = resolveSessionConfig();
  return db.purgeSessions({ idleBefore: now - idleMs, createdBefore: now - maxMs });
}

function isAuthConfigured() {
  return Boolean((process.env.APP_BASE_URL || '').trim());
}

module.exports = {
  COOKIE_NAME,
  AUTO_HEADER,
  TOUCH_EVERY_MS,
  hashSessionId,
  sessionIdFromRequest,
  isAutoRequest,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  revokeRequestSession,
  revokeSessionsForEmail,
  purgeExpiredSessions,
  isAuthConfigured,
};
