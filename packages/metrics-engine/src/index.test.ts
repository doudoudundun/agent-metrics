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
      prompts: [{ prompt_id: "prompt_1" }],
      responses: [{ message_id: "msg_1" }],
      tokenUsage: [
        {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1
        }
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
      turnCount: 1,
      responseCount: 1,
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheCreationTokens: 0,
      affectedFileCount: 2,
      insertions: 12,
      deletions: 4
    });
  });

  it("returns zeroed ratios and counters when there is no activity", () => {
    const overview = buildOverviewMetrics({
      sessions: [],
      toolEvents: [],
      prompts: [],
      responses: [],
      tokenUsage: [],
      codeEdits: []
    });

    expect(overview).toEqual({
      sessionCount: 0,
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      editOperationCount: 0,
      turnCount: 0,
      responseCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0
    });
  });

  it("subtracts cache read tokens from codex input tokens for display", () => {
    const overview = buildOverviewMetrics({
      sessions: [{ session_id: "ses_codex" }],
      toolEvents: [],
      prompts: [],
      responses: [],
      tokenUsage: [
        {
          input_tokens: 15928,
          output_tokens: 202,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 3456,
          source_vendor: "codex"
        }
      ],
      codeEdits: []
    });

    expect(overview.inputTokens).toBe(12472);
    expect(overview.totalTokens).toBe(16130);
  });

  it("dedupes repeated files across multiple edit events", () => {
    const overview = buildOverviewMetrics({
      sessions: [{ session_id: "ses_1" }],
      toolEvents: [],
      prompts: [],
      responses: [],
      tokenUsage: [],
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
