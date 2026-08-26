// ==========================================================================
// grokModel.js — Modelo Grok SOLO para X (OpenRouter). No pisa Instagram.
// ==========================================================================

const DEFAULT_OPENROUTER_X_MODEL = 'x-ai/grok-4.6';
const DEFAULT_XAI_MODEL = 'grok-4.6';

function rawXModel() {
  return (process.env.OPENROUTER_X_MODEL || process.env.XAI_MODEL || '').trim();
}

/** Slug OpenRouter, p. ej. x-ai/grok-4.6 */
function getOpenRouterXModel() {
  const raw = rawXModel();
  if (!raw) return DEFAULT_OPENROUTER_X_MODEL;
  if (raw.includes('/')) return raw;
  return `x-ai/${raw}`;
}

/** Id para la API directa de xAI (sin prefijo x-ai/). */
function getDirectXaiModel() {
  const raw = rawXModel();
  if (!raw) return DEFAULT_XAI_MODEL;
  return raw.replace(/^x-ai\//, '');
}

module.exports = {
  getOpenRouterXModel,
  getDirectXaiModel,
  DEFAULT_OPENROUTER_X_MODEL,
};
