import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabaseLike } from "./domain-types.js";
import { startOfficialKeyUsageRefreshLoop } from "./key-usage-refresh.js";

const mockDb = {} as SqliteDatabaseLike;

afterEach(() => {
  vi.useRealTimers();
});

describe("startOfficialKeyUsageRefreshLoop", () => {
  it("runs after the 1.5s initial delay and every 60s by default", async () => {
    vi.useFakeTimers();
    const kimicode = vi.fn().mockResolvedValue(undefined);
    const zcode = vi.fn().mockResolvedValue(undefined);
    const antigravity = vi.fn().mockResolvedValue(undefined);
    let nowMs = 100_000;

    const handle = startOfficialKeyUsageRefreshLoop(mockDb, {
      now: () => nowMs,
      collectors: { kimicode, zcode, antigravity }
    });

    await vi.advanceTimersByTimeAsync(1_499);
    expect(kimicode).not.toHaveBeenCalled();
    expect(zcode).not.toHaveBeenCalled();
    expect(antigravity).not.toHaveBeenCalled();

    nowMs += 1_500;
    await vi.advanceTimersByTimeAsync(1);
    expect(kimicode).toHaveBeenCalledTimes(1);
    expect(zcode).toHaveBeenCalledTimes(1);
    expect(antigravity).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kimicode).toHaveBeenCalledTimes(2);
    expect(zcode).toHaveBeenCalledTimes(2);
    expect(antigravity).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("isolates failures per vendor without starving other collectors", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const kimicode = vi.fn().mockRejectedValue(new Error("kimicode boom"));
    const zcode = vi.fn().mockResolvedValue(undefined);
    const antigravity = vi.fn().mockResolvedValue(undefined);

    const handle = startOfficialKeyUsageRefreshLoop(mockDb, {
      collectors: { kimicode, zcode, antigravity },
      log: { warn }
    });

    await vi.advanceTimersByTimeAsync(1_500);

    expect(kimicode).toHaveBeenCalledTimes(1);
    expect(zcode).toHaveBeenCalledTimes(1);
    expect(antigravity).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("kimicode key usage refresh failed: kimicode boom");

    handle.stop();
  });

  it("enforces cooldown for non-forced triggers and bypasses it when force is true", async () => {
    vi.useFakeTimers();
    const kimicode = vi.fn().mockResolvedValue(undefined);
    const zcode = vi.fn().mockResolvedValue(undefined);
    const antigravity = vi.fn().mockResolvedValue(undefined);
    let nowMs = 1_000_000;

    const handle = startOfficialKeyUsageRefreshLoop(mockDb, {
      initialDelayMs: 60_000,
      minTriggerIntervalMs: 15_000,
      now: () => nowMs,
      collectors: { kimicode, zcode, antigravity }
    });

    await handle.triggerNow({ vendor: "antigravity" });
    expect(antigravity).toHaveBeenCalledTimes(1);
    expect(kimicode).not.toHaveBeenCalled();
    expect(zcode).not.toHaveBeenCalled();

    nowMs += 5_000;
    await handle.triggerNow({ vendor: "antigravity" });
    expect(antigravity).toHaveBeenCalledTimes(1);

    nowMs += 10_000;
    await handle.triggerNow({ vendor: "antigravity" });
    expect(antigravity).toHaveBeenCalledTimes(2);

    await handle.triggerNow({ force: true, vendor: "antigravity" });
    expect(antigravity).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it("coalesces concurrent triggerNow calls for the same vendor", async () => {
    let resolveCollector: (() => void) | undefined;
    const antigravity = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCollector = resolve;
        })
    );
    const kimicode = vi.fn().mockResolvedValue(undefined);
    const zcode = vi.fn().mockResolvedValue(undefined);

    const handle = startOfficialKeyUsageRefreshLoop(mockDb, {
      initialDelayMs: 60_000,
      collectors: { kimicode, zcode, antigravity }
    });

    const first = handle.triggerNow({ force: true, vendor: "antigravity" });
    const second = handle.triggerNow({ force: true, vendor: "antigravity" });

    expect(antigravity).toHaveBeenCalledTimes(1);

    resolveCollector?.();
    await Promise.all([first, second]);

    handle.stop();
  });

  it("ignores scheduled ticks and triggerNow calls after stop()", async () => {
    vi.useFakeTimers();
    const kimicode = vi.fn().mockResolvedValue(undefined);
    const zcode = vi.fn().mockResolvedValue(undefined);
    const antigravity = vi.fn().mockResolvedValue(undefined);

    const handle = startOfficialKeyUsageRefreshLoop(mockDb, {
      collectors: { kimicode, zcode, antigravity }
    });

    handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    await handle.triggerNow({ force: true });

    expect(kimicode).not.toHaveBeenCalled();
    expect(zcode).not.toHaveBeenCalled();
    expect(antigravity).not.toHaveBeenCalled();
  });
});
