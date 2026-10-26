// ==========================================================================
// geo/etiquetas.js
// --------------------------------------------------------------------------
// Cómo se dicen, para una persona, el tipo de ubicación, la precisión y el
// motivo de un reclamo sin ubicar (fase H): el CSV de reclamos los usa y
// GET /api/reclamos se los pasa a la pantalla (public/js/claimsMap.js), así
// el mapa y el CSV dicen lo mismo.
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
  puntual: 'Dirección exacta',
  cruce: 'Cruce de calles',
  lugar: 'Lugar con nombre · ubicación aproximada',
  area: 'Villa o asentamiento · ubicación del área',
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
