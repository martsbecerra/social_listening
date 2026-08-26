// ==========================================================================
// analysisSchema.js — JSON Schema del análisis X (structured outputs).
// ==========================================================================

const { CATEGORIAS_RECLAMO } = require('../categoriaReclamo');

const SENTIMENTS = ['positivo', 'negativo', 'neutral', 'ruido'];
const ACCOUNT_TYPES = ['oficial', 'periodista', 'opositor', 'vecino', 'ruido'];

const RECLAMO_GEO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    direccionDetectada: { type: 'string' },
    tematica: { type: 'string', maxLength: 40 },
    categoria: { type: 'string', enum: CATEGORIAS_RECLAMO },
  },
  required: ['direccionDetectada', 'tematica', 'categoria'],
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
  ],
};

module.exports = {
  ANALYSIS_JSON_SCHEMA,
  SENTIMENTS,
  ACCOUNT_TYPES,
};
