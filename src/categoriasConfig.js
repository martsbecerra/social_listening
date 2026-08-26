// ==========================================================================
// categoriasConfig.js
// --------------------------------------------------------------------------
// Esquema de dos niveles (categoría + subcategoría) del cliente, leído de
// config/categorias-reclamos.json. La lista NO vive en el código ni en un
// CHECK de la base a propósito: es larga, la define el cliente y va a
// cambiar. Agregar una categoría tiene que ser editar un JSON, no migrar.
//
// Por eso la validación es acá: todo lo que entra a la tabla `reclamos`
// (LLM o import) pasa por normalizeClasificacion().
// ==========================================================================

const fs = require('fs');
const path = require('path');

const CONFIG_PATH =
  process.env.CATEGORIAS_CONFIG_PATH || path.join(__dirname, '..', 'config', 'categorias-reclamos.json');

/** Plegado para comparar: sin acentos, sin mayúsculas, sin espacios de más. */
function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    const e = new Error(`No se pudo leer ${CONFIG_PATH}: ${err.message}`);
    e.userMessage =
      'Falta config/categorias-reclamos.json, que define las categorías de reclamos. Sin ese archivo la app no puede clasificar.';
    throw e;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`config/categorias-reclamos.json no es JSON válido: ${err.message}`);
    e.userMessage = 'El archivo config/categorias-reclamos.json tiene un error de sintaxis.';
    throw e;
  }

  if (!Array.isArray(doc.categorias) || doc.categorias.length === 0) {
    throw new Error('config/categorias-reclamos.json no tiene un array "categorias" con contenido.');
  }
  return doc;
}

const CONFIG = loadConfig();

const CATEGORIA_FALLBACK = (CONFIG.fallback && CONFIG.fallback.categoria) || 'Coyuntura / Otros';
const SUBCATEGORIA_FALLBACK = (CONFIG.fallback && CONFIG.fallback.subcategoria) || '';

/** Nombres canónicos, en el orden del PDF (el que conoce el cliente). */
const CATEGORIAS = CONFIG.categorias.map((c) => c.nombre);

/** nombre canónico de categoría -> array de subcategorías canónicas */
const SUBCATEGORIAS_POR_CATEGORIA = new Map(
  CONFIG.categorias.map((c) => [c.nombre, Array.isArray(c.subcategorias) ? c.subcategorias.slice() : []])
);

const CATEGORIA_POR_FOLD = new Map(CONFIG.categorias.map((c) => [fold(c.nombre), c.nombre]));

/** fold(categoria) -> Map(fold(subcategoria) -> subcategoría canónica) */
const SUB_POR_FOLD = new Map(
  CONFIG.categorias.map((c) => [
    fold(c.nombre),
    new Map((c.subcategorias || []).map((s) => [fold(s), s])),
  ])
);

if (CATEGORIA_POR_FOLD.get(fold(CATEGORIA_FALLBACK)) == null) {
  throw new Error(
    `El fallback "${CATEGORIA_FALLBACK}" no existe entre las categorías de config/categorias-reclamos.json.`
  );
}

// --------------------------------------------------------------------------
// Alias de las categorías viejas (esquema de 9 valores, previo a este cambio)
// y de los valores crudos que traen los archivos a importar.
//
// No alcanza con normalizar acentos y mayúsculas: el archivo histórico trae
// "Recuperción de Propiedes " — con dos typos y un espacio al final — que
// plegado da "recupercion de propiedes", distinto de "recuperacion de
// propiedades". Son la misma categoría mal escrita, así que van explícitos.
// --------------------------------------------------------------------------
const ALIAS_CATEGORIAS_VIEJAS = [
  // Esquema viejo de la app.
  ['Estacionamientos truchos', 'Tránsito', 'Cuestionamientos por autos mal estacionados'],
  ['Trapitos', 'Seguridad', 'Críticas por presencia de trapitos'],
  ['Casas tomadas', 'Seguridad', 'Reclamos por viviendas usurpadas / casas tomadas'],
  ['Vehículos abandonados', 'Gestión comunal', 'Quejas por autos abandonados'],
  ['Limpieza', 'Higiene', 'Reclamos por falta de limpieza y recolección de residuos'],
  ['Alumbrado', 'Energía', 'Reclamos por cortes de luz en distintos barrios'],
  ['Vendedores ambulantes', 'Seguridad', 'Críticas por presencia de manteros'],
  ['Seguridad', 'Seguridad', 'Quejas por hechos de inseguridad'],
  ['Otros', 'Coyuntura / Otros', ''],

  // Valores crudos del archivo histórico de X. La subcategoría queda vacía
  // a propósito: la asigna el LLM leyendo el texto de cada fila.
  ['Higiene', 'Higiene', ''],
  ['Personas en Situación de Calle', 'Desarrollo Humano', ''],
  ['Recuperación de propiedades', 'Seguridad', ''],
  ['Recuperción de Propiedes', 'Seguridad', ''],
];

