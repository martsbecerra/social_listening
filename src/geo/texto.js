// ==========================================================================
// geo/texto.js
// --------------------------------------------------------------------------
// Normalización de textos para buscar lugares y armar direcciones (fase H,
// openspec/changes/geo-pro). Port de app/pipeline/texto.py del proyecto
// georreferenciacion: minúsculas, sin acentos (la ñ queda), sin signos, y
// las abreviaturas típicas de los nombres de lugar expandidas ("Pza.
// Italia", "Av. Corrientes", "Villa Gral. Mitre"). Sin dependencias.
// ==========================================================================

/** Minúsculas, sin acentos ni signos, espacios simples. Lo que no es texto da "". */
function limpiarTexto(texto) {
  if (typeof texto !== 'string') return '';
  return texto
    .toLowerCase()
    .trim()
    .replace(/[áàä]/g, 'a')
    .replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u')
    .replace(/[^a-zñ0-9 ]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Las de texto.py más unas pocas que aparecen en los datasets del GCBA
// ("Tte. General", "Dr.", "Pje.", "Esc."). Se expanden después de limpiar,
// palabra por palabra: "av" sola es avenida, "avellaneda" no se toca.
const ABREVIATURAS_LUGAR = {
  pza: 'plaza',
  av: 'avenida',
  avda: 'avenida',
  sta: 'santa',
  sto: 'santo',
  v: 'villa',
  gral: 'general',
  bo: 'barrio',
  pje: 'pasaje',
  cnel: 'coronel',
  tte: 'teniente',
  dr: 'doctor',
  pres: 'presidente',
  esc: 'escuela',
  hosp: 'hospital',
  est: 'estacion',
};

/** limpiarTexto() más las abreviaturas de los nombres de lugar expandidas. */
function normalizarLugar(texto) {
  const limpio = limpiarTexto(texto);
  if (!limpio) return '';
  return limpio
    .split(' ')
    .map((p) => ABREVIATURAS_LUGAR[p] || p)
    .join(' ');
}

// La Ciudad dicha de varias formas al final de una dirección: se saca antes
// de agregar ", CABA" una sola vez (el Excel de X ya la traía y se mandaba
// "…, CABA, CABA").
const SUFIJO_CIUDAD = /(?:\s*,?\s*(?:caba|c\.a\.b\.a\.?|capital federal|ciudad aut[oó]noma de buenos aires|ciudad de buenos aires|buenos aires|bs\.? ?as\.?))+\s*$/i;

/**
 * Una calle (o un cruce) lista para USIG: sin la Ciudad al final, con las
 * abreviaturas expandidas (gral → general, av/avda → avenida, pza → plaza,
 * sta/sto, bo → barrio) y espacios simples. Conserva mayúsculas y acentos.
 */
function prepararParaUsig(texto) {
  if (typeof texto !== 'string') return '';
  const sinCiudad = texto.replace(SUFIJO_CIUDAD, '').trim();
  return sinCiudad
    .split(/\s+/)
    .map((p) => {
      const clave = p.toLowerCase().replace(/\.$/, '');
      const expandida = { gral: 'general', av: 'avenida', avda: 'avenida', pza: 'plaza', sta: 'santa', sto: 'santo', bo: 'barrio' }[clave];
      return expandida || p;
    })
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** El texto con ", CABA" una sola vez al final. */
function conCaba(texto) {
  const base = prepararParaUsig(texto);
  return base ? `${base}, CABA` : '';
}

module.exports = { limpiarTexto, normalizarLugar, prepararParaUsig, conCaba, ABREVIATURAS_LUGAR };
