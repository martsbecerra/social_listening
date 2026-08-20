// ==========================================================================
// analysisSchema.js
// --------------------------------------------------------------------------
// JSON Schema de la respuesta del LLM (Structured Outputs).
// Debe estar alineado con prompt.js y validateAnalysis.js.
// tematica es string libre (max 40); la normalización vive en tematica.js.
// ==========================================================================

// Valores permitidos; deben coincidir con validateAnalysis.js y el system prompt.
const SENTIMENTS = ['positivo', 'negativo', 'neutral', 'ruido'];
const ACCOUNT_TYPES = ['oficial', 'periodista', 'opositor', 'vecino', 'ruido'];

// Una fila del CSV de reclamos (puede haber varias por comentario).
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
  },
  required: ['direccionDetectada', 'direccionNormalizada', 'tematica'],
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
};
