import { describe, expect, it } from "vitest";

import { estimateCostUsd } from "./pricing.js";

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
};

describe("estimateCostUsd", () => {
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

  it("prices Xiaomi Token Plan prefixed mimo v2.6 models", () => {
    expect(estimateCostUsd({ ...USAGE, model: "Xiaomi Token Plan/mimo-v2.6-pro" })).toBeCloseTo(1.305, 6);
    expect(estimateCostUsd({ ...USAGE, model: "mimo-v2.6-flash" })).toBeCloseTo(0.42, 6);
  });

  it("prices kimi-for-coding at the kimi-k2.8-preview reference rate", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/kimi-for-coding" })).toBeCloseTo(5, 6);
  });

  it("keeps kimi-for-coding-highspeed at the k2.7-code highspeed rate", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/kimi-for-coding-highspeed" })).toBeCloseTo(9.9, 6);
  });

  it("returns null for models without a published list price", () => {
    expect(estimateCostUsd({ ...USAGE, model: "mimo/mimo-auto" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: "unknown" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: null })).toBeNull();
  });
});
