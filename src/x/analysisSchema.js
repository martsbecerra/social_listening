// ==========================================================================
// analysisSchema.js — JSON Schema del análisis X (structured outputs).
// ==========================================================================

const { listCategorias } = require('../categoriasConfig');
const { TIPOS_UBICACION } = require('../analysisSchema');
const { TEMAS_ARRAY_SCHEMA } = require('../temasConversacion');

const SENTIMENTS = ['positivo', 'negativo', 'neutral', 'ruido'];
const ACCOUNT_TYPES = ['oficial', 'periodista', 'opositor', 'vecino', 'ruido'];

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

const CLASSIFICATION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', minimum: 1 },
    sentiment: { type: 'string', enum: SENTIMENTS },
    accountType: { type: 'string', enum: ACCOUNT_TYPES },
    reclamosGeo: { type: 'array', items: RECLAMO_GEO_SCHEMA },
  },
  required: ['index', 'sentiment', 'accountType', 'reclamosGeo'],
};

const INSIGHT_REFS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  maxItems: 2,
};

const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    posteoSobre: { type: 'string' },
    classifications: { type: 'array', items: CLASSIFICATION_ITEM_SCHEMA },
    insightApoyo: INSIGHT_REFS_SCHEMA,
    insightCriticas: INSIGHT_REFS_SCHEMA,
    insightReclamos: INSIGHT_REFS_SCHEMA,
    insightMedios: INSIGHT_REFS_SCHEMA,
    insightOrganica: INSIGHT_REFS_SCHEMA,
    insightEstetica: INSIGHT_REFS_SCHEMA,
    temasConversacion: TEMAS_ARRAY_SCHEMA,
  },
  required: [
    'posteoSobre',
    'classifications',
    'insightApoyo',
    'insightCriticas',
    'insightReclamos',
    'insightMedios',
    'insightOrganica',
    'insightEstetica',
    'temasConversacion',
  ],
};

module.exports = {
  ANALYSIS_JSON_SCHEMA,
  SENTIMENTS,
  ACCOUNT_TYPES,
  TIPOS_UBICACION,
};
