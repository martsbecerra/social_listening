// ==========================================================================
// magicLink.js
// --------------------------------------------------------------------------
// Emite y canjea tokens de un solo uso. El valor crudo va por mail; en SQLite
// solo queda el SHA-256. TTL 15 minutos.
// ==========================================================================

const crypto = require('crypto');
const db = require('../db');
const { isEmailAllowed } = require('./allowlist');

const TTL_MS = 15 * 60 * 1000;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function issueMagicLink(email) {
  // Un link nuevo invalida el anterior: si quedara más de un token válido por
  // casilla, el usuario podría clickear el viejo pensando que es el último.
  db.deleteUnusedMagicLinks(email);

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  db.insertMagicLink({
    tokenHash: hashToken(rawToken),
    email,
    expiresAt,
  });
  return { rawToken };
}

function redeemMagicLink(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return { ok: false };
  const trimmed = rawToken.trim();
  if (!trimmed) return { ok: false };

  const claimed = db.claimMagicLink(hashToken(trimmed), new Date().toISOString());
  if (!claimed) return { ok: false };
  if (!isEmailAllowed(claimed.email)) return { ok: false };
  return { ok: true, email: claimed.email };
}

module.exports = { issueMagicLink, redeemMagicLink };
