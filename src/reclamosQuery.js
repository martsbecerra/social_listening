// ==========================================================================
// reclamosQuery.js — Filtros del mapa de reclamos (query string → objeto).
// ==========================================================================

const PLATAFORMAS_MAPA = ['instagram', 'x'];

function isValidReclamosPlataforma(value) {
  return PLATAFORMAS_MAPA.includes(String(value || '').trim());
}

function parseReclamosFilters(query) {
  const toList = (v) => {
    if (v == null || v === '') return undefined;
    return Array.isArray(v) ? v : String(v).split(',').filter(Boolean);
  };
  return {
    plataforma: query.plataforma ? String(query.plataforma).trim() : undefined,
    categoria: toList(query.categoria),
    subcategoria: toList(query.subcategoria),
    estado: toList(query.estado),
    barrio: query.barrio || undefined,
    comuna: query.comuna || undefined,
    desde: query.desde || undefined,
    hasta: query.hasta || undefined,
    q: query.q || undefined,
  };
}

module.exports = {
  PLATAFORMAS_MAPA,
  isValidReclamosPlataforma,
  parseReclamosFilters,
};
