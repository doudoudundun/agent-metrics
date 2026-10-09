import { afterEach, describe, expect, it, vi } from "vitest";
import { runIsolatedSourceRefreshTasks, startSourceLightRefreshLoop } from "./source-light-refresh.js";

describe("source light refresh loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs light ticks and periodically requests full reconcile", async () => {
    vi.useFakeTimers();
    const ticks: boolean[] = [];
    const handle = startSourceLightRefreshLoop(
      async ({ reconcileRecent }) => {
        ticks.push(reconcileRecent);
      },
      { intervalMs: 5_000, fullReconcileEveryTicks: 3 }
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(ticks).toEqual([false]);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(ticks).toEqual([false, false, true]);

    handle.stop();
  });

  it("skips overlapping ticks while one is in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const handle = startSourceLightRefreshLoop(
      async () => {
        started += 1;
        await gate;
      },
      { intervalMs: 5_000, fullReconcileEveryTicks: 10 }
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(started).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(started).toBe(1);

    release();
    await Promise.resolve();
    handle.stop();
  });

  it("keeps later sources running when one light-refresh adapter fails", async () => {
    const succeeded: string[] = [];
    const warnings: string[] = [];

    await runIsolatedSourceRefreshTasks(
      [
        {
          id: "zcode-db@zcode:default",
          run: async () => {
            throw new Error("too many SQL variables");
          }
        },
        {
          id: "kimicode-wire@kimicode:default",
          run: async () => undefined
        }
      ],
      {
        log: {
          warn: (message) => {
            warnings.push(message);
          }
        },
        onSuccess: (id) => {
          succeeded.push(id);
        }
      }
    );

    expect(succeeded).toEqual(["kimicode-wire@kimicode:default"]);
    expect(warnings).toEqual([
      expect.stringContaining("zcode-db@zcode:default")
    ]);
  });
});
