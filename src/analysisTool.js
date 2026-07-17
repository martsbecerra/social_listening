// ==========================================================================
// analysisTool.js
// --------------------------------------------------------------------------
// Definición del tool de Anthropic "entregar_analisis".
// Obliga a Claude a responder con JSON estructurado (tool use) en lugar de
// texto libre + marcadores CSV. Los % y el KPI no van acá: los calcula Node.
// ==========================================================================

const ANALYSIS_TOOL_NAME = 'entregar_analisis';

const ANALYSIS_TOOL = {
  name: ANALYSIS_TOOL_NAME,
  description:
    'Devuelve la clasificación de cada comentario listado y los textos cualitativos del reporte. No calcules porcentajes de sentiment ni niveles KPI; el sistema los calcula en código.',
  input_schema: {
    type: 'object',
    // Evita campos extra que el modelo a veces inventa.
    additionalProperties: false,
    properties: {
      posteoSobre: {
        type: 'string',
        description: 'Resumen ejecutivo del contenido del posteo.',
      },
      classifications: {
        type: 'array',
        description:
          'Un ítem por cada comentario numerado en el mensaje del usuario, con el mismo index (1-based).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', minimum: 1 },
            sentiment: {
              type: 'string',
              enum: ['positivo', 'negativo', 'neutral', 'ruido'],
            },
            accountType: {
              type: 'string',
              enum: ['oficial', 'periodista', 'opositor', 'vecino', 'ruido'],
            },
            reclamosGeo: {
              type: 'array',
              description:
                'Solo si el comentario es un reclamo con ubicación mencionada. Vacío si no aplica.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  direccionDetectada: { type: 'string' },
                  direccionNormalizada: { type: 'string' },
                  tematica: { type: 'string' },
                },
                required: ['direccionDetectada', 'direccionNormalizada', 'tematica'],
              },
            },
          },
          required: ['index', 'sentiment', 'accountType', 'reclamosGeo'],
        },
      },
      // Insights 3–6 del template WhatsApp: exactamente 2 líneas cada uno.
      insightApoyo: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 2,
      },
      insightCriticas: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 2,
      },
      insightReclamos: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 2,
      },
      insightMedios: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 2,
      },
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
  },
};

module.exports = { ANALYSIS_TOOL, ANALYSIS_TOOL_NAME };
