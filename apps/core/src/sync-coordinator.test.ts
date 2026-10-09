import { describe, expect, it } from "vitest";
import {
  SyncCoordinator,
  SyncCoordinatorError,
  createSyncCoordinator,
  type SyncAdapter,
  type SyncResult
} from "./sync-coordinator.js";

function result(projectionWatermark = 1): SyncResult {
  return {
    discoveredRecords: 1,
    committedUniqueEvents: 1,
    projectedUniqueEvents: 1,
    projectionWatermark
  };
}

function adapter(
  adapterInstanceId: string,
  sync: SyncAdapter["sync"],
  enabled = true
): SyncAdapter {
  return {
    adapterInstanceId,
    sourceInstanceId: `${adapterInstanceId}:source`,
    sourceAdapter: "claude-transcript",
    sourceVendor: "claude-code",
    enabled,
    sync
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SyncCoordinator", () => {
  it("limits active runs to two and starts queued adapters in FIFO order", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<SyncResult>>>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;

    const makeSync = (id: string): SyncAdapter["sync"] => async () => {
      calls.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<SyncResult>();
      gates.set(id, gate);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    };

    const coordinator = new SyncCoordinator([
      adapter("a", makeSync("a")),
      adapter("b", makeSync("b")),
      adapter("c", makeSync("c")),
      adapter("d", makeSync("d"))
    ], {
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      runId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })()
    });

    expect(coordinator.trigger("a")).toMatchObject({ disposition: "started", runId: "run-1" });
    expect(coordinator.trigger("b")).toMatchObject({ disposition: "started", runId: "run-2" });
    expect(coordinator.trigger("c")).toMatchObject({ disposition: "queued", runId: "run-3" });
    expect(coordinator.trigger("d")).toMatchObject({ disposition: "queued", runId: "run-4" });
    expect(calls).toEqual(["a", "b"]);
    expect(maxActive).toBe(2);

    gates.get("a")?.resolve(result(1));
    await flush();
    expect(calls).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(2);

    gates.get("b")?.resolve(result(2));
    await flush();
    expect(calls).toEqual(["a", "b", "c", "d"]);

    gates.get("c")?.resolve(result(3));
    gates.get("d")?.resolve(result(4));
    await flush();

    expect(coordinator.getRun("run-1")?.status).toBe("succeeded");
    expect(coordinator.getRun("run-4")?.status).toBe("succeeded");
  });

  it("coalesces active and queued triggers for the same adapter", async () => {
    const gate = deferred<SyncResult>();
    let calls = 0;
    const coordinator = createSyncCoordinator({
      adapters: [adapter("a", async () => {
        calls += 1;
        return gate.promise;
      })],
      runId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })()
    });

    const first = coordinator.trigger("a");
    const second = coordinator.trigger("a");

    expect(first).toMatchObject({ disposition: "started", runId: "run-1" });
    expect(second).toEqual({ adapterInstanceId: "a", runId: "run-1", disposition: "coalesced" });
    expect(calls).toBe(1);

    gate.resolve(result());
    await flush();
    expect(coordinator.getStatus("a")?.status).toBe("ready");
  });

  it("coalesces a queued trigger onto the pending run and keeps queued state", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<SyncResult>>>();
    const makeSync = (id: string): SyncAdapter["sync"] => async () => {
      const gate = deferred<SyncResult>();
      gates.set(id, gate);
      return gate.promise;
    };
    const coordinator = new SyncCoordinator([
      adapter("a", makeSync("a")),
      adapter("b", makeSync("b")),
      adapter("c", makeSync("c"))
    ], {
      runId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })()
    });

    coordinator.trigger("a");
    coordinator.trigger("b");
    const queued = coordinator.trigger("c");
    const coalesced = coordinator.trigger("c");

    expect(queued).toEqual({ adapterInstanceId: "c", runId: "run-3", disposition: "queued" });
    expect(coalesced).toEqual({ adapterInstanceId: "c", runId: "run-3", disposition: "coalesced" });
    expect(coordinator.getStatus("c")).toMatchObject({
      status: "queued",
      activeRunId: null,
      pendingRunId: "run-3"
    });

    gates.get("a")?.resolve(result());
    gates.get("b")?.resolve(result());
    await flush();
    expect(coordinator.getStatus("c")?.status).toBe("syncing");
    gates.get("c")?.resolve(result());
    await flush();
  });

  it("initializes disabled adapters as disabled and rejects manual triggers", () => {
    let calls = 0;
    const coordinator = new SyncCoordinator([
      adapter("disabled", async () => {
        calls += 1;
        return result();
      }, false)
    ]);

    expect(coordinator.getStatus("disabled")).toMatchObject({
      status: "disabled",
      activeRunId: null,
      pendingRunId: null
    });
    expect(() => coordinator.trigger("disabled")).toThrowError(SyncCoordinatorError);
    try {
      coordinator.trigger("disabled");
    } catch (error) {
      expect(error).toMatchObject({ code: "ADAPTER_DISABLED" });
    }
    expect(calls).toBe(0);
  });

  it("uses ready after success, stale after a later failure, and error after the first failure", async () => {
    let now = new Date("2026-07-17T00:00:00.000Z");
    let attempt = 0;
    const coordinator = new SyncCoordinator([
      adapter("eventual", async () => {
        attempt += 1;
        if (attempt === 2) {
          throw Object.assign(new Error(`\u001b[31m${"x".repeat(3000)}\u001b[0m`), { code: "adapter_down" });
        }
        return result(12);
      }),
      adapter("never-ready", async () => {
        throw new Error("first failure");
      })
    ], {
      now: () => now,
      runId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })()
    });

    coordinator.trigger("eventual");
    await flush();
    expect(coordinator.getStatus("eventual")).toMatchObject({
      status: "ready",
      consecutiveFailures: 0,
      activeRunId: null,
      pendingRunId: null,
      lastError: null,
      lastSuccessfulAt: "2026-07-17T00:00:00.000Z"
    });

    now = new Date("2026-07-17T00:01:00.000Z");
    coordinator.trigger("eventual");
    coordinator.trigger("never-ready");
    await flush();

    const stale = coordinator.getStatus("eventual");
    expect(stale?.status).toBe("stale");
    expect(stale?.consecutiveFailures).toBe(1);
    expect(stale?.lastError?.code).toBe("SYNC_FAILED");
    expect(stale?.lastError?.summary).not.toContain("\u001b");
    expect(stale?.lastError?.summary.length).toBeLessThanOrEqual(2048);
    expect(coordinator.getStatus("never-ready")).toMatchObject({
      status: "error",
      consecutiveFailures: 1,
      lastSuccessfulAt: null,
      lastError: { code: "SYNC_FAILED", summary: "first failure" }
    });
  });

  it("returns deterministic manual request metadata and exposes status and runs without waiting", async () => {
    const gate = deferred<SyncResult>();
    const coordinator = createSyncCoordinator({
      adapters: [adapter("a", async () => gate.promise)],
      now: () => new Date("2026-07-17T01:02:03.000Z"),
      runId: () => "run-a",
      requestId: () => "request-a"
    });

    const response = coordinator.manualSync("a");
    expect(response).toEqual({
      requestId: "request-a",
      acceptedAt: "2026-07-17T01:02:03.000Z",
      runs: [{ adapterInstanceId: "a", runId: "run-a", disposition: "started" }]
    });
    expect(coordinator.getStatus()).toMatchObject({
      generatedAt: "2026-07-17T01:02:03.000Z",
      shuttingDown: false,
      adapters: [{ adapterInstanceId: "a", status: "syncing", activeRunId: "run-a" }]
    });
    expect(coordinator.getRun("run-a")).toMatchObject({
      runId: "run-a",
      status: "syncing",
      acceptedAt: "2026-07-17T01:02:03.000Z",
      startedAt: "2026-07-17T01:02:03.000Z",
      completedAt: null
    });

    gate.resolve(result(99));
    await flush();
    expect(coordinator.getRun("run-a")?.projectionWatermark).toBe(99);
  });

  it("exposes durable projection watermarks on succeeded runs", async () => {
    const coordinator = createSyncCoordinator({
      adapters: [adapter("a", async () => result(17))],
      runId: () => "run-watermark"
    });

    coordinator.trigger("a");
    await flush();

    expect(coordinator.getRun("run-watermark")).toMatchObject({
      status: "succeeded",
      projectionWatermark: 17
    });
  });

  it("starts initial synchronization without waiting and skips disabled adapters", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<SyncResult>>>();
    const calls: string[] = [];
    const makeSync = (id: string): SyncAdapter["sync"] => async () => {
      calls.push(id);
      const gate = deferred<SyncResult>();
      gates.set(id, gate);
      return gate.promise;
    };
    const coordinator = createSyncCoordinator({
      adapters: [
        adapter("a", makeSync("a")),
        adapter("b", makeSync("b")),
        adapter("disabled", makeSync("disabled"), false)
      ],
      runId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })(),
      requestId: () => "initial-request"
    });

    const response = coordinator.startInitialSync();

    expect(response).toMatchObject({ requestId: "initial-request" });
    expect(response.runs).toHaveLength(2);
    expect(response.runs.every((run) => run.disposition === "started")).toBe(true);
    expect(calls).toEqual(["a", "b"]);
    expect(coordinator.getStatus("a")?.status).toBe("syncing");
    expect(coordinator.getStatus("disabled")?.status).toBe("disabled");

    gates.get("a")?.resolve(result());
    gates.get("b")?.resolve(result());
    await flush();
  });

  it("limits an initial synchronization to the requested adapter instances", async () => {
    const calls: string[] = [];
    const coordinator = createSyncCoordinator({
      adapters: [
        adapter("claude", async () => {
          calls.push("claude");
          return result();
        }),
        adapter("cursor", async () => {
          calls.push("cursor");
          return result();
        })
      ],
      runId: ({ adapterInstanceId }) => `run-${adapterInstanceId}`
    });

    const response = coordinator.startInitialSync(["claude"]);
    await flush();

    expect(response.runs).toEqual([
      expect.objectContaining({ adapterInstanceId: "claude", runId: "run-claude" })
    ]);
    expect(calls).toEqual(["claude"]);
    expect(coordinator.getStatus("cursor")?.status).toBe("idle");
  });

  it("completes one adapter run while another concurrently fails (spec section 24 EC3)", async () => {
    // Two adapters are triggered concurrently. The failing adapter rejects,
    // but the successful adapter must still reach `succeeded` and publish its
    // projection watermark. This locks the isolation guarantee: one adapter
    // failure does not block another instance from completing.
    const failingGate = deferred<SyncResult>();
    const succeedingGate = deferred<SyncResult>();
    const coordinator = new SyncCoordinator(
      [
        adapter("failing", async () => {
          await failingGate.promise;
          throw new Error("adapter exploded");
        }),
        adapter("succeeding", async () => {
          await succeedingGate.promise;
          return result(42);
        })
      ],
      {
        maxConcurrency: 2,
        now: () => new Date("2026-07-17T00:00:00.000Z"),
        runId: (() => {
          let next = 0;
          return () => `run-${++next}`;
        })()
      }
    );

    const failingTrigger = coordinator.trigger("failing");
    const succeedingTrigger = coordinator.trigger("succeeding");
    expect(failingTrigger.disposition).toBe("started");
    expect(succeedingTrigger.disposition).toBe("started");
    await flush();

    // While both are mid-flight, fail the failing adapter first.
    failingGate.reject(new Error("adapter exploded"));
    await flush();
    expect(coordinator.getStatus("failing")).toMatchObject({
      status: "error",
      consecutiveFailures: 1,
      lastError: { code: "SYNC_FAILED", summary: "adapter exploded" }
    });

    // The succeeding adapter is unaffected and completes with its watermark.
    succeedingGate.resolve(result(42));
    await flush();
    expect(coordinator.getStatus("succeeding")).toMatchObject({
      status: "ready",
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessfulAt: "2026-07-17T00:00:00.000Z"
    });
    expect(coordinator.getRun(succeedingTrigger.runId)).toMatchObject({
      status: "succeeded",
      projectionWatermark: 42
    });
  });

  it("aborts queued and active runs on shutdown and rejects new work", async () => {
    const activeSignals: AbortSignal[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const makeSync = (id: string): SyncAdapter["sync"] => ({ signal }) => {
      activeSignals.push(signal);
      const gate = deferred<void>();
      gates.set(id, gate);
      return new Promise<SyncResult>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          gate.resolve();
          reject(new Error("aborted by shutdown"));
        }, { once: true });
        void gate.promise.then(() => resolve(result()));
      });
    };

    const coordinator = new SyncCoordinator([
      adapter("a", makeSync("a")),
      adapter("b", makeSync("b")),
      adapter("c", makeSync("c"))
    ], {
      runId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })()
    });

    coordinator.trigger("a");
    coordinator.trigger("b");
    coordinator.trigger("c");
    await coordinator.shutdown();

    expect(activeSignals).toHaveLength(2);
    expect(activeSignals.every((signal) => signal.aborted)).toBe(true);
    expect(coordinator.getRun("run-1")?.status).toBe("aborted");
    expect(coordinator.getRun("run-2")?.status).toBe("aborted");
    expect(coordinator.getRun("run-3")?.status).toBe("aborted");
    expect(coordinator.getStatus("a")).toMatchObject({
      status: "idle",
      activeRunId: null,
      pendingRunId: null,
      consecutiveFailures: 0
    });
    expect(coordinator.getStatus("c")).toMatchObject({
      status: "idle",
      activeRunId: null,
      pendingRunId: null
    });
    expect(() => coordinator.trigger("a")).toThrowError(SyncCoordinatorError);
    try {
      coordinator.trigger("a");
    } catch (error) {
      expect(error).toMatchObject({ code: "SYNC_SHUTTING_DOWN" });
    }
  });

  it("exposes durable projection watermarks on terminal runs", async () => {
    const coordinator = createSyncCoordinator({
      adapters: [adapter("a", async () => result(42))],
      runId: () => "run-watermark"
    });

    coordinator.trigger("a");
    await flush();

    expect(coordinator.getRun("run-watermark")).toMatchObject({
      status: "succeeded",
      projectionWatermark: 42,
      committedUniqueEvents: 1,
      projectedUniqueEvents: 1
    });
  });

  it("marks ready adapters stale after the freshness window elapses", async () => {
    let now = new Date("2026-07-17T00:00:00.000Z");
    const coordinator = new SyncCoordinator([adapter("a", async () => result())], {
      now: () => now,
      freshnessMs: 5 * 60_000,
      runId: () => "run-freshness"
    });

    coordinator.trigger("a");
    await flush();
    expect(coordinator.getStatus("a")).toMatchObject({ status: "ready" });

    now = new Date("2026-07-17T00:06:00.000Z");
    expect(coordinator.getStatus("a")).toMatchObject({ status: "stale" });
  });

  it("prunes completed runs after the retention window", async () => {
    let nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    const coordinator = new SyncCoordinator([adapter("a", async () => result())], {
      now: () => nowMs,
      runRetentionMs: 60 * 60_000,
      runId: () => "run-retention"
    });

    coordinator.trigger("a");
    await flush();
    expect(coordinator.getRun("run-retention")).not.toBeNull();

    nowMs = Date.parse("2026-07-17T02:00:00.000Z");
    expect(coordinator.getRun("run-retention")).toBeNull();
  });
});
