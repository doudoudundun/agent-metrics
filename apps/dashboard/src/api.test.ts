import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOverview, fetchSessions, fetchTools, type OverviewResponse } from "./api";

function stubFetchJson(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => payload
    }))
  );
}

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends scope parameters to aggregate requests", async () => {
    stubFetchJson({
      mode: "rolling",
      range: "week",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-20T10:30:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: 0,
      turnCount: 0,
      responseCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0
    });

    await fetchOverview({ mode: "rolling", range: "week" });

    expect(fetch).toHaveBeenCalledWith("/api/overview?mode=rolling&range=week");
  });

  it("accepts token-aware overview payloads", async () => {
    const payload: OverviewResponse = {
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: 3,
      turnCount: 24,
      responseCount: 12,
      totalTokens: 45678,
      inputTokens: 22345,
      outputTokens: 19876,
      cacheReadTokens: 2345,
      cacheCreationTokens: 1112,
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8
    };

    stubFetchJson(payload);
    await expect(fetchOverview()).resolves.toEqual(payload);
  });

  it("returns scoped tool envelopes", async () => {
    const rows = [{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }];
    const scopeMeta = {
      mode: "calendar" as const,
      range: "day" as const,
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    };

    stubFetchJson({ rows, ...scopeMeta });
    await expect(fetchTools()).resolves.toEqual({ rows, ...scopeMeta });
  });

  it("rejects legacy tool arrays that omit scoped metadata", async () => {
    const rows = [{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }];

    stubFetchJson(rows);
    await expect(fetchTools()).rejects.toThrow(
      "Request failed: scoped aggregate metadata missing for /api/tools"
    );
  });

  it("rejects malformed tool envelopes that do not match the aggregate metadata contract", async () => {
    stubFetchJson({
      rows: [{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }],
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: 123,
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });

    await expect(fetchTools()).rejects.toThrow(
      "Request failed: scoped aggregate metadata missing for /api/tools"
    );
  });

  it("rejects tool envelopes with an invalid timezone identifier", async () => {
    stubFetchJson({
      rows: [{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }],
      mode: "calendar",
      range: "day",
      timezone: "Mars/Olympus",
      windowStart: "2026-05-26T10:30:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });

    await expect(fetchTools()).rejects.toThrow(
      "Request failed: scoped aggregate metadata missing for /api/tools"
    );
  });

  it("returns scoped session envelopes", async () => {
    const rows = [
      {
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        turnCount: 9,
        totalTokens: 3210,
        lastModel: null
      }
    ];
    const scopeMeta = {
      mode: "calendar" as const,
      range: "day" as const,
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    };

    stubFetchJson({ rows, ...scopeMeta });
    await expect(fetchSessions()).resolves.toEqual({ rows, ...scopeMeta });
  });

  it("rejects legacy session arrays that omit scoped metadata", async () => {
    const rows = [
      {
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        turnCount: 9,
        totalTokens: 3210,
        lastModel: null
      }
    ];

    stubFetchJson(rows);
    await expect(fetchSessions()).rejects.toThrow(
      "Request failed: scoped aggregate metadata missing for /api/sessions"
    );
  });

  it("rejects malformed session envelopes with invalid scope values", async () => {
    stubFetchJson({
      rows: [
        {
          sessionId: "ses_1",
          workspacePath: "D:/projects/dev/agent-metrics",
          turnCount: 9,
          totalTokens: 3210,
          lastModel: null
        }
      ],
      mode: "custom",
      range: "year",
      timezone: "Asia/Shanghai",
      windowStart: null,
      windowEnd: null,
      updatedAt: "2026-05-27T10:30:00.000Z"
    });

    await expect(fetchSessions()).rejects.toThrow(
      "Request failed: scoped aggregate metadata missing for /api/sessions"
    );
  });

  it("rejects session envelopes with invalid timestamp strings", async () => {
    stubFetchJson({
      rows: [
        {
          sessionId: "ses_1",
          workspacePath: "D:/projects/dev/agent-metrics",
          turnCount: 9,
          totalTokens: 3210,
          lastModel: null
        }
      ],
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "not-a-date",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "still-not-a-date"
    });

    await expect(fetchSessions()).rejects.toThrow(
      "Request failed: scoped aggregate metadata missing for /api/sessions"
    );
  });
});
