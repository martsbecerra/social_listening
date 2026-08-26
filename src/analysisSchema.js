// ==========================================================================
// analysisSchema.js
// --------------------------------------------------------------------------
// JSON Schema de la respuesta del LLM (Structured Outputs).
// Debe estar alineado con prompt.js y validateAnalysis.js.
// tematica es string libre (max 40); la normalización vive en tematica.js.
// ==========================================================================

const { listCategorias } = require('./categoriasConfig');

// Valores permitidos; deben coincidir con validateAnalysis.js y el system prompt.
const SENTIMENTS = ['positivo', 'negativo', 'neutral', 'ruido'];
const ACCOUNT_TYPES = ['oficial', 'periodista', 'opositor', 'vecino', 'ruido'];

// Qué tipo de ubicación detectó el modelo. De acá sale la `precision` con la
// que se guarda el reclamo: un lugar con nombre propio ("Plaza Italia") se
// geocodifica igual, pero no es lo mismo que una altura exacta, y el mapa
// tiene que poder mostrar esa diferencia en vez de fingir precisión.
const TIPOS_UBICACION = ['calle_altura', 'cruce', 'tramo', 'lugar_nombrado'];

// Una fila del CSV de reclamos (puede haber varias por comentario). También
// alimenta la tabla `reclamos` del mapa: direccionDetectada + categoria son
// los campos que usa reclamosFromAnalysis.js (ver src/db.js).
const RECLAMO_GEO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    direccionDetectada: { type: 'string' },
    direccionNormalizada: { type: 'string' },
    tematica: {
      type: 'string',
      maxLength: 40,
      description:
        'Etiqueta corta (2 a 4 palabras) del tipo de reclamo. No es un enum: el backend la normaliza.',
    },
    categoria: {
      type: 'string',
      // Generado desde config/categorias-reclamos.json, nunca escrito a mano:
      // si la lista del cliente cambia, el enum cambia solo.
      enum: listCategorias(),
      description:
        'Categoría cerrada del reclamo. Sólo el primer nivel: la subcategoría se pide aparte. ' +
        '"Coyuntura / Otros" si no encaja en ninguna.',
    },
    tipoUbicacion: {
      type: 'string',
      enum: TIPOS_UBICACION,
      description:
        'Qué clase de ubicación es: calle_altura ("Juramento 3109"), cruce ("Nazca y Rivadavia"), ' +
        'tramo (una avenida entre dos calles) o lugar_nombrado ("Plaza Italia", "Hospital Durand").',
    },
  },
  required: ['direccionDetectada', 'direccionNormalizada', 'tematica', 'categoria', 'tipoUbicacion'],
};

// Clasificación por comentario; index coincide con la lista numerada del user prompt.
const CLASSIFICATION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', minimum: 1 },
    sentiment: { type: 'string', enum: SENTIMENTS },
    accountType: { type: 'string', enum: ACCOUNT_TYPES },
    reclamosGeo: {
      type: 'array',
      items: RECLAMO_GEO_SCHEMA,
    },
  },
  required: ['index', 'sentiment', 'accountType', 'reclamosGeo'],
};

// Insights 3–6 del template WhatsApp: exactamente dos strings por campo.
const INSIGHT_PAIR_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  minItems: 2,
  maxItems: 2,
};

/** Schema raíz para Structured Outputs (Anthropic y OpenRouter). */
const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    posteoSobre: {
      type: 'string',
      description: 'Resumen ejecutivo del contenido del posteo.',
    },
    classifications: {
      type: 'array',
      description:
        'Un ítem por cada comentario numerado en el mensaje del usuario (index 1-based).',
      items: CLASSIFICATION_ITEM_SCHEMA,
    },
    insightApoyo: INSIGHT_PAIR_SCHEMA,
    insightCriticas: INSIGHT_PAIR_SCHEMA,
    insightReclamos: INSIGHT_PAIR_SCHEMA,
    insightMedios: INSIGHT_PAIR_SCHEMA,
    posturaAudiencia: { type: 'string' },
    lecturaEstrategica: { type: 'string' },
  },
  required: [
    'posteoSobre',
    'classifications',
    'insightApoyo',
    'insightCriticas',
    'insightReclamos',
    'insightMedios',
    'posturaAudiencia',
    'lecturaEstrategica',
  ],
};

module.exports = {
  ANALYSIS_JSON_SCHEMA,
  SENTIMENTS,
  ACCOUNT_TYPES,
  TIPOS_UBICACION,
};
