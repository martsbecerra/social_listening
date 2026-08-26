// ==========================================================================
// categoriaReclamo.js
// --------------------------------------------------------------------------
// Ejes cerrados del reclamo geolocalizado (tabla `reclamos`): categoria y
// estado. A diferencia de `tematica.js` (etiqueta libre para el CSV legacy
// de /api/analyze), acá la lista es fija y no se extiende con alias.
// ==========================================================================

const CATEGORIAS_RECLAMO = [
  'Estacionamientos truchos',
  'Trapitos',
  'Vehículos abandonados',
  'Seguridad',
  'Casas tomadas',
  'Limpieza',
  'Alumbrado',
  'Vendedores ambulantes',
  'Otros',
];

const ESTADOS_RECLAMO = ['Pendiente', 'En tratamiento', 'Resuelto', 'Desestimado'];

const CATEGORIA_FALLBACK = 'Otros';
const ESTADO_FALLBACK = 'Pendiente';

const CATEGORIA_BY_FOLD = new Map(
  CATEGORIAS_RECLAMO.map((c) => [c.toLowerCase(), c])
);
const ESTADO_BY_FOLD = new Map(ESTADOS_RECLAMO.map((e) => [e.toLowerCase(), e]));

/**
 * Normaliza una categoría propuesta (LLM o import) contra la lista cerrada.
 * Si no matchea exacto (case-insensitive), cae en "Otros".
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeCategoria(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return CATEGORIA_BY_FOLD.get(key) || CATEGORIA_FALLBACK;
}

/**
 * Normaliza un estado propuesto contra la lista cerrada.
 * Si no matchea exacto (case-insensitive), cae en "Pendiente".
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeEstado(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return ESTADO_BY_FOLD.get(key) || ESTADO_FALLBACK;
}

function isValidEstado(raw) {
  return ESTADO_BY_FOLD.has(String(raw || '').trim().toLowerCase());
}

module.exports = {
  CATEGORIAS_RECLAMO,
  ESTADOS_RECLAMO,
  CATEGORIA_FALLBACK,
  ESTADO_FALLBACK,
  normalizeCategoria,
  normalizeEstado,
  isValidEstado,
};
