// ==========================================================================
// categoriaReclamo.js
// --------------------------------------------------------------------------
// Estado del reclamo geolocalizado: lista cerrada, corta y estable, definida
// por el flujo de trabajo del equipo (no por el cliente). Por eso vive acá y
// además tiene CHECK en la tabla.
//
// Las CATEGORÍAS ya no están en este archivo: pasaron al esquema de dos
// niveles (categoría + subcategoría) que define el cliente en
// config/categorias-reclamos.json. Se validan en src/categoriasConfig.js.
// Los re-exports de abajo mantienen andando a quien todavía importa desde acá.
// ==========================================================================

const {
  CATEGORIAS,
  CATEGORIA_FALLBACK,
  listCategorias,
  subcategoriasDe,
  normalizeClasificacion,
} = require('./categoriasConfig');

const ESTADOS_RECLAMO = ['Pendiente', 'En tratamiento', 'Resuelto', 'Desestimado'];
const ESTADO_FALLBACK = 'Pendiente';

const ESTADO_BY_FOLD = new Map(ESTADOS_RECLAMO.map((e) => [e.toLowerCase(), e]));

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

/**
 * @deprecated Usá normalizeClasificacion() de categoriasConfig, que resuelve
 * categoría Y subcategoría juntas. Queda para el código que todavía trata la
 * categoría sola.
 */
function normalizeCategoria(raw) {
  return normalizeClasificacion({ categoria: raw }).categoria;
}

module.exports = {
  // Estado: definido acá.
  ESTADOS_RECLAMO,
  ESTADO_FALLBACK,
  normalizeEstado,
  isValidEstado,
  // Categorías: definidas en config/, re-exportadas por compatibilidad.
  CATEGORIAS_RECLAMO: CATEGORIAS,
  CATEGORIA_FALLBACK,
  listCategorias,
  subcategoriasDe,
  normalizeCategoria,
};
