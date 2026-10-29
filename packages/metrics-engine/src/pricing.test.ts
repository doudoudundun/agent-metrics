import { describe, expect, it } from "vitest";

import { estimateCostUsd } from "./pricing.js";

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
};

describe("estimateCostUsd", () => {
  it("prices the recorded Cursor Grok 4.6 high-fast model at Fast rates", () => {
    expect(estimateCostUsd({
      model: "cursor-grok-4.6-high-fast",
      inputTokens: 83_722,
      outputTokens: 5_823,
      cacheReadTokens: 236_032,
      cacheCreationTokens: 0
    })).toBeCloseTo(0.640796, 9);
  });

  it("prices Cursor's grok-4.6-high effort variant at the standard grok-4.6 rate", () => {
    expect(estimateCostUsd({ ...USAGE, model: "cursor-grok-4.6-high" })).toBe(8);
  });

  it.each([
    ["kimi-code/k3.1-pro", 14.2],
    ["k3.1-pro", 14.2],
    ["kimi-code/k3.1-pro-highspeed", 28.2],
    ["k3.1-pro-highspeed", 28.2]
  ])("prices Kimi Code model ID %s", (model, expected) => {
    expect(estimateCostUsd({
      ...USAGE,
      model,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    })).toBeCloseTo(expected, 9);
  });

  it.each([
    ["kimi-k3.1-pro", 14.2],
    ["kimi-k3.1-pro-highspeed", 28.2]
  ])("prices %s with separate cache read and write rates", (model, expected) => {
    expect(estimateCostUsd({
      ...USAGE,
      model: `moonshotai/${model}`,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    })).toBeCloseTo(expected, 9);
  });

  it.each([
    ["claude-fable-5-1", 72.75],
    ["claude-mythos-5-1", 72.75],
    ["claude-fable-5", 73.5],
    ["claude-mythos-5", 73.5],
    ["claude-opus-5", 36.75],
    ["gemini-4-argon", 12.1],
    ["gemini-3.8-flash", 4.575],
    ["gemini-3.6-flash", 4.575],
    ["mistral-large-4", 5.68],
    ["zai-glm-5-3-flash", 0.68]
  ])("prices new model %s including cache tokens", (model, expected) => {
    expect(estimateCostUsd({
      ...USAGE,
      model,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    })).toBeCloseTo(expected, 9);
  });

  it("prices GPT-6.1 Terra input, output, cache read, and cache write", () => {
    expect(estimateCostUsd({
      ...USAGE,
      model: "openai/gpt-6.1-terra",
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    })).toBeCloseTo(7.3, 9);
  });

  it("strips the OpenRouter-style provider prefix before lookup", () => {
    const prefixed = estimateCostUsd({ ...USAGE, model: "传音/deepseek-v4.1-flash" });
    const bare = estimateCostUsd({ ...USAGE, model: "deepseek-v4.1-flash" });

    expect(bare).not.toBeNull();
    expect(prefixed).toBe(bare);
  });

  it("falls back to the bare id for provider-prefixed free models", () => {
    const prefixed = estimateCostUsd({ ...USAGE, model: "vendor/big-pickle" });

    expect(prefixed).toBe(0);
  });

  it("prices kimi-k3 alias k3-256k", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/k3-256k" })).toBe(18);
  });

  it("prices cursor's grok-4.7-high effort variant at grok-4.7 rates", () => {
    expect(estimateCostUsd({ ...USAGE, model: "grok-4.7-high" })).toBe(8);
  });

  it("prices cursor's grok-4.7 fast tier at double the standard rate", () => {
    expect(
      estimateCostUsd({
        ...USAGE,
        model: "grok-4.7-high-fast",
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000
      })
    ).toBeCloseTo(17, 9);
  });

  it("prices cursor's composer-2.5 fast tier at its own published card", () => {
    const fast = estimateCostUsd({
      ...USAGE,
      model: "composer-2.5-fast",
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    });
    const standard = estimateCostUsd({
      ...USAGE,
      model: "composer-2.5",
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    });

    expect(fast).toBeCloseTo(18.5, 9);
    expect(standard).toBeCloseTo(3.2, 9);
  });

  it("prices cursor's opus-5 thinking variant at the base Opus 5 card", () => {
    const thinking = estimateCostUsd({
      ...USAGE,
      model: "claude-opus-5-thinking-high",
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    });

    expect(thinking).toBeCloseTo(36.75, 9);
    expect(thinking).toBe(
      estimateCostUsd({
        ...USAGE,
        model: "claude-opus-5",
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000
      })
    );
  });

  it("prices Xiaomi Token Plan prefixed mimo v2.6 models", () => {
    expect(estimateCostUsd({ ...USAGE, model: "Xiaomi Token Plan/mimo-v2.6-pro" })).toBeCloseTo(1.305, 6);
    expect(estimateCostUsd({ ...USAGE, model: "mimo-v2.6-flash" })).toBeCloseTo(0.42, 6);
  });

  it("prices the MiMo Desktop alias mimo-pro at mimo-v2.6-pro rates", () => {
    const alias = estimateCostUsd({ ...USAGE, model: "mimo-pro" });
    const canonical = estimateCostUsd({ ...USAGE, model: "mimo-v2.6-pro" });

    expect(alias).toBeCloseTo(1.305, 6);
    expect(alias).toBe(canonical);
  });

  it("prices kimi-for-coding at the kimi-k2.8-preview reference rate", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/kimi-for-coding" })).toBeCloseTo(5, 6);
  });

  it("keeps kimi-for-coding-highspeed at the k2.7-code highspeed rate", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/kimi-for-coding-highspeed" })).toBeCloseTo(9.9, 6);
  });

  it("prices WorkBuddy's kimi-k3-2 at the kimi-k3 rate", () => {
    const alias = estimateCostUsd({ ...USAGE, model: "kimi-k3-2" });
    const canonical = estimateCostUsd({ ...USAGE, model: "kimi-k3" });

    expect(alias).toBeCloseTo(18, 6);
    expect(alias).toBe(canonical);
  });

  it("prices WorkBuddy's hunyuan rows (CNY converted at 7.194)", () => {
    expect(estimateCostUsd({ ...USAGE, model: "hy4-preview" })).toBeCloseTo(3.335, 6);
    expect(estimateCostUsd({ ...USAGE, model: "hy3" })).toBeCloseTo(0.695, 6);
    expect(
      estimateCostUsd({
        ...USAGE,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 0,
        model: "hy3"
      })
    ).toBeCloseTo(0.035, 6);
  });

  it("prices WorkBuddy's GLM 5.0 / 4.6 rows", () => {
    expect(estimateCostUsd({ ...USAGE, model: "glm-5.0" })).toBeCloseTo(4.2, 6);
    expect(estimateCostUsd({ ...USAGE, model: "glm-4.6v" })).toBeCloseTo(1.2, 6);
    expect(estimateCostUsd({ ...USAGE, model: "glm-5v-turbo" })).toBeCloseTo(5.2, 6);
  });

  it("bills MiniMax M2.5/M2.7 cache writes from the official card", () => {
    expect(
      estimateCostUsd({
        ...USAGE,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 1_000_000,
        model: "minimax-m2.7"
      })
    ).toBeCloseTo(0.375, 6);
    expect(estimateCostUsd({ ...USAGE, model: "minimax-m2.5" })).toBeCloseTo(1.5, 6);
    // M3 alias shares the <=512K tier with minimax-m3.
    expect(estimateCostUsd({ ...USAGE, model: "minimax-m3-pay" })).toBeCloseTo(
      estimateCostUsd({ ...USAGE, model: "minimax-m3" })!,
      6
    );
  });

  it("prices WorkBuddy's kimi-k2.6 at platform.kimi.ai rates", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-k2.6" })).toBeCloseTo(4.95, 6);
    expect(estimateCostUsd({ ...USAGE, model: "kimi-k2.7" })).toBeCloseTo(4.95, 6);
  });

  it("returns null for models without a published list price", () => {
    expect(estimateCostUsd({ ...USAGE, model: "mimo/mimo-auto" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: "hunyuan-chat" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: "default" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: "unknown" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: null })).toBeNull();
  });
});

