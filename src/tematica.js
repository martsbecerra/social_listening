// ==========================================================================
// tematica.js
// --------------------------------------------------------------------------
// Temática de reclamo: string libre (LLM o heurística) + normalización.
// No hay lista cerrada. Los alias solo colapsan variantes obvias
// (baches → bache) para que el filtro del mapa no se fragmente.
// ==========================================================================

const FALLBACK = 'otro';
const MAX_WORDS = 4;
const MAX_CHARS = 40;

/** Canónico → variantes que deben colapsar a esa etiqueta. */
const TEMATICA_ALIASES = [
  ['poda de árboles', ['poda de árboles', 'poda de arboles', 'poda', 'árbol hueco', 'arbol hueco']],
  ['semáforo roto', ['semáforo roto', 'semaforo roto', 'semáforo', 'semaforo']],
  ['ruidos molestos', ['ruidos molestos', 'ruido molesto', 'ruidos', 'ruido']],
  ['corte de luz', ['corte de luz', 'sin luz', 'cortes de luz']],
  ['inundación', ['inundación', 'inundacion', 'inundado', 'inundada']],
  ['alumbrado', ['alumbrado', 'farol', 'luminaria', 'luminarias']],
  ['inseguridad', ['inseguridad', 'robo', 'robos', 'afano', 'chorro']],
  ['transporte', ['transporte', 'colectivo', 'colectivos', 'subte', 'bondi']],
  ['educación', ['educación', 'educacion', 'escuela', 'escuelas', 'colegio']],
  ['limpieza', ['limpieza', 'limpiar', 'suciedad']],
  ['veredas', ['vereda', 'veredas']],
  ['basura', ['basura', 'basuras', 'residuos', 'contenedor', 'contenedores']],
  ['salud', ['salud', 'hospital', 'guardia']],
  ['bache', ['bache', 'baches', 'pozo', 'pozos']],
  ['agua', ['cloaca', 'cloacas', 'agua potable']],
  [
    'estacionamiento',
    [
      'estacionamiento',
      'estacionamientos',
      'estacionar',
      'estacionado',
      'estacionados',
      'conos',
      'cono',
      'carga y descarga',
      'cartel de estacionamiento',
      'trucho',
      'truchos',
      'ochava',
      'ochavas',
    ],
  ],
];

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// "agua" como palabra suelta es demasiado genérica para buscar en un comentario.
const SKIP_INFER_CANONICAL = new Set(['agua']);

const ALIAS_BY_FOLD = new Map();
const INFER_NEEDLES = [];

for (const [canonical, synonyms] of TEMATICA_ALIASES) {
  ALIAS_BY_FOLD.set(fold(canonical), canonical);
  const inferLabels = SKIP_INFER_CANONICAL.has(canonical)
    ? synonyms
    : [canonical, ...synonyms];
  for (const synonym of inferLabels) {
    const key = fold(synonym);
    if (!key) continue;
    ALIAS_BY_FOLD.set(key, canonical);
    INFER_NEEDLES.push({ needle: key, canonical });
  }
}

INFER_NEEDLES.sort((a, b) => b.needle.length - a.needle.length);

function containsNeedle(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(haystack);
}

// El seed Brandwatch es una campaña de estacionamientos irregulares:
// muchos tuits dicen "hay uno en X" sin nombrar el tema.
const PARKING_IMPLICIT = [
  /\bhay (?:uno|una|unos|unas|\d+)\b/,
  /\bmano (?:izquierda|derecha)\b/,
  /\b(?:murio|fallecio)\b/,
  /\bno se usan\b/,
  /\bjamas vi\b/,
];

function stripLabelPrefix(text) {
  return text.replace(/^(tem[aá]tica|tema|categor[ií]a)\s*[:\-]\s*/i, '').trim();
}

function cleanLabel(raw) {
  let text = stripLabelPrefix(String(raw || '').trim());
  text = text
    .toLowerCase()
    .replace(/[_/|]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  text = text.split(/\s+/).slice(0, MAX_WORDS).join(' ');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS).trim();
  return text;
}

function dropTrailingPlural(folded) {
  const words = folded.split(' ');
  const last = words[words.length - 1];
  if (!last || last.length < 4 || !last.endsWith('s')) return '';
  words[words.length - 1] = last.replace(/es$/, '').replace(/s$/, '');
  return words.join(' ').trim();
}

function lookupAlias(folded) {
  if (!folded) return '';
  if (ALIAS_BY_FOLD.has(folded)) return ALIAS_BY_FOLD.get(folded);
  const singular = dropTrailingPlural(folded);
  if (singular && ALIAS_BY_FOLD.has(singular)) return ALIAS_BY_FOLD.get(singular);
  return '';
}

function resolveAlias(folded) {
  const exact = lookupAlias(folded);
  if (exact) return exact;
  const words = folded.split(' ').filter(Boolean);
  if (words.length < 2) return '';
  return lookupAlias(words.slice(0, 2).join(' ')) || lookupAlias(words[0]);
}

/**
 * Normaliza una etiqueta propuesta (LLM, seed o API).
 * Vacío / placeholder → "otro". Alias conocido → canónico. Si no, se conserva.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeTematica(raw) {
  const cleaned = cleanLabel(raw);
  if (!cleaned) return FALLBACK;
  if (/^(otro|otra|otros|otras|n ?d|nd|n\/d|ningun[ao]s?)$/i.test(cleaned)) return FALLBACK;
  return resolveAlias(fold(cleaned)) || cleaned;
}

/**
 * Primera temática reconocida en un comentario (seed sin LLM).
 * @param {unknown} text
 * @param {{ implicitParking?: boolean }} [opts]
 * @returns {string}
 */
function inferTematica(text, opts = {}) {
  const haystack = fold(text);
  if (!haystack) return FALLBACK;
  for (const { needle, canonical } of INFER_NEEDLES) {
    if (containsNeedle(haystack, needle)) return canonical;
  }
  if (opts.implicitParking && PARKING_IMPLICIT.some((re) => re.test(haystack))) {
    return 'estacionamiento';
  }
  return FALLBACK;
}

/**
 * Temáticas distintas para chips, "otro" al final.
 * @param {Array<{ tematica?: string }>} reclamos
 * @returns {string[]}
 */
function collectTematicas(reclamos) {
  const seen = new Set();
  for (const row of reclamos || []) {
    const tema = normalizeTematica(row && row.tematica);
    if (tema) seen.add(tema);
  }
  return [...seen].sort((a, b) => {
    if (a === FALLBACK) return 1;
    if (b === FALLBACK) return -1;
    return a.localeCompare(b, 'es');
  });
}

module.exports = {
  FALLBACK,
  normalizeTematica,
  inferTematica,
  collectTematicas,
};
