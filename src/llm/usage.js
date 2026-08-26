// Normaliza contadores de tokens entre proveedores y suma reintentos.

/**
 * @typedef {{ inputTokens: number, outputTokens: number, totalTokens: number, costUsd?: number | null, costSource?: string | null }} TokenUsage
 */

/**
 * @param {TokenUsage | null | undefined} a
 * @param {TokenUsage | null | undefined} b
 * @returns {TokenUsage}
 */
function addTokenUsage(a, b) {
  const inA = a?.inputTokens ?? 0;
  const outA = a?.outputTokens ?? 0;
  const inB = b?.inputTokens ?? 0;
  const outB = b?.outputTokens ?? 0;
  const inputTokens = inA + inB;
  const outputTokens = outA + outB;
  const costA = a?.costUsd;
  const costB = b?.costUsd;
  const hasCost = costA != null || costB != null;
  const costUsd = hasCost ? (Number(costA) || 0) + (Number(costB) || 0) : undefined;
  const costSource =
    a?.costSource === 'openrouter' || b?.costSource === 'openrouter'
      ? 'openrouter'
      : a?.costSource || b?.costSource;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(hasCost ? { costUsd, costSource } : {}),
  };
}

/** @param {{ input_tokens?: number, output_tokens?: number } | null | undefined} usage */
function fromAnthropicUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, cost?: number, total_cost?: number } | null | undefined} usage */
function fromOpenRouterUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;
  const totalTokens =
    Number.isFinite(Number(usage.total_tokens)) && Number(usage.total_tokens) > 0
      ? Number(usage.total_tokens)
      : inputTokens + outputTokens;

  const costRaw = usage.cost ?? usage.total_cost;
  const costNum = Number(costRaw);
  const costUsd = Number.isFinite(costNum) ? costNum : undefined;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costUsd != null ? { costUsd, costSource: 'openrouter' } : {}),
  };
}

module.exports = { addTokenUsage, fromAnthropicUsage, fromOpenRouterUsage };
