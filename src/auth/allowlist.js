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

// La última lectura buena de cada archivo. Un error de lectura que no sea
// "no existe" (EBUSY o EPERM en Windows: un antivirus, un editor) no quiere
// decir que el archivo quedó vacío: vale lo último que se leyó bien, así un
// fallo pasajero no le saca el acceso a nadie (revisión de noviembre 2026).
const ultimaBuena = new Map();
const avisosLectura = new Set();

// { entries, ok }: ok es false si el archivo existe y no se pudo leer (entries
// es entonces la última lectura buena, o [] si nunca hubo una).
function readFileEntries(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      ultimaBuena.set(filePath, []);
      return { entries: [], ok: true };
    }
    if (!avisosLectura.has(filePath)) {
      avisosLectura.add(filePath);
      console.warn(`[allowlist] no se pudo leer allowed-emails.txt (${err.code || err.message}): vale la última lectura buena.`);
    }
    return { entries: ultimaBuena.get(filePath) || [], ok: false };
  }
  avisosLectura.delete(filePath);
  const entries = raw
    .split(/\r?\n/)
    .map((line) => parseEntry(line, 'allowed-emails.txt'))
    .filter(Boolean);
  ultimaBuena.set(filePath, entries);
  return { entries, ok: true };
}

function entriesFromEnv() {
  return String(process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((part) => parseEntry(part, 'ALLOWED_EMAILS'))
    .filter(Boolean);
}

/**
 * Como getRole, y además `archivoLeido`: false si el archivo existe y esta
 * vez no se pudo leer (el rol sale entonces de la última lectura buena). El
 * gate no revoca nada con una lectura así.
 * @returns {{ role: string|null, archivoLeido: boolean }}
 */
function resolveRole(email, filePath = defaultFilePath()) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { role: null, archivoLeido: true };
  const { entries, ok } = readFileEntries(filePath);
  let role = null;
  for (const entry of [...entries, ...entriesFromEnv()]) {
    if (entry.email !== normalized) continue;
    if (!role || ROLE_RANK[entry.role] > ROLE_RANK[role]) role = entry.role;
  }
  return { role, archivoLeido: ok };
}

/**
 * El rol del correo según el archivo y el env: 'lector' | 'operador', o null
 * si no está habilitado. Lee el archivo en cada llamada.
 */
function getRole(email, filePath = defaultFilePath()) {
  return resolveRole(email, filePath).role;
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
  resolveRole,
  defaultFilePath,
};
