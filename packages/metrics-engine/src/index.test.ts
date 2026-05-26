import { describe, expect, it } from "vitest";
import { buildOverviewMetrics } from "./index.js";

describe("buildOverviewMetrics", () => {
  it("calculates overview counters and success rate", () => {
    const overview = buildOverviewMetrics({
      sessions: [{ session_id: "ses_1" }],
      toolEvents: [
        { status: "succeeded", duration_ms: 10 },
        { status: "failed", duration_ms: 30 }
      ],
      codeEdits: [{ file_count: 2, insertions: 12, deletions: 4, edit_operation_count: 1 }]
    });

    expect(overview).toEqual({
      sessionCount: 1,
      totalToolCalls: 2,
      successfulExecutions: 1,
      failedExecutions: 1,
      successRate: 0.5,
      editOperationCount: 1,
      affectedFileCount: 2,
      insertions: 12,
      deletions: 4
    });
  });

  it("returns zeroed ratios and counters when there is no activity", () => {
    const overview = buildOverviewMetrics({
      sessions: [],
      toolEvents: [],
      codeEdits: []
    });

    expect(overview).toEqual({
      sessionCount: 0,
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0
    });
  });
});
