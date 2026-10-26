// ==========================================================================
// geo/etiquetas.js
// --------------------------------------------------------------------------
// Cómo se dicen, para una persona, el tipo de ubicación, la precisión y el
// motivo de un reclamo sin ubicar (fase H): el CSV de reclamos los usa, y
// la pantalla (public/js/claimsMap.js) repite los mismos textos.
// ==========================================================================

const TIPO = {
  calle_altura: 'Calle y altura',
  cruce: 'Cruce de calles',
  lugar: 'Lugar con nombre',
  villa: 'Villa o asentamiento',
  barrio: 'Solo el barrio',
  lineal: 'Calle o avenida sin altura',
  ninguna: 'Sin lugar ubicable',
};

const PRECISION = {
  puntual: 'Puntual',
  cruce: 'Cruce',
  lugar: 'Lugar con nombre · ubicación aproximada',
  area: 'Área (villa o asentamiento)',
  ninguna: 'Sin punto',
};

const MOTIVO = {
  lineal: 'Una calle o avenida sin altura ni cruce',
  fuera_de_caba: 'Fuera de la Ciudad',
  ambigua: 'Ambigua: USIG dio varias opciones',
  no_encontrada: 'No encontrada',
  sin_direccion: 'Sin dirección',
  descartado: 'Descartado por el equipo',
};

module.exports = { TIPO, PRECISION, MOTIVO };
