// ==========================================================================
// analysisSchema.js
// --------------------------------------------------------------------------
// JSON Schema de la respuesta del LLM (Structured Outputs).
// Debe estar alineado con prompt.js y validateAnalysis.js.
// tematica es string libre (max 40); la normalización vive en tematica.js.
// ==========================================================================

const { listCategorias } = require('./categoriasConfig');
const { TEMAS_ARRAY_SCHEMA } = require('./temasConversacion');
const { ROL_KEYS } = require('./figuras');

// Valores permitidos; deben coincidir con validateAnalysis.js y el system prompt.
const SENTIMENTS = ['positivo', 'negativo', 'neutral', 'ruido'];
const ACCOUNT_TYPES = ['oficial', 'periodista', 'opositor', 'vecino', 'ruido'];
// Fase F: qué dice el comentario de la gestión (no cómo suena).
const POSTURAS = ['favor', 'neutra', 'critica'];
// Cuántos temas puede devolver una tanda: la que los define arma de 4 a 10;
// las demás, según el prompt, como mucho 3 nuevos (el tope de la
// publicación es MAX_TEMAS_ANALISIS, en analyzeComments.js).
const MAX_TEMAS_POR_TANDA = 12;

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
    temasConversacion: TEMAS_ARRAY_SCHEMA,
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
    'temasConversacion',
  ],
};

// El análisis de publicación de Instagram va en varias llamadas
// (src/analyzeComments.js): una por tanda de hasta 50 comentarios, que
// clasifica, y una de síntesis. ANALYSIS_JSON_SCHEMA (arriba) queda como el
// schema por defecto de los proveedores; el análisis pasa estos dos. Desde la
// fase F (openspec/changes/analisis-pro): sin tipo de cuenta; por comentario
// tono, postura, tema, si habla del posteo y si pide algo.

/** La clasificación de un comentario de una tanda (index 1-based de la lista de la tanda). */
const CLASIFICACION_TANDA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', minimum: 1 },
    sentiment: { type: 'string', enum: SENTIMENTS },
    postura: { type: 'string', enum: POSTURAS, description: 'Qué dice de la gestión, no cómo suena.' },
    tema: { type: 'integer', minimum: 0, description: 'El número del tema de la lista; 0 si es ruido o no encaja en ninguno.' },
    sobre_posteo: { type: 'boolean', description: 'true si habla de lo que publica la cuenta o es una reacción genérica a la persona (elogio o insulto sin tema concreto); false solo si usa el posteo para otro tema concreto.' },
    pedido: { type: 'boolean', description: 'true si pide algo concreto o pregunta.' },
    reclamosGeo: { type: 'array', items: RECLAMO_GEO_SCHEMA },
  },
  required: ['index', 'sentiment', 'postura', 'tema', 'sobre_posteo', 'pedido', 'reclamosGeo'],
};

/** Una tanda: los temas que define o suma y un ítem por comentario numerado. */
const TANDA_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    temas: {
      type: 'array',
      maxItems: MAX_TEMAS_POR_TANDA,
      description: 'Los temas que esta tanda define (la primera) o suma (las demás), con su número.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          numero: { type: 'integer', minimum: 1 },
          nombre: { type: 'string', maxLength: 60 },
        },
        required: ['numero', 'nombre'],
      },
    },
    classifications: {
      type: 'array',
      description: 'Un ítem por cada comentario numerado de esta tanda (index 1-based, el número de la lista).',
      items: CLASIFICACION_TANDA_SCHEMA,
    },
  },
  required: ['temas', 'classifications'],
};

/**
 * La síntesis: la lectura, el hecho dominante (o ninguno), los pedidos
 * agrupados con los números de sus comentarios, qué conviene mirar y las
 * sugerencias de rol para verificados sin ficha. Sin números: los cuenta el
 * servidor.
 */
const SINTESIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lectura: { type: 'string', description: 'La lectura estratégica, de 3 a 5 oraciones.' },
    hecho_dominante: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hay: { type: 'boolean' },
        tema: { type: 'integer', minimum: 0 },
        titulo: { type: 'string' },
        descripcion: { type: 'string' },
      },
      required: ['hay', 'tema', 'titulo', 'descripcion'],
    },
    pedidos: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          texto: { type: 'string' },
          ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
        required: ['texto', 'ids'],
      },
    },
    que_mirar: { type: 'string', description: 'Una o dos oraciones: una sugerencia práctica para el equipo.' },
    figuras_sugeridas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string' },
          rol: { type: 'string', enum: ROL_KEYS },
          alineacion: { type: 'string', enum: ['oficialismo', 'oposicion', 'ninguna'] },
        },
        required: ['username', 'rol', 'alineacion'],
      },
    },
  },
  required: ['lectura', 'hecho_dominante', 'pedidos', 'que_mirar', 'figuras_sugeridas'],
};

module.exports = {
  ANALYSIS_JSON_SCHEMA,
  TANDA_JSON_SCHEMA,
  SINTESIS_JSON_SCHEMA,

  SENTIMENTS,
  ACCOUNT_TYPES,
  POSTURAS,
  TIPOS_UBICACION,
  MAX_TEMAS_POR_TANDA,
};
