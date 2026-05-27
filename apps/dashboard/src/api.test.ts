import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSessions, fetchTools } from "./api";

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

  it("returns tool rows from either a scoped envelope or a legacy array", async () => {
    const rows = [{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }];

    stubFetchJson({ rows, mode: "calendar" });
    await expect(fetchTools()).resolves.toEqual(rows);

    stubFetchJson(rows);
    await expect(fetchTools()).resolves.toEqual(rows);
  });

  it("returns session rows from either a scoped envelope or a legacy array", async () => {
    const rows = [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }];

    stubFetchJson({ rows, mode: "calendar" });
    await expect(fetchSessions()).resolves.toEqual(rows);

    stubFetchJson(rows);
    await expect(fetchSessions()).resolves.toEqual(rows);
  });
});
