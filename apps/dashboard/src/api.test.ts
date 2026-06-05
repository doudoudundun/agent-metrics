import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOverview,
  buildExportUrl,
  fetchSessionDetail,
  fetchSessions,
  fetchTools,
  resolveApiPath,
  type OverviewResponse,
  type SessionDetailResponse
} from "./api";

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
    window.history.replaceState({}, "", "/");
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
      tokensByModel: [],
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      sourceBreakdown: [],
      providerBreakdown: []
    });

    await fetchOverview({ mode: "rolling", range: "week" });

    expect(fetch).toHaveBeenCalledWith("/api/overview?mode=rolling&range=week&sourceVendor=all");
  });

  it("uses the desktop apiBase query parameter when present", () => {
    const desktopWindow = {
      location: {
        search: "?surface=desktop-main&apiBase=http%3A%2F%2F127.0.0.1%3A45183"
      }
    } as Window;

    expect(resolveApiPath("/api/overview", desktopWindow)).toBe(
      "http://127.0.0.1:45183/api/overview"
    );
  });

  it("resolves the desktop apiBase when orb peek mode is active", () => {
    const desktopWindow = {
      location: {
        search: "?surface=desktop-orb-peek&apiBase=http%3A%2F%2F127.0.0.1%3A45183"
      }
    } as Window;

    expect(resolveApiPath("/api/overview", desktopWindow)).toBe(
      "http://127.0.0.1:45183/api/overview"
    );
  });

  it("builds export URLs against the desktop apiBase query parameter", () => {
    window.history.replaceState(
      {},
      "",
      "/?surface=desktop-main&apiBase=http%3A%2F%2F127.0.0.1%3A45183"
    );

    expect(buildExportUrl("csv")).toBe("http://127.0.0.1:45183/api/exports/csv");
  });

  it("appends sourceVendor to aggregate requests", async () => {
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
      tokensByModel: [],
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      sourceBreakdown: [],
      providerBreakdown: []
    });

    await fetchOverview({ mode: "rolling", range: "week" }, "codex");

    expect(fetch).toHaveBeenCalledWith("/api/overview?mode=rolling&range=week&sourceVendor=codex");
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
      tokensByModel: [
        {
          model: "gpt-5-codex",
          totalTokens: 30000,
          inputTokens: 15000,
          outputTokens: 12000,
          cacheReadTokens: 2000,
          cacheCreationTokens: 1000
        }
      ],
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8,
      sourceBreakdown: [
        {
          sourceVendor: "claude-code",
          sessionCount: 3,
          turnCount: 24,
          totalTokens: 45678,
          toolCalls: 12
        }
      ],
      providerBreakdown: [
        {
          providerHost: null,
          providerId: null,
          totalTokens: 45678
        }
      ]
    };

    stubFetchJson(payload);
    await expect(fetchOverview()).resolves.toEqual(payload);
  });

  it("normalizes legacy overview payloads that omit token metrics", async () => {
    stubFetchJson({
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: 3,
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8,
      sourceBreakdown: [],
      providerBreakdown: []
    });

    await expect(fetchOverview()).resolves.toEqual({
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: 3,
      turnCount: 0,
      responseCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokensByModel: [],
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8,
      sourceBreakdown: [],
      providerBreakdown: []
    });
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
        sourceVendor: "claude-code",
        sourceAdapter: "claude-transcript",
        providerId: null,
        providerHost: null,
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
        sourceVendor: "claude-code",
        sourceAdapter: "claude-transcript",
        providerId: null,
        providerHost: null,
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
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          providerId: null,
          providerHost: null,
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

  it("returns transcript-enriched session detail payloads", async () => {
    const payload: SessionDetailResponse = {
      sessionId: "ses_1",
      workspacePath: "/Users/test/dev/agent-metrics",
      sourceVendor: "claude-code",
      sourceAdapter: "claude-transcript",
      context: {
        executionPath: "/Users/test/dev/agent-metrics/.claude/tmp",
        skillsLoaded: true,
        skillNames: ["commit-analyzer"]
      },
      timeline: [
        {
          type: "prompt.submitted",
          createdAt: "2026-05-27T10:00:00.000Z",
          toolName: "",
          status: "submitted",
          durationMs: 0,
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          promptId: "prompt_1",
          promptChars: 24,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        },
        {
          type: "token.usage.recorded",
          createdAt: "2026-05-27T10:00:01.000Z",
          toolName: "",
          status: "recorded",
          durationMs: 0,
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          messageId: "msg_1",
          model: "unknown",
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheCreationTokens: 0,
          totalTokens: 15,
          usageSource: "claude-transcript",
          promptId: null,
          promptChars: null,
          stopReason: null,
          responseChars: null
        }
      ]
    };

    stubFetchJson(payload);
    await expect(fetchSessionDetail("ses_1")).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith("/api/sessions/ses_1");
  });
});