describe("estimateCostUsd service tiers", () => {
  it("bills the accelerated tiers at their documented multiples of list price", () => {
    const standard = estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol" })!;

    // OpenAI: fast (ex-"priority") 2x, ultrafast 6x, flex ~0.5x.
    expect(estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: "fast" })).toBeCloseTo(
      standard * 2,
      9
    );
    expect(
      estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: "priority" })
    ).toBeCloseTo(standard * 2, 9);
    expect(
      estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: "ultrafast" })
    ).toBeCloseTo(standard * 6, 9);
    expect(estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: "flex" })).toBeCloseTo(
      standard * 0.5,
      9
    );
  });

  it("applies Claude fast mode to cache rates as well as input and output", () => {
    const cached = { ...USAGE, model: "claude-opus-5-5", cacheReadTokens: 1_000_000 };
    const standard = estimateCostUsd(cached)!;
    const fast = estimateCostUsd({ ...cached, serviceTier: "fast" })!;

    // Opus 5.5 fast mode is $8/$40 against a $4/$20 standard card.
    expect(standard).toBeCloseTo(4 + 20 + 0.2, 9);
    expect(fast).toBeCloseTo(standard * 2, 9);
  });

  it("leaves standard and unknown tiers at list price", () => {
    const standard = estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol" });

    expect(estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: "standard" })).toBe(
      standard
    );
    expect(estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: null })).toBe(standard);
    expect(estimateCostUsd({ ...USAGE, model: "gpt-6.1-sol", serviceTier: "turbo-unknown" })).toBe(
      standard
    );
  });

  it("still returns null when the model is unpriced regardless of tier", () => {
    expect(estimateCostUsd({ ...USAGE, model: "unknown", serviceTier: "fast" })).toBeNull();
  });
});
