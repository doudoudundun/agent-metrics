import { describe, expect, it } from "vitest";
import { UsageSourceSchema } from "./sources.js";
import { USAGE_SOURCE_SEMANTICS } from "./usage.js";

/**
 * Sources whose `input_tokens` is the full prompt size of one request, so the
 * cache read has to be subtracted before the number is shown. Every other
 * source reports a delta and keeps the cache read as a separate counter.
 *
 * The list is deliberately spelled out instead of derived: flipping a source
 * between gross and delta changes what the dashboard shows for every stored
 * row, so it must show up as a reviewable diff rather than a silent edit in
 * the registry.
 */
const GROSS_INPUT_SOURCES = [
  "codebuddy-log",
  "codex-logs",
  "codex-rollout",
  "opencode-message",
  "opencode-step-finish",
  "workbuddy-usage"
];

describe("usage source semantics registry", () => {
  it("covers every declared usage source", () => {
    expect(Object.keys(USAGE_SOURCE_SEMANTICS).sort()).toEqual([...UsageSourceSchema.options].sort());
  });

  it("keeps the gross-input source set explicit", () => {
    const gross = Object.entries(USAGE_SOURCE_SEMANTICS)
      .filter(([, semantics]) => semantics.inputTokenSemantics === "gross")
      .map(([source]) => source)
      .sort();
    expect(gross).toEqual([...GROSS_INPUT_SOURCES].sort());
  });

  it("only marks Cursor composer context as a context snapshot", () => {
    const snapshots = Object.entries(USAGE_SOURCE_SEMANTICS)
      .filter(([, semantics]) => semantics.usageMeasurement === "session-context-snapshot")
      .map(([source]) => source);
    expect(snapshots).toEqual(["cursor-composer-context"]);
  });
});
