// ==========================================================================
// llm/index.js — Punto único para structured analysis según LLM_PROVIDER.
// ==========================================================================

const { getLlmProvider } = require('./providerConfig');
const anthropic = require('./anthropicProvider');
const openrouter = require('./openrouterProvider');

async function requestStructuredAnalysis({ system, userPrompt }) {
  const provider = getLlmProvider();
  if (provider === 'openrouter') {
    return openrouter.requestStructuredAnalysis({ system, userPrompt });
  }
  return anthropic.requestStructuredAnalysis({ system, userPrompt });
}

module.exports = { requestStructuredAnalysis };
