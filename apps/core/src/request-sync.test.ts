import { describe, expect, it, vi } from "vitest";
import { createRecentResultAction } from "./request-sync.js";

describe("createRecentResultAction", () => {
  it("coalesces concurrent callers into one execution", async () => {
    let runCount = 0;
    let releaseRun: (() => void) | null = null;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const action = createRecentResultAction(async () => {
      runCount += 1;
      await waitForRelease;
    }, 1500);

    const first = action();
    const second = action();

    expect(runCount).toBe(1);
    releaseRun?.();
    await Promise.all([first, second]);
    expect(runCount).toBe(1);
  });

  it("reuses a recent successful result within the ttl window", async () => {
    vi.useFakeTimers();

    try {
      let runCount = 0;
      const action = createRecentResultAction(async () => {
        runCount += 1;
      }, 1500);

      await action();
      await action();

      expect(runCount).toBe(1);

      vi.advanceTimersByTime(1501);
      await action();

      expect(runCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache failed executions", async () => {
    let runCount = 0;
    const action = createRecentResultAction(async () => {
      runCount += 1;
      throw new Error("sync failed");
    }, 1500);

    await expect(action()).rejects.toThrow("sync failed");
    await expect(action()).rejects.toThrow("sync failed");
    expect(runCount).toBe(2);
  });
});
