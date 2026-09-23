// ==========================================================================
// reclamosQuery.js — Filtros del mapa de reclamos (query string → objeto).
// ==========================================================================

const PLATAFORMAS_MAPA = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'x', label: 'X' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'tiktok', label: 'TikTok' },
];

const PLATAFORMA_IDS = PLATAFORMAS_MAPA.map((item) => item.id);

function parsePlataformaList(value) {
  if (value == null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const list = raw.map((item) => String(item).trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function isValidReclamosPlataforma(value) {
  return PLATAFORMA_IDS.includes(String(value || '').trim());
}

// Sin lista: todas las redes del mapa. Con lista: cada id tiene que existir.
function isValidReclamosSeleccion(list) {
  if (list == null) return true;
  return Array.isArray(list) && list.length > 0 && list.every((id) => PLATAFORMA_IDS.includes(id));
}

function parseReclamosFilters(query) {
  const toList = (v) => {
    if (v == null || v === '') return undefined;
    return Array.isArray(v) ? v : String(v).split(',').filter(Boolean);
  };
  return {
    plataforma: parsePlataformaList(query.plataforma),
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
  isValidReclamosSeleccion,
  parseReclamosFilters,
};
