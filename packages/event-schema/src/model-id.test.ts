import { describe, expect, it } from "vitest";
import { resolveUsageMode } from "./model-id.js";

describe("resolveUsageMode", () => {
  it("uses explicit tiers and named fast variants, defaulting unmarked usage to standard", () => {
    expect(resolveUsageMode("gpt-6-sol", "priority")).toBe("fast");
    expect(resolveUsageMode("gpt-6.1-sol", "ultrafast")).toBe("ultrafast");
    expect(resolveUsageMode("mimo-v2.6-pro-ultraspeed")).toBe("fast");
    expect(resolveUsageMode("kimi-k2.7-code-highspeed")).toBe("fast");
    expect(resolveUsageMode("gpt-6-sol", "auto")).toBe("unknown");
    expect(resolveUsageMode("claude-opus-4-6", "fast")).toBe("fast");
    expect(resolveUsageMode("gpt-6-sol", "default")).toBe("standard");
    expect(resolveUsageMode("cursor-grok-4.7-high-fast;")).toBe("fast");
    expect(resolveUsageMode("gpt-6-luna")).toBe("standard");
    expect(resolveUsageMode("gemini-flash")).toBe("standard");
    expect(resolveUsageMode("breakfast-model")).toBe("standard");
    expect(resolveUsageMode("gpt-6.1-sol", null)).toBe("standard");
    expect(resolveUsageMode("gpt-6.1-sol", "  ")).toBe("standard");
  });

  it("keeps T3 thinking tiers and Antigravity routing ids on standard accounting", () => {
    expect(resolveUsageMode("gemini-4-neon-xhigh")).toBe("standard");
    expect(resolveUsageMode("gemini-4-hydrogen-tiered-high")).toBe("standard");
    expect(resolveUsageMode("gemini-3.8-flash-low")).toBe("standard");
    expect(resolveUsageMode("gemini-pro-orchestrator-neon")).toBe("standard");
    expect(resolveUsageMode("gemini-flash-worker-agy")).toBe("standard");
    expect(resolveUsageMode("antigravity-default")).toBe("standard");
  });

  it("keeps Claude/GPT effort suffixes standard", () => {
    expect(resolveUsageMode("claude-opus-4-6-high")).toBe("standard");
    expect(resolveUsageMode("claude-sonnet-4-6-medium")).toBe("standard");
    expect(resolveUsageMode("gpt-6-sol-low")).toBe("standard");
    expect(resolveUsageMode("gpt-6.1-sol-xhigh")).toBe("standard");
  });

  it("does not treat runtime permission labels as model speed suffixes", () => {
    expect(resolveUsageMode("gemini-4-neon-bypass-permissions")).toBe("standard");
    expect(resolveUsageMode("gemini-flash-worker-agy-accept-edits")).toBe("standard");
    expect(resolveUsageMode("gemini-4-hydrogen-plan-mode")).toBe("standard");
  });
});
