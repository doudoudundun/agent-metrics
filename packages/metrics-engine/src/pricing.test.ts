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
