// Estima costo USD del LLM a partir de tokens (Anthropic / fallback OpenRouter).

/** @param {string} name */
function parseEnvRate(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getRatesFromEnv() {
  const inputPerMTok = parseEnvRate('LLM_INPUT_USD_PER_MTOK');
  const outputPerMTok = parseEnvRate('LLM_OUTPUT_USD_PER_MTOK');
  if (inputPerMTok != null && outputPerMTok != null) {
    return { inputPerMTok, outputPerMTok };
  }
  return null;
}

/** Precios públicos Anthropic (USD por millón de tokens). Revisar periódicamente. */
const ANTHROPIC_RATES = {
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
};

/** @param {string | undefined} model */
function anthropicRatesForModel(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return ANTHROPIC_RATES.haiku;
  if (m.includes('opus')) return ANTHROPIC_RATES.opus;
  return ANTHROPIC_RATES.sonnet;
}

/**
 * @param {{ inputTokens?: number, outputTokens?: number }} tokenUsage
 * @param {{ inputPerMTok: number, outputPerMTok: number }} rates
 */
function estimateCostUsdFromTokens(tokenUsage, rates) {
  const input = tokenUsage?.inputTokens ?? 0;
  const output = tokenUsage?.outputTokens ?? 0;
  return (input * rates.inputPerMTok + output * rates.outputPerMTok) / 1_000_000;
}

/**
 * Completa costUsd/costSource si la API no lo devolvió (p. ej. Anthropic).
 * @param {import('./usage').TokenUsage | null | undefined} usage
 * @param {{ provider: string, model?: string }} ctx
 */
function finalizeLlmUsage(usage, { provider, model }) {
  if (!usage) return null;

  if (usage.costUsd != null && usage.costSource === 'openrouter') {
    return usage;
  }

  const envRates = getRatesFromEnv();
  if (envRates) {
    return {
      ...usage,
      costUsd: estimateCostUsdFromTokens(usage, envRates),
      costSource: 'estimate_env',
    };
  }

  if (provider === 'anthropic') {
    return {
      ...usage,
      costUsd: estimateCostUsdFromTokens(usage, anthropicRatesForModel(model)),
      costSource: 'estimate_anthropic',
    };
  }

  if (usage.costUsd != null) return usage;

  return { ...usage, costUsd: null, costSource: null };
}

module.exports = {
  finalizeLlmUsage,
  estimateCostUsdFromTokens,
  anthropicRatesForModel,
};
