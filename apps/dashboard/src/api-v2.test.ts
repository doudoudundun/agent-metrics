import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOverview, fetchSessionDetail, buildExportUrl } from "./api";

describe("revision 2 API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards caller cancellation to fetch", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) => {
          fetchSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        });
      })
    );
    const controller = new AbortController();
    const request = fetchOverview(undefined, undefined, controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("requests session detail by source instance and session id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          mode: "calendar",
          range: "day",
          timezone: "Asia/Shanghai",
          windowStart: "2026-05-26T16:00:00.000Z",
          windowEnd: "2026-05-27T16:00:00.000Z",
          updatedAt: "2026-05-27T10:30:00.000Z",
          sourceInstanceId: "claude:default",
          sessionId: "ses_1",
          workspacePath: "D:/projects/dev/agent-metrics",
          sourceVendor: "claude-code",
          sourceAdapters: ["claude-transcript"],
          context: { executionPath: null, skillsLoaded: false, skillNames: [] },
          timeline: { rows: [], nextCursor: null }
        })
      }))
    );

    await fetchSessionDetail("claude:default", "ses_1", { mode: "calendar", range: "day" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sources/claude%3Adefault/sessions/ses_1?"),
      expect.any(Object)
    );
  });

  it("builds export URLs with the current scope and source", () => {
    expect(buildExportUrl("csv", { mode: "calendar", range: "week" }, "cursor")).toBe(
      "/api/exports/csv?mode=calendar&range=week&sourceVendor=cursor"
    );
  });
});
