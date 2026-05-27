import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOverview, fetchSessions, fetchTools } from "./api";

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

  it("returns scoped tool envelopes while accepting legacy arrays", async () => {
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

    stubFetchJson(rows);
    await expect(fetchTools()).resolves.toEqual(expect.objectContaining({ rows }));
  });

  it("returns scoped session envelopes while accepting legacy arrays", async () => {
    const rows = [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }];
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

    stubFetchJson(rows);
    await expect(fetchSessions()).resolves.toEqual(expect.objectContaining({ rows }));
  });
});
