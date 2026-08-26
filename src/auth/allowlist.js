// ==========================================================================
// allowlist.js
// --------------------------------------------------------------------------
// Quién puede pedir un magic link. Unión de:
//   1) config/allowed-emails.txt (se recarga en cada chequeo)
//   2) ALLOWED_EMAILS en el env (separados por coma)
// ==========================================================================

const fs = require('fs');
const path = require('path');

function defaultFilePath() {
  return path.join(__dirname, '..', '..', 'config', 'allowed-emails.txt');
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function emailsFromFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn('No se pudo leer allowed-emails.txt:', err.message);
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => {
      const withoutComment = line.replace(/#.*$/, '').trim().toLowerCase();
      return withoutComment;
    })
    .filter(Boolean);
}

function emailsFromEnv() {
  const raw = process.env.ALLOWED_EMAILS || '';
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailAllowed(email, filePath = defaultFilePath()) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const allowed = new Set([...emailsFromFile(filePath), ...emailsFromEnv()]);
  return allowed.has(normalized);
}

module.exports = {
  normalizeEmail,
  isEmailAllowed,
  defaultFilePath,
};
