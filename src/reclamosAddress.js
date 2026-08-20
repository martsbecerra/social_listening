// ==========================================================================
// reclamosAddress.js
// --------------------------------------------------------------------------
// Heurística conservadora para el seed Brandwatch/X: extrae calle del texto
// del comentario (nunca City). La temática se infiere en tematica.js.
// ==========================================================================

const { inferTematica } = require('./tematica');

const MACRI_BOILER = /ins[oó]lito[\s\S]*?estacionamientos[\s\S]*?(ciudad|vale\s*t)/gi;
const MACRI_LEFTOVER = /ya van \d+ en palermo[\s\S]*$/gi;
const SAME_BLOCK = /en una misma cuadra/gi;
const RT_QT_PREFIX = /^(?:rt|qt)\s+@[\w.]+[:\s]+/i;
const JORGE_PREFIX = /^@?jorgemacri\b[:,\s]*/gi;
const TCO_LINK = /https?:\/\/t\.co\/\w+/gi;

const WORD = String.raw`[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}(?:\.[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)?`;
const NAME_1_3 = String.raw`${WORD}(?:\s+${WORD}){0,2}`;
const STREET_TYPE = String.raw`(?:av(?:enida)?\.?|calle|pasaje|pje\.?|diag(?:onal)?\.?)`;
const STREET_NUM = String.raw`\d{2,5}`;

const TYPE_NAME_NUM = new RegExp(
  `\\b(${STREET_TYPE})\\s+(${NAME_1_3})\\s+(${STREET_NUM})\\b`,
  'i'
);
const AV_NAME_ONLY = new RegExp(
  `\\b((?:av(?:enida)?|pasaje|pje|diag(?:onal)?)\\.?)\\s+(${NAME_1_3})\\b`,
  'i'
);
const NAME_AL_NUM = new RegExp(`\\b(${NAME_1_3})\\s+al\\s+(${STREET_NUM})\\b`, 'i');
const STREET_ENTRE = new RegExp(
  `\\b(${NAME_1_3})\\s+entre\\s+(${NAME_1_3})\\s+y\\s+(${NAME_1_3})\\b`,
  'i'
);
const ESQUINA = new RegExp(
  `\\b(?:esquina|esq\\.?)\\s+(?:de\\s+|con\\s+)?(${NAME_1_3})\\s+y\\s+(${NAME_1_3})\\b`,
  'i'
);
const NAME_AND_NUM = new RegExp(`\\b(${NAME_1_3})\\s+(${STREET_NUM})\\b`, 'i');

const NOISE =
  /\b(hace|hacen|haces|gobiernan|gobernando|gobierna|gobern[oó]|casi|desde|durante|[uú]ltimos?|video|ustedes|ellos|tipos|jorge|jorgemacri|se[nñ]or|tercer|reclamo|controlan|controlados|boletearon|dieron|empez[oó]|usurpador|inhabilitar|topadoras|paragolpes|farmacia|welcome|siempre|gano|problema|eterno|ochavas|anulaste|acab[oó]|apelaciones|mientras|sacar|vale|todo|altura|bien|segui|misma|cuadra|ciudad|gestionan|gesti[oó]n|registro|delincuentes|esperamos|vengan|ven[ií]|venite|f[ií]jate|revisen|revisar|vean|tambi[eé]n|hoy|mamita|in[uú]til|bares|restaurantes|mesas|pandemia|construir|alquilen|locales|reservan|estacionamiento|mont[oó]n|dejen|existan|tachones|laterales|donde|tierra|nadie|editado|mismos|terribles|pol[ií]tica|antiautos|congreso|cesac|van|hay|tiene|tenia|ten[ií]a|eran|como|para|hasta|toda|unos|unas|este|esta|otro|otra|lado|medio|mas|m[aá]s|que|son|sin|muy|ya|eliminar|m[ií]nimo|debiera|tenes|viviendo|pusieron|mina|fiesta|todos|ponen|ser)\b/i;

