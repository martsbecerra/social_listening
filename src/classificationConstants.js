// ==========================================================================
// classificationConstants.js
// --------------------------------------------------------------------------
// Listas cerradas compartidas por prompt, JSON Schema y validación en Node.
// ==========================================================================

/** Temáticas permitidas en el CSV de reclamos (columna Tematica detectada). */
const RECLAMO_TEMATICAS = [
  'bache',
  'poda de árboles',
  'alumbrado',
  'basura',
  'inseguridad',
  'semáforo roto',
  'ruidos molestos',
  'corte de luz',
  'agua',
  'transporte',
  'limpieza',
  'veredas',
  'inundación',
  'salud',
  'educación',
  'otro', // fallback en validateAnalysis si el modelo inventa otra etiqueta
];

module.exports = { RECLAMO_TEMATICAS };
