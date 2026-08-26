// ==========================================================================
// session.js
// --------------------------------------------------------------------------
// Cookie firmada sl_session = base64url(email|exp) + HMAC-SHA256.
// No es el token del mail: ese vive hasheado en SQLite y se usa una vez.
// ==========================================================================

const crypto = require('crypto');
const cookie = require('cookie');

const COOKIE_NAME = 'sl_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getSecret() {
  return process.env.SESSION_SECRET || '';
}

function isSecureCookie() {
  return (process.env.APP_BASE_URL || '').startsWith('https://');
}

function cookieOptions(maxAgeSec) {
  return {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  };
}

function sign(email, exp) {
  const payload = `${email}|${exp}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}

function verifyValue(value) {
  const secret = getSecret();
  if (!value || !secret) return null;
  const parts = String(value).split('.');
  if (parts.length !== 2) return null;

  let payload;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const sep = payload.lastIndexOf('|');
  if (sep < 1) return null;
  const email = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!email || !Number.isFinite(exp) || Date.now() > exp) return null;
  return { email };
}

function setSessionCookie(res, email) {
  const exp = Date.now() + TTL_MS;
  res.append('Set-Cookie', cookie.serialize(COOKIE_NAME, sign(email, exp), cookieOptions(Math.floor(TTL_MS / 1000))));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', cookie.serialize(COOKIE_NAME, '', cookieOptions(0)));
}

function readSession(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return verifyValue(parsed[COOKIE_NAME]);
}

function isAuthConfigured() {
  return Boolean(getSecret() && (process.env.APP_BASE_URL || '').trim());
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  isAuthConfigured,
};
