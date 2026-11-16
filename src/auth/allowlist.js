// ==========================================================================
// allowlist.js
// --------------------------------------------------------------------------
// Quién puede entrar y con qué rol. Unión de:
//   1) config/allowed-emails.txt (se recarga en cada chequeo: sacar a alguien
//      del archivo le corta el acceso en el próximo pedido, ver gate.js)
//   2) ALLOWED_EMAILS en el env (separados por coma)
// Cada entrada es `email` o `email;rol`. Roles (ROLES): `lector` (ve todo,
// no gasta ni escribe) y `operador` (todo). Sin rol, `lector`; un rol que no
// existe también vale `lector`, con un aviso en el log (una vez por proceso).
// Si un correo aparece más de una vez con roles distintos, gana el más alto.
// ==========================================================================

const fs = require('fs');
const path = require('path');

// De menor a mayor permiso. requireRole y el gate comparan por este orden.
const ROLES = Object.freeze(['lector', 'operador']);
const ROLE_RANK = Object.freeze({ lector: 1, operador: 2 });
const DEFAULT_ROLE = 'lector';

// Avisos de rol desconocido ya dados: el archivo se relee en cada pedido y
// sin esto el mismo aviso saldría en cada uno.
const avisados = new Set();

function defaultFilePath() {
  return path.join(__dirname, '..', '..', 'config', 'allowed-emails.txt');
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// "ana@x.gob.ar;operador" → { email, role }. null si no hay correo.
function parseEntry(raw, origen) {
  const sinComentario = String(raw || '').replace(/#.*$/, '').trim();
  if (!sinComentario) return null;
  const sep = sinComentario.indexOf(';');
  const email = normalizeEmail(sep === -1 ? sinComentario : sinComentario.slice(0, sep));
  if (!email) return null;
  const rolEscrito = sep === -1 ? '' : sinComentario.slice(sep + 1).trim().toLowerCase();
  if (!rolEscrito) return { email, role: DEFAULT_ROLE };
  if (Object.hasOwn(ROLE_RANK, rolEscrito)) return { email, role: rolEscrito };
  const clave = `${origen}|${email}|${rolEscrito}`;
  if (!avisados.has(clave)) {
    avisados.add(clave);
    console.warn(`[allowlist] rol desconocido "${rolEscrito}" para ${email} (${origen}): vale "${DEFAULT_ROLE}". Roles: ${ROLES.join(', ')}.`);
  }
  return { email, role: DEFAULT_ROLE };
}

function entriesFromFile(filePath) {
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
    .map((line) => parseEntry(line, 'allowed-emails.txt'))
    .filter(Boolean);
}

function entriesFromEnv() {
  return String(process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((part) => parseEntry(part, 'ALLOWED_EMAILS'))
    .filter(Boolean);
}

/**
 * El rol del correo según el archivo y el env: 'lector' | 'operador', o null
 * si no está habilitado. Lee el archivo en cada llamada.
 */
function getRole(email, filePath = defaultFilePath()) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  let role = null;
  for (const entry of [...entriesFromFile(filePath), ...entriesFromEnv()]) {
    if (entry.email !== normalized) continue;
    if (!role || ROLE_RANK[entry.role] > ROLE_RANK[role]) role = entry.role;
  }
  return role;
}

function isEmailAllowed(email, filePath = defaultFilePath()) {
  return getRole(email, filePath) !== null;
}

module.exports = {
  ROLES,
  ROLE_RANK,
  DEFAULT_ROLE,
  normalizeEmail,
  isEmailAllowed,
  getRole,
  defaultFilePath,
};
