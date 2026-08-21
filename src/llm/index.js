// ==========================================================================
// llm/index.js — Punto único para structured analysis según LLM_PROVIDER.
// ==========================================================================

const { getLlmProvider } = require('./providerConfig');
const anthropic = require('./anthropicProvider');
const openrouter = require('./openrouterProvider');
const { finalizeLlmUsage } = require('./estimateCost');

async function requestStructuredAnalysis({ system, userPrompt }) {
  const provider = getLlmProvider();
  let result;
  if (provider === 'openrouter') {
    result = await openrouter.requestStructuredAnalysis({ system, userPrompt });
    result.usage = finalizeLlmUsage(result.usage, {
      provider,
      model: process.env.OPENROUTER_MODEL,
    });
  } else {
    result = await anthropic.requestStructuredAnalysis({ system, userPrompt });
    result.usage = finalizeLlmUsage(result.usage, {
      provider,
      model: process.env.CLAUDE_MODEL,
    });
  }
  return result;
}

module.exports = { requestStructuredAnalysis };