const BARRIO_ONLY =
  /^(palermo|belgrano|recoleta|caballito|almagro|villa crespo|villa urquiza|n[uú]ñez|colegiales|san telmo|la boca|boedo|flores|floresta|mataderos|liniers|versalles|villa devoto|villa del parque|saavedra|coghlan|chacarita|paternal|villa pueyrred[oó]n|villa ort[uú]zar|agronom[ií]a|parque chacabuco|parque patricios|constituci[oó]n|monserrat|retiro|puerto madero|barracas|nueva pompeya|villa soldati|villa lugano|villa riachuelo|caba|capital federal|buenos aires|la ciudad)$/i;

function collapseSpaces(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBoilerplate(text) {
  let cleaned = collapseSpaces(text);
  cleaned = cleaned.replace(MACRI_BOILER, ' ');
  cleaned = cleaned.replace(MACRI_LEFTOVER, ' ');
  cleaned = cleaned.replace(SAME_BLOCK, ' ');
  cleaned = cleaned.replace(TCO_LINK, ' ');
  cleaned = cleaned.replace(RT_QT_PREFIX, '');
  cleaned = cleaned.replace(JORGE_PREFIX, '');
  return collapseSpaces(cleaned);
}

function titleCaseStreet(value) {
  return collapseSpaces(value)
    .toLowerCase()
    .replace(/\bav(enida)?\.?\b/g, 'Av.')
    .replace(/\bcalle\b/g, 'Calle')
    .replace(/\bpasaje\b|\bpje\.?\b/g, 'Pasaje')
    .replace(/\bdiag(onal)?\.?\b/g, 'Diag.')
    .replace(/\bal\b/g, 'al')
    .replace(/\by\b/g, 'y')
    .replace(/\bentre\b/g, 'entre')
    .replace(/\besq(uina)?\.?\b/g, 'esquina')
    .replace(/(^|[\s.])([a-záéíóúüñ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function isYearOrTiny(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return true;
  if (n < 100) return true;
  if (n >= 1900 && n <= 2039) return true;
  return false;
}

function hasNoise(text) {
  return NOISE.test(text);
}

function stripLeadIn(detected) {
  return collapseSpaces(detected).replace(
    /^(?:en|uno en|el de|de la|de|la calle)\s+/i,
    ''
  );
}

function isPlausible(detected, { requireNumber = false } = {}) {
  const trimmed = stripLeadIn(detected);
  if (!trimmed || trimmed.length < 5 || trimmed.length > 70) return false;
  if (BARRIO_ONLY.test(trimmed)) return false;
  if (/toda la ciudad/i.test(trimmed)) return false;
  if (hasNoise(trimmed)) return false;
  const num = trimmed.match(/(\d{2,5})\s*$/);
  if (requireNumber) {
    if (!num || isYearOrTiny(num[1])) return false;
  } else if (num && isYearOrTiny(num[1]) && Number(num[1]) >= 1900) {
    return false;
  }
  return true;
}

function normalizeMatch(detected, opts) {
  const trimmed = stripLeadIn(detected);
  if (!isPlausible(trimmed, opts)) return null;
  return {
    direccionDetectada: trimmed,
    direccionNormalizada: titleCaseStreet(trimmed),
  };
}

/**
 * Extrae una dirección de calle del texto, o null si no hay una concreta.
 * @param {string} text
 * @returns {{ direccionDetectada: string, direccionNormalizada: string } | null}
 */
function extractAddress(text) {
  const cleaned = stripBoilerplate(text);
  if (!cleaned) return null;

  const attempts = [
    [TYPE_NAME_NUM, { requireNumber: true }],
    [NAME_AL_NUM, { requireNumber: true }],
    [STREET_ENTRE, {}],
    [ESQUINA, {}],
    [NAME_AND_NUM, { requireNumber: true }],
    [AV_NAME_ONLY, {}],
  ];

  for (const [regex, opts] of attempts) {
    const match = cleaned.match(regex);
    if (!match) continue;
    const normalized = normalizeMatch(match[0], opts);
    if (normalized) return normalized;
  }
  return null;
}

function buildGeocodeQueryKey(direccionNormalizada) {
  return `${direccionNormalizada}, CABA, Argentina`;
}

module.exports = {
  stripBoilerplate,
  extractAddress,
  inferTematica,
  buildGeocodeQueryKey,
};
