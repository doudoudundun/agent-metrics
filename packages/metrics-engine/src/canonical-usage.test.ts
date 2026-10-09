import { describe, expect, it } from "vitest";
import {
  displayedInputTokens,
  InvalidUsageError,
  isAdditiveUsage,
  toNormalizedUsage,
  totalTokens,
  USAGE_SOURCE_REGISTRY
} from "./index.js";

describe("toNormalizedUsage", () => {
  it("uses explicit V2 semantics when present", () => {
    const usage = toNormalizedUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 20,
      input_token_semantics: "gross",
      usage_measurement: "increment"
    });
    expect(usage).not.toBeNull();
    expect(usage!.inputTokenSemantics).toBe("gross");
    expect(usage!.usageMeasurement).toBe("increment");
  });

  it("derives semantics from usage_source via the registry when V2 fields absent", () => {
    expect(toNormalizedUsage({
      input_tokens: 1,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      usage_source: "claude-transcript"
    })!.inputTokenSemantics).toBe("delta");

    expect(toNormalizedUsage({
      input_tokens: 1,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      usage_source: "opencode-step-finish"
    })!.inputTokenSemantics).toBe("gross");

    expect(toNormalizedUsage({
      input_tokens: 1,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      usage_source: "cursor-composer-context"
    })!.usageMeasurement).toBe("session-context-snapshot");
  });

  it("returns null for unknown usage_source pairs (excluded from aggregates)", () => {
    expect(
      toNormalizedUsage({
        input_tokens: 1,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        usage_source: "not-a-real-source"
      })
    ).toBeNull();
  });
});

describe("USAGE_SOURCE_REGISTRY", () => {
  it("pins the exhaustive spec section 9.5 mapping", () => {
    expect(USAGE_SOURCE_REGISTRY["claude-transcript"]).toEqual({
      inputTokenSemantics: "delta",
      usageMeasurement: "increment"
    });
    expect(USAGE_SOURCE_REGISTRY["opencode-message"].inputTokenSemantics).toBe("gross");
    expect(USAGE_SOURCE_REGISTRY["opencode-step-finish"].inputTokenSemantics).toBe("gross");
    expect(USAGE_SOURCE_REGISTRY["kimicode-usage"].inputTokenSemantics).toBe("delta");
    expect(USAGE_SOURCE_REGISTRY["dsh-usage"].inputTokenSemantics).toBe("delta");
    expect(USAGE_SOURCE_REGISTRY["cursor-generation"].inputTokenSemantics).toBe("delta");
    expect(USAGE_SOURCE_REGISTRY["cursor-composer-context"].usageMeasurement).toBe(
      "session-context-snapshot"
    );
    expect(USAGE_SOURCE_REGISTRY["codex-rollout"].inputTokenSemantics).toBe("gross");
    expect(USAGE_SOURCE_REGISTRY["codex-logs"].inputTokenSemantics).toBe("gross");
  });
});

describe("displayedInputTokens / totalTokens", () => {
  it("returns input as-is for delta semantics", () => {
    const usage = toNormalizedUsage({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4000,
      input_token_semantics: "delta",
      usage_measurement: "increment"
    })!;
    expect(displayedInputTokens(usage)).toBe(1000);
    // total = displayed(1000) + output(500) + cacheRead(4000) + cacheCreation(0) = 5500
    expect(totalTokens(usage)).toBe(5500);
  });

  it("subtracts cache read for gross semantics", () => {
    const usage = toNormalizedUsage({
      input_tokens: 27470,
      output_tokens: 207,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2048,
      input_token_semantics: "gross",
      usage_measurement: "increment"
    })!;
    expect(displayedInputTokens(usage)).toBe(25422);
    // total = 25422 + 207 + 2048 + 0 = 27677
    expect(totalTokens(usage)).toBe(27677);
  });

  it("throws InvalidUsageError when gross cache_read exceeds input", () => {
    const usage = toNormalizedUsage({
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
      input_token_semantics: "gross",
      usage_measurement: "increment"
    })!;
    expect(() => displayedInputTokens(usage)).toThrow(InvalidUsageError);
    expect(() => displayedInputTokens(usage)).toThrow(/smaller than cache-read input/);
  });
});

describe("isAdditiveUsage", () => {
  it("excludes session-context-snapshot measurements", () => {
    expect(isAdditiveUsage({ usage_measurement: "session-context-snapshot" })).toBe(false);
    expect(isAdditiveUsage({ usage_measurement: "increment" })).toBe(true);
    expect(isAdditiveUsage({ usage_source: "cursor-composer-context" })).toBe(false);
    expect(isAdditiveUsage({ usage_source: "cursor-generation" })).toBe(true);
    expect(isAdditiveUsage({})).toBe(true);
  });
});
