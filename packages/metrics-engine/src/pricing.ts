/**
 * Official list prices in USD per 1M tokens (standard on-demand tier), captured
 * 2026-10-09 from: openai.com, platform.claude.com, docs.z.ai,
 * api-docs.deepseek.com, platform.minimax.io, mimo.mi.com.
 *
 * DeepSeek rows use peak-hour pricing (off-peak is half price), GLM rows the
 * <32K input tier, MiniMax-M3 the <=512K tier at its 50% discount, and Claude
 * cache writes the 5-minute tier. Estimates for reference only, not billing data.
 */

export type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
};

export const MODEL_PRICING_USD: Record<string, ModelPricing> = {
  "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25, cacheWritePer1M: 0 },
  "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5, cacheReadPer1M: 0.075, cacheWritePer1M: 0 },
  "gpt-5.5": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  // Latest OpenAI rows use the short-context tier; long-context sessions cost 2x.
  "gpt-6-astra": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "gpt-6.1-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  "gpt-6-luna": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadPer1M: 0.01, cacheWritePer1M: 0.125 },
  // Promotional price through at least 2026-11-21.
  "gpt-5.6-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
  "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175, cacheWritePer1M: 0 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-5-5": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  "claude-opus-5-5": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 5 },
  // <=100K prompt tier; over 100K is priced higher.
  "claude-haiku-5-5": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadPer1M: 0.01, cacheWritePer1M: 0.125 },
  "glm-5.3": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5.3-flash": { inputPer1M: 0.15, outputPer1M: 0.5, cacheReadPer1M: 0.03, cacheWritePer1M: 0 },
  "glm-5.3-flashx": { inputPer1M: 0.37, outputPer1M: 1.25, cacheReadPer1M: 0.075, cacheWritePer1M: 0 },
  "glm-5.2": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5.1": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5": { inputPer1M: 1, outputPer1M: 3.2, cacheReadPer1M: 0.2, cacheWritePer1M: 0 },
  "glm-4.7": { inputPer1M: 0.6, outputPer1M: 2.2, cacheReadPer1M: 0.11, cacheWritePer1M: 0 },
  "deepseek-v4-flash": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.006,
    cacheWritePer1M: 0
  },
  "deepseek-v4-pro": {
    inputPer1M: 1.32,
    outputPer1M: 3.96,
    cacheReadPer1M: 0.044,
    cacheWritePer1M: 0
  },
  "minimax-m3": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.06, cacheWritePer1M: 0 },
  "mimo-v2.5": { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.0028, cacheWritePer1M: 0 },
  "mimo-v2.5-pro": {
    inputPer1M: 0.435,
    outputPer1M: 0.87,
    cacheReadPer1M: 0.0036,
    cacheWritePer1M: 0
  },
  // Retired; requests are forwarded to mimo-v2.5-pro and billed at its rates.
  "mimo-v2-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cacheReadPer1M: 0.0036, cacheWritePer1M: 0 },
  // Free model served by opencode.
  "big-pickle": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  "deepseek-v4-flash-free": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  "hy3-preview-free": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  "mimo-v2-pro-free": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 }
  // "hy3-preview" (no -free suffix) is intentionally absent: no published list
  // price, so lookups return null.
};

/**
 * Estimate the USD cost of one usage row. `inputTokens` MUST already be the
 * displayed input (gross-semantic sources have cache-read subtracted) because
 * cache reads are priced separately. Returns null when the model has no
 * published price.
 */
export function estimateCostUsd(usage: {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number | null {
  const key = usage.model?.trim().toLowerCase();
  if (!key) {
    return null;
  }

  const pricing = MODEL_PRICING_USD[key];
  if (!pricing) {
    return null;
  }

  return (
    (usage.inputTokens * pricing.inputPer1M +
      usage.outputTokens * pricing.outputPer1M +
      usage.cacheReadTokens * pricing.cacheReadPer1M +
      usage.cacheCreationTokens * pricing.cacheWritePer1M) /
    1e6
  );
}
