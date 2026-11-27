import { describe, expect, it } from "vitest";

import { resolveUsageMode } from "@agent-metrics/event-schema";

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

  it.each([
    ["gemini-4-neon", 18.15],
    ["gemini-4-carbon", 12.1],
    ["gemini-4-hydrogen", 9.075],
    ["gemini-3.7-flash", 4.575],
    ["gemini-3.1-pro", 14.2],
    ["gemini-3.1-pro-preview", 14.2],
    ["gpt-oss-120b", 0.825],
    ["claude-opus-4-6", 36.75]
  ])("prices Antigravity/T3 base model %s at the 2026-11-23 snapshot card", (model, expected) => {
    expect(estimateCostUsd({
      ...USAGE,
      model,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    })).toBeCloseTo(expected, 9);
  });

  it("prices claude-opus-4-6 standard against its doubled fast-mode card", () => {
    const usage = { ...USAGE, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 };

    expect(estimateCostUsd({ ...usage, model: "claude-opus-4-6" })).toBeCloseTo(36.75, 9);
    expect(estimateCostUsd({ ...usage, model: "claude-opus-4-6", serviceTier: "fast" })).toBeCloseTo(73.5, 9);
  });

  it.each([
    ["gemini-4-neon-low", "gemini-4-neon"],
    ["gemini-4-neon-medium", "gemini-4-neon"],
    ["gemini-4-neon-high", "gemini-4-neon"],
    ["gemini-4-neon-xhigh", "gemini-4-neon"],
    ["gemini-4-carbon-low", "gemini-4-carbon"],
    ["gemini-4-carbon-medium", "gemini-4-carbon"],
    ["gemini-4-carbon-high", "gemini-4-carbon"],
    ["gemini-4-argon-low", "gemini-4-argon"],
    ["gemini-4-argon-medium", "gemini-4-argon"],
    ["gemini-4-argon-high", "gemini-4-argon"],
    ["gemini-4-hydrogen-low", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-medium", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-high", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-tiered-low", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-tiered-medium", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-tiered-high", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-tiered-xhigh", "gemini-4-hydrogen"],
    ["gemini-4-hydrogen-orchestrator", "gemini-4-hydrogen"],
    ["gemini-3.8-flash-low", "gemini-3.8-flash"],
    ["gemini-3.8-flash-medium", "gemini-3.8-flash"],
    ["gemini-3.8-flash-high", "gemini-3.8-flash"],
    ["gemini-3.7-flash-low", "gemini-3.7-flash"],
    ["gemini-3.7-flash-medium", "gemini-3.7-flash"],
    ["gemini-3.7-flash-high", "gemini-3.7-flash"],
    ["gemini-3.6-flash-low", "gemini-3.6-flash"],
    ["gemini-3.6-flash-medium", "gemini-3.6-flash"],
    ["gemini-3.6-flash-high", "gemini-3.6-flash"],
    ["gemini-3.1-pro-low", "gemini-3.1-pro"],
    ["gemini-3.1-pro-medium", "gemini-3.1-pro"],
    ["gemini-3.1-pro-high", "gemini-3.1-pro"],
    ["gemini-pro-agent", "gemini-3.1-pro"],
    ["gpt-oss-120b-low", "gpt-oss-120b"],
    ["gpt-oss-120b-medium", "gpt-oss-120b"],
    ["gpt-oss-120b-high", "gpt-oss-120b"]
  ])("prices T3 thinking tier %s at the %s base card", (variant, base) => {
    const usage = { ...USAGE, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 };

    expect(estimateCostUsd({ ...usage, model: variant })).toBe(
      estimateCostUsd({ ...usage, model: base })
    );
  });

  it("maps ACP transcript planner and executor ids to the served models", () => {
    const usage = { ...USAGE, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 };

    expect(estimateCostUsd({ ...usage, model: "gemini-pro-orchestrator-neon" })).toBeCloseTo(18.15, 9);
    expect(estimateCostUsd({ ...usage, model: "gemini-pro-orchestrator-g1-pro" })).toBeCloseTo(12.1, 9);
    expect(estimateCostUsd({ ...usage, model: "gemini-flash-worker-agy" })).toBeCloseTo(9.075, 9);
  });

  it("keeps T3 thinking tiers and Antigravity role ids out of fast mode", () => {
    expect(resolveUsageMode("gemini-4-neon-xhigh")).toBe("standard");
    expect(resolveUsageMode("gemini-4-hydrogen-tiered-low")).toBe("standard");
    expect(resolveUsageMode("gemini-3.1-pro-high")).toBe("standard");
    expect(resolveUsageMode("gpt-oss-120b-high")).toBe("standard");
    expect(resolveUsageMode("gemini-pro-orchestrator-neon")).toBe("standard");
    expect(resolveUsageMode("gemini-flash-worker-agy")).toBe("standard");
  });

  it("leaves Antigravity's generic router target unpriced", () => {
    expect(estimateCostUsd({ ...USAGE, model: "antigravity-default" })).toBeNull();
  });

  it("prices GPT-6.1 Terra input, output, cache read, and cache write", () => {
    expect(estimateCostUsd({
      ...USAGE,
      model: "openai/gpt-6.1-terra",
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    })).toBeCloseTo(7.3, 9);
  });

  it("prices Codex fast and ultrafast tiers at the verified speed-specific rates", () => {
    const usage = { model: "gpt-6.1-sol", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 };
    expect(estimateCostUsd(usage)).toBeCloseTo(14.6);
    expect(estimateCostUsd({ ...usage, serviceTier: "priority" })).toBeCloseTo(29.2);
    expect(estimateCostUsd({ ...usage, serviceTier: "fast" })).toBeCloseTo(29.2);
    expect(estimateCostUsd({ ...usage, serviceTier: "ultrafast" })).toBeCloseTo(87.6);
    expect(estimateCostUsd({ ...usage, model: "gpt-5.5", serviceTier: "fast", cacheCreationTokens: 0 })).toBeCloseTo(88.75);
  });

  it.each([
    ["gpt-6.2-astra", 58.4, 116.8, 175.2],
    ["gpt-6.2-sol", 14.6, 29.2, 43.8]
  ])("prices GPT-6.2 model %s at Standard, Fast, and launch Ultrafast rates", (model, standard, fast, ultrafast) => {
    const usage = {
      ...USAGE,
      model: `openai/${model}`,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000
    };
    expect(estimateCostUsd(usage)).toBeCloseTo(standard, 9);
    expect(estimateCostUsd({ ...usage, serviceTier: "fast" })).toBeCloseTo(fast, 9);
    expect(estimateCostUsd({ ...usage, serviceTier: "ultrafast" })).toBeCloseTo(ultrafast, 9);
  });

  it("prices Cursor named fast variants once, with their own cache and output rates", () => {
    expect(estimateCostUsd({ ...USAGE, model: "cursor-grok-4.7-high-fast" })).toBe(16);
    expect(estimateCostUsd({ ...USAGE, model: "grok-4.5-fast" })).toBe(22);
    expect(estimateCostUsd({ ...USAGE, model: "cursor-grok-4.5-high-fast" })).toBe(22);
    expect(estimateCostUsd({ ...USAGE, model: "cursor-grok-4.6-high-fast" })).toBe(16);
    expect(estimateCostUsd({ ...USAGE, model: "composer-2.5-fast", serviceTier: "fast" })).toBe(18);
    expect(estimateCostUsd({ ...USAGE, model: "composer-2.5", serviceTier: "fast" })).toBe(18);
    expect(estimateCostUsd({ ...USAGE, model: "provider/cursor-grok-4.6-high", serviceTier: "fast" })).toBe(16);
    expect(estimateCostUsd({ ...USAGE, model: "claude-opus-5-thinking-high", serviceTier: "fast" })).toBe(60);
    expect(estimateCostUsd({ ...USAGE, model: "claude-opus-5-fast", serviceTier: "fast" })).toBe(60);
  });

  it("uses Claude fast rates and leaves unverified fast prices unknown", () => {
    expect(estimateCostUsd({ ...USAGE, model: "claude-opus-5-5", usageMode: "fast" })).toBe(48);
    expect(estimateCostUsd({ ...USAGE, model: "claude-opus-4-8", usageMode: "fast" })).toBe(60);
    expect(estimateCostUsd({ ...USAGE, model: "claude-sonnet-5-5", usageMode: "fast" })).toBeNull();
    expect(estimateCostUsd({ ...USAGE, model: "gpt-6-luna", usageMode: "ultrafast" })).toBeNull();
  });

  it("prices historical semicolon-suffixed model ids", () => {
    expect(estimateCostUsd({ ...USAGE, model: " gpt-6-luna; " }))
      .toBe(estimateCostUsd({ ...USAGE, model: "gpt-6-luna" }));
    expect(estimateCostUsd({ ...USAGE, model: "openai/gpt-6-luna;" }))
      .toBe(estimateCostUsd({ ...USAGE, model: "gpt-6-luna" }));
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

  it("prices Kimi K3.1 Pro from the refreshed upstream rate card", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/k3.1-pro" })).toBeCloseTo(12, 6);
    expect(estimateCostUsd({ ...USAGE, model: "k3.1-pro" })).toBeCloseTo(12, 6);
    expect(
      estimateCostUsd({
        model: "kimi-code/k3.1-pro",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000
      })
    ).toBeCloseTo(14.2, 6);
  });

  it("keeps the K3.1 Pro Highspeed variant on its own doubled rate card", () => {
    expect(estimateCostUsd({ ...USAGE, model: "kimi-code/k3.1-pro-highspeed" })).toBeCloseTo(24, 6);
    expect(estimateCostUsd({ ...USAGE, model: "k3.1-pro-highspeed", serviceTier: "fast" })).toBeCloseTo(24, 6);
    // The highspeed id resolves to fast mode, so it must not inherit a K3 multiplier.
    expect(
      estimateCostUsd({ ...USAGE, model: "kimi-code/k3.1-pro-highspeed", cacheCreationTokens: 1_000_000 })
    ).toBeCloseTo(28, 6);
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

  it("prices the missing Fable/Mythos 5.2, Opus 5.5 Fast, Luna Fast, MiniMax M3.1 and GLM-5.4 cards", () => {
    expect(estimateCostUsd({ ...USAGE, model: "claude-fable-5-2" })).toBeCloseTo(48, 6);
    expect(estimateCostUsd({ ...USAGE, model: "claude-mythos-5-2" })).toBeCloseTo(48, 6);
    expect(estimateCostUsd({ ...USAGE, model: "claude-opus-5-5-fast" })).toBeCloseTo(48, 6);
    expect(estimateCostUsd({ ...USAGE, model: "gpt-5.6-luna-fast" })).toBeCloseTo(2.8, 6);
    expect(estimateCostUsd({ ...USAGE, model: "minimax-m3.1-flash" })).toBeCloseTo(0.75, 6);
    expect(estimateCostUsd({ ...USAGE, model: "glm-5.4" })).toBe(
      estimateCostUsd({ ...USAGE, model: "glm-5.3" })
    );
  });

  it("resolves effort suffixes and Claude 4.6 aliases to the underlying card", () => {
    expect(estimateCostUsd({ ...USAGE, model: "claude-4.6-opus-high" })).toBe(
      estimateCostUsd({ ...USAGE, model: "claude-opus-4-6" })
    );
    expect(estimateCostUsd({ ...USAGE, model: "claude-4-6-sonnet-medium" })).toBe(
      estimateCostUsd({ ...USAGE, model: "claude-sonnet-4-6" })
    );
    expect(estimateCostUsd({ ...USAGE, model: "gpt-5.6-luna-max" })).toBe(
      estimateCostUsd({ ...USAGE, model: "gpt-5.6-luna" })
    );
    expect(estimateCostUsd({ ...USAGE, model: "claude-opus-5-5-high-fast" })).toBe(
      estimateCostUsd({ ...USAGE, model: "claude-opus-5-5-fast" })
    );
    expect(estimateCostUsd({ ...USAGE, model: "claude-4.6-opus-high", serviceTier: "fast" })).toBe(
      estimateCostUsd({ ...USAGE, model: "claude-opus-4-6", serviceTier: "fast" })
    );
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
