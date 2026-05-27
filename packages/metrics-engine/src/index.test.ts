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
      codeEdits: [
        {
          files_changed: ["src/app.ts", "src/index.ts"],
          file_count: 2,
          insertions: 12,
          deletions: 4,
          edit_operation_count: 1
        }
      ]
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

  it("dedupes repeated files across multiple edit events", () => {
    const overview = buildOverviewMetrics({
      sessions: [{ session_id: "ses_1" }],
      toolEvents: [],
      codeEdits: [
        {
          files_changed: ["src/shared.ts", "src/one.ts"],
          file_count: 2,
          insertions: 3,
          deletions: 1,
          edit_operation_count: 1
        },
        {
          files_changed: ["src/shared.ts", "src/two.ts"],
          file_count: 2,
          insertions: 5,
          deletions: 2,
          edit_operation_count: 1
        }
      ]
    });

    expect(overview.affectedFileCount).toBe(3);
    expect(overview.editOperationCount).toBe(2);
    expect(overview.insertions).toBe(8);
    expect(overview.deletions).toBe(3);
  });
});
