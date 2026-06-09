import { afterEach, describe, expect, it, vi } from "vitest";

const { parseRawHooksOnce } = vi.hoisted(() => ({
  parseRawHooksOnce: vi.fn()
}));

vi.mock("./parser.js", () => ({
  parseRawHooksOnce
}));

import { followRawHooks } from "./follow.js";

describe("followRawHooks", () => {
  afterEach(() => {
    parseRawHooksOnce.mockReset();
    vi.useRealTimers();
  });

  it("keeps polling after a transient parser failure", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();

    parseRawHooksOnce
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockImplementationOnce(async () => {
        abortController.abort();
      });

    const followPromise = followRawHooks({
      repoRoot: "D:/agent-metrics-data",
      pollIntervalMs: 10,
      signal: abortController.signal
    });

    await vi.runOnlyPendingTimersAsync();
    await followPromise;

    expect(parseRawHooksOnce).toHaveBeenCalledTimes(2);
  });
});
