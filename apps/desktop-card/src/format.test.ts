import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCost,
  formatToolCallMeta,
  resolveDisplayedToolCalls,
  toCardViewModel,
  type OverviewMetrics
} from "./format.js";

function sample(overrides: Partial<OverviewMetrics> = {}): OverviewMetrics {
  return {
    totalTokens: 291502786,
    inputTokens: 25609633,
    outputTokens: 1690248,
    cacheReadTokens: 264203000,
    cacheCreationTokens: 905,
    turnCount: 75,
    responseCount: 140,
    totalToolCalls: 3079,
    successfulExecutions: 3058,
    failedExecutions: 21,
    startedOnlyExecutions: 4,
    editOperationCount: 679,
    affectedFileCount: 168,
    insertions: 16879,
    deletions: 1881,
    totalCostUsd: 11.3,
    ...overrides
  };
}

describe("desktop-card format", () => {
  it("formats cost the same way as the dashboard KPI grid", () => {
    assert.equal(formatCost(null), "—");
    assert.equal(formatCost(11.3), "$11.30");
    assert.equal(formatCost(0.0042), "$0.0042");
  });

  it("keeps started-only tool-call totals when they are present", () => {
    const overview = sample();
    assert.equal(resolveDisplayedToolCalls(overview), 3079);
    assert.equal(
      formatToolCallMeta(overview),
      "3,058 ok / 21 failed / 4 started-only"
    );
  });

  it("builds the card view without truncating large token counts", () => {
    const view = toCardViewModel(sample(), true);
    assert.equal(view.totalTokens, "291,502,786");
    assert.equal(view.tokenMeta, "25,609,633 in / 1,690,248 out / 264,203,905 cache");
    assert.equal(view.cost, "$11.30");
    assert.equal(view.edits, "679");
    assert.equal(view.successfulRuns, "3,058");
    assert.equal(view.scopeLabel, "Today");
  });
});
