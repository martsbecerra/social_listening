// ==========================================================================
// figuras.js — Figuras públicas: rol y alineación de quien comenta.
// --------------------------------------------------------------------------
// La lista (tabla figuras_publicas, src/db.js) la mantiene el equipo. El
// análisis de publicación cruza a todos los que comentaron por su usuario y
// muestra el rol y la alineación de los que están. El modelo puede SUGERIR
// rol y alineación, pero solo para verificados que no están en la lista; la
// sugerencia queda con origen "sugerida" hasta que alguien la confirme y
// nunca pisa una fila del equipo.
//
// La alineación política (oficialismo / oposición) solo vale para figuras
// públicas con rol político o de prensa: a los vecinos comunes no se los
// etiqueta (para eso está la postura de cada comentario).
//
// Sin dependencias: lo usan db.js (validación al escribir), la síntesis
// (src/analyzeComments.js) y las rutas (src/figurasRoutes.js).
// ==========================================================================

/** Los roles, con el texto de la pantalla (sin género: "Legislador/a"). */
const ROLES = {
  legislador: 'Legislador/a',
  funcionario: 'Funcionario/a',
  partido: 'Partido',
  junta_comunal: 'Junta comunal',
  periodista: 'Periodista',
  medio: 'Medio',
  organizacion: 'Organización',
  creador: 'Creador/a de contenido',
};
const ROL_KEYS = Object.keys(ROLES);

/** Los roles que pueden llevar alineación política. */
const ROLES_CON_ALINEACION = new Set(['legislador', 'funcionario', 'partido', 'junta_comunal', 'periodista', 'medio']);

const ALINEACIONES = { oficialismo: 'oficialismo', oposicion: 'oposición' };
const ALINEACION_KEYS = Object.keys(ALINEACIONES);

const ORIGENES = ['equipo', 'sugerida'];

const MAX_NOMBRE = 120;
const MAX_NOTAS = 500;

function errorDeDatos(mensaje) {
  const e = new Error(mensaje);
  e.userMessage = mensaje;
  e.code = 'FIGURA_INVALIDA';
  return e;
}

/** "@Usuario.Uno" → "usuario.uno"; '' si no es un usuario de Instagram válido. */
function normalizeUsername(value) {
  const u = String(value == null ? '' : value)
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : '';
}

function textoOpcional(value, max, campo) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  if (!t) return null;
  if (t.length > max) throw errorDeDatos(`${campo} puede tener hasta ${max} caracteres.`);
  return t;
}

// Object.hasOwn: "constructor" o "__proto__" no son un rol ni una alineación.
const esRol = (k) => typeof k === 'string' && Object.hasOwn(ROLES, k);
const esAlineacion = (k) => typeof k === 'string' && Object.hasOwn(ALINEACIONES, k);

/**
 * Valida y normaliza una figura que carga el equipo. Tira con userMessage
 * si algo está mal: usuario inválido, rol que no existe, alineación que no
 * existe o puesta a un rol que no la lleva.
 * @param {{ username?: string, nombre?: string, rol?: string, alineacion?: string|null, notas?: string }} input
 * @param {{ actual?: object|null }} [opciones] actual: la fila de hoy, para un PATCH (los campos que no vienen quedan)
 * @returns {{ username: string, nombre: string|null, rol: string, alineacion: string|null, notas: string|null }}
 */
function validarFigura(input, { actual = null } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const tiene = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const username = actual ? actual.username : normalizeUsername(src.username);
  if (!username) throw errorDeDatos('Falta el usuario de Instagram (letras, números, punto o guion bajo).');
  const rol = tiene('rol') ? String(src.rol || '') : actual ? actual.rol : '';
  if (!esRol(rol)) throw errorDeDatos('Elegí un rol de la lista.');
  let alineacion = tiene('alineacion') ? src.alineacion : actual ? actual.alineacion : null;
  alineacion = alineacion === undefined || alineacion === null || alineacion === '' ? null : String(alineacion);
  if (alineacion !== null && !esAlineacion(alineacion)) throw errorDeDatos('La alineación es oficialismo, oposición o ninguna.');
  if (alineacion !== null && !ROLES_CON_ALINEACION.has(rol)) {
    throw errorDeDatos(`La alineación solo va para roles políticos o de prensa, no para "${ROLES[rol]}".`);
  }
  return {
    username,
    nombre: tiene('nombre') ? textoOpcional(src.nombre, MAX_NOMBRE, 'El nombre') : actual ? actual.nombre : null,
    rol,
    alineacion,
    notas: tiene('notas') ? textoOpcional(src.notas, MAX_NOTAS, 'Las notas') : actual ? actual.notas : null,
  };
}

/**
 * Una sugerencia del modelo, saneada: un rol que no existe la descarta;
 * una alineación para un rol que no la lleva se borra (no se le pone
 * ideología a quien no es figura política).
 * @returns {{ username: string, rol: string, alineacion: string|null } | null}
 */
function sanitizarSugerencia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const username = normalizeUsername(raw.username);
  const rol = typeof raw.rol === 'string' ? raw.rol : '';
  if (!username || !esRol(rol)) return null;
  const al = esAlineacion(raw.alineacion) ? raw.alineacion : null;
  return { username, rol, alineacion: ROLES_CON_ALINEACION.has(rol) ? al : null };
}

/** "Periodista · oposición", "Junta comunal", "" sin rol. */
function rolTexto(figura) {
  if (!figura || !esRol(figura.rol)) return '';
  return ROLES[figura.rol] + (esAlineacion(figura.alineacion) ? ` · ${ALINEACIONES[figura.alineacion]}` : '');
}

module.exports = {
  ROLES,
  ROL_KEYS,
  ROLES_CON_ALINEACION,
  ALINEACIONES,
  ALINEACION_KEYS,
  ORIGENES,
  normalizeUsername,
  validarFigura,
  sanitizarSugerencia,
  rolTexto,
};