const ALIAS_POR_FOLD = new Map(
  ALIAS_CATEGORIAS_VIEJAS.map(([viejo, categoria, subcategoria]) => [
    fold(viejo),
    { categoria, subcategoria },
  ])
);

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------

function listCategorias() {
  return CATEGORIAS.slice();
}

/** @param {string} categoria nombre canónico o cualquier variante de mayúsculas/acentos */
function subcategoriasDe(categoria) {
  const canonica = CATEGORIA_POR_FOLD.get(fold(categoria));
  if (!canonica) return [];
  return (SUBCATEGORIAS_POR_CATEGORIA.get(canonica) || []).slice();
}

/** @returns {string | null} nombre canónico, o null si no existe. */
function resolveCategoria(raw) {
  return CATEGORIA_POR_FOLD.get(fold(raw)) || null;
}

/** @returns {string | null} subcategoría canónica dentro de esa categoría, o null. */
function resolveSubcategoria(categoria, raw) {
  const canonica = resolveCategoria(categoria);
  if (!canonica) return null;
  const mapa = SUB_POR_FOLD.get(fold(canonica));
  if (!mapa) return null;
  return mapa.get(fold(raw)) || null;
}

/** Traducción de una categoría del esquema viejo o de un archivo importado. */
function resolveAliasViejo(raw) {
  return ALIAS_POR_FOLD.get(fold(raw)) || null;
}

/**
 * Normaliza el par (categoría, subcategoría) contra la lista cerrada. Es el
 * único camino por el que deberían entrar estos dos campos a la base.
 *
 * Reglas, en orden:
 *   - Categoría que no existe -> se prueba como alias viejo; si tampoco, cae
 *     en el fallback ("Coyuntura / Otros").
 *   - Subcategoría que no pertenece a esa categoría -> se guarda la categoría
 *     con subcategoría vacía. Se prefiere un dato parcial correcto a uno
 *     completo inventado.
 *
 * @param {{categoria?: unknown, subcategoria?: unknown, contexto?: string}} input
 *   `contexto` es sólo para el log (id de fila, url), para poder rastrear el caso.
 * @returns {{categoria: string, subcategoria: string, ajustes: string[]}}
 */
function normalizeClasificacion({ categoria, subcategoria, contexto = '' } = {}) {
  const ajustes = [];
  const donde = contexto ? ` [${contexto}]` : '';

  let cat = resolveCategoria(categoria);
  let sub = null;

  if (!cat) {
    const alias = resolveAliasViejo(categoria);
    if (alias) {
      cat = alias.categoria;
      // El alias sólo impone su subcategoría si quien llama no propuso otra.
      if (alias.subcategoria && (subcategoria == null || String(subcategoria).trim() === '')) {
        sub = alias.subcategoria;
      }
      ajustes.push(`categoría "${categoria}" traducida a "${cat}" por alias`);
    }
  }

  if (!cat) {
    if (categoria != null && String(categoria).trim() !== '') {
      ajustes.push(`categoría "${categoria}" no existe -> "${CATEGORIA_FALLBACK}"`);
    }
    cat = CATEGORIA_FALLBACK;
  }

  if (sub == null) {
    const propuesta = subcategoria == null ? '' : String(subcategoria).trim();
    if (propuesta === '') {
      sub = SUBCATEGORIA_FALLBACK;
    } else {
      const resuelta = resolveSubcategoria(cat, propuesta);
      if (resuelta) {
        sub = resuelta;
      } else {
        sub = '';
        ajustes.push(`subcategoría "${propuesta}" no pertenece a "${cat}" -> vacía`);
      }
    }
  }

  if (ajustes.length > 0) {
    console.warn(`[categorias]${donde} ${ajustes.join('; ')}`);
  }

  return { categoria: cat, subcategoria: sub, ajustes };
}

module.exports = {
  CATEGORIAS,
  CATEGORIA_FALLBACK,
  SUBCATEGORIA_FALLBACK,
  CONFIG_PATH,
  listCategorias,
  subcategoriasDe,
  resolveCategoria,
  resolveSubcategoria,
  resolveAliasViejo,
  normalizeClasificacion,
  fold,
};
