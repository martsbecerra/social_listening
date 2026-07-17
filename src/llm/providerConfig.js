// ==========================================================================
// providerConfig.js — Selección de proveedor/modelo vía .env
// ==========================================================================

const VALID_PROVIDERS = ['anthropic', 'openrouter'];

function normalizeProvider(raw) {
  const p = (raw || 'anthropic').trim().toLowerCase();
  if (p === 'open-router') return 'openrouter';
  return VALID_PROVIDERS.includes(p) ? p : 'anthropic';
}

function getLlmProvider() {
  return normalizeProvider(process.env.LLM_PROVIDER);
}

function getProviderLabel(provider) {
  return provider === 'openrouter' ? 'OpenRouter' : 'Claude';
}

/** Claves requeridas según LLM_PROVIDER activo. */
function requiredLlmEnvKeys(provider = getLlmProvider()) {
  if (provider === 'openrouter') return ['OPENROUTER_API_KEY'];
  return ['ANTHROPIC_API_KEY'];
}

module.exports = {
  getLlmProvider,
  getProviderLabel,
  requiredLlmEnvKeys,
  VALID_PROVIDERS,
};
