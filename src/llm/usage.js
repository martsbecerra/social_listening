// Normaliza contadores de tokens entre proveedores y suma reintentos.

/**
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number } | null | undefined} a
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number } | null | undefined} b
 */
function addTokenUsage(a, b) {
  const inA = a?.inputTokens ?? 0;
  const outA = a?.outputTokens ?? 0;
  const inB = b?.inputTokens ?? 0;
  const outB = b?.outputTokens ?? 0;
  const inputTokens = inA + inB;
  const outputTokens = outA + outB;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** @param {{ input_tokens?: number, output_tokens?: number } | null | undefined} usage */
function fromAnthropicUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } | null | undefined} usage */
function fromOpenRouterUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;
  const totalTokens =
    Number.isFinite(Number(usage.total_tokens)) && Number(usage.total_tokens) > 0
      ? Number(usage.total_tokens)
      : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

module.exports = { addTokenUsage, fromAnthropicUsage, fromOpenRouterUsage };
