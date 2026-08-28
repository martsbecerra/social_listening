// ==========================================================================
// addressClean.js
// --------------------------------------------------------------------------
// Limpieza de una dirección ya detectada (por Claude o por el import de
// Excel) antes de mandarla a USIG. Portado de un proyecto Python de
// referencia (ver plan). No extrae direcciones de texto crudo — eso es lo
// que hacía src/reclamosAddress.js, hoy obsoleto.
// ==========================================================================

// Números con separador de miles ("3.109" -> "3109"). USIG espera la altura
// sin puntos.
const REGEX_ENTERO = /([0-9]{1,3}(?:\.[0-9]{3})+)/g;

const CALLE_UPPER = 'A-ZÑÁÉÍÓÚÄËÏÖÜÀÈÌÒÙ';
const CALLE_LOWER = 'a-zñáéíóúäëïöüàèìòù';
const REGEX_CALLE_SRC =
  `(?:(?:[${CALLE_UPPER}][${CALLE_LOWER}]*[.,]?)|[0-9]+)` +
  `(?: de la| del| la| de)?(?: [${CALLE_UPPER}][${CALLE_LOWER}]*[.,]?)*`;

// "<calle> entre <calle> y <calle>" -> "<calle> y <calle>": el tramo pasa a
// ser su primera esquina, que es lo único que USIG sabe resolver. Un tramo de
// cuadra no tiene un punto propio; su esquina inicial es la mejor aproximación
// disponible y cae dentro del tramo mencionado.
//
// El "en " inicial es opcional y NO se conserva: USIG no entiende
// "en Cabildo y Juramento", sólo "Cabildo y Juramento". La versión anterior
// exigía el "en" y lo dejaba en la salida, así que "Cabildo entre Juramento y
// Mendoza" no matcheaba y "en Cabildo, entre..." producía "en Cabildo, y
// Juramento" — ninguna de las dos geocodificaba.
const REGEX_CUADRA = new RegExp(
  `(?:\\ben\\s+)?(${REGEX_CALLE_SRC})\\s*,?\\s+entre\\s+(${REGEX_CALLE_SRC})\\s+y\\s+${REGEX_CALLE_SRC}`,
  'gi'
);

/** "3.109" -> "3109" en cualquier número con puntos de miles del texto. */
function cleanNumberDots(text) {
  return String(text || '').replace(REGEX_ENTERO, (m) => m.replace(/\./g, ''));
}

/** "X entre Y y Z" (con o sin "en" y sin coma) -> "X y Y". */
function simplifyCuadra(text) {
  return String(text || '')
    .replace(REGEX_CUADRA, (_m, calle, cruce) => `${String(calle).replace(/[.,]\s*$/, '')} y ${cruce}`)
    .trim();
}

/** Limpieza completa antes de geocodificar: números + entrecalles. */
function cleanAddress(text) {
  return simplifyCuadra(cleanNumberDots(text));
}

// Palabras que el detector confunde con nombres de calle (meses, artículos,
// conectores sueltos, etc.). "{,2}" de Python equivale a "{0,2}" en JS.
const NOISE_WORDS = [
  'enero', 'febrero', 'marzo', 'abril', 'may', 'mayo', 'junio', 'jun', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'por', 'mil',
  'para', 'pro', 'el pro', 'lla', 'entre', 'el', 'las', 'los', 'de las',
  'domingo', 'un', 'a los', 'a la', 'de los', 'a', 'esto', 'ya', 'pero',
  'de este', 'es de', 'pue', 'caba', 'lo', 'al', 'mis', 'con', 'por la',
  'el del', 'art', 'dia', 'casi', 'del', 'esta', 'dio', 'es del', 'esto es',
  'y al', 'asi', 'que', 'a el de', 'sin', '[a-z]{0,2}', '\\d{0,2}',
];
const NOISE_ALTERNATION = NOISE_WORDS.join('|');

const INVALID_PATTERNS = [
  new RegExp(`^(?:${NOISE_ALTERNATION}) [0-9]+$`, 'i'),
  new RegExp(`^(?:${NOISE_ALTERNATION}) y .*$`, 'i'),
  new RegExp(`^.*? y (?:${NOISE_ALTERNATION})$`, 'i'),
];

/** true si la dirección (ya limpia) es un falso positivo conocido. */
function isInvalidAddress(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return INVALID_PATTERNS.some((re) => re.test(trimmed));
}

module.exports = {
  cleanNumberDots,
  simplifyCuadra,
  cleanAddress,
  isInvalidAddress,
};
