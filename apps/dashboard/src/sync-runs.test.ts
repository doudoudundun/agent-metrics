import { describe, expect, it, vi } from "vitest";
import type { ManualSyncResponse, SyncRunResponse } from "./api";
import { waitForSyncRuns } from "./sync-runs";

describe("waitForSyncRuns", () => {
  it("polls every accepted run until all runs are terminal", async () => {
    const firstRun = buildRun("run-first", "syncing");
    const secondRun = buildRun("run-second", "queued");
    const fetchRun = vi
      .fn<(runId: string) => Promise<SyncRunResponse>>()
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(secondRun)
      .mockResolvedValueOnce(buildRun("run-first", "succeeded"))
      .mockResolvedValueOnce(buildRun("run-second", "failed"));
    const wait = vi.fn(async () => undefined);

    const result = await waitForSyncRuns(
      buildAcceptedRuns("run-first", "run-second"),
      fetchRun,
      { wait }
    );

    expect(wait).toHaveBeenCalledTimes(1);
    expect(fetchRun.mock.calls.map(([runId]) => runId)).toEqual([
      "run-first",
      "run-second",
      "run-first",
      "run-second"
    ]);
    expect(result.map((run) => run.status)).toEqual(["succeeded", "failed"]);
  });

  it("stops before polling when the caller has cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchRun = vi.fn<(runId: string) => Promise<SyncRunResponse>>();

    await expect(
      waitForSyncRuns(buildAcceptedRuns("run-cancelled"), fetchRun, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchRun).not.toHaveBeenCalled();
  });
});

function buildAcceptedRuns(...runIds: string[]): ManualSyncResponse["runs"] {
  return runIds.map((runId) => ({
    adapterInstanceId: `adapter-${runId}`,
    runId,
    disposition: "started" as const
  }));
}

function buildRun(
  runId: string,
  status: SyncRunResponse["status"]
): SyncRunResponse {
  const terminal = status === "succeeded" || status === "failed" || status === "aborted";
  return {
    runId,
    adapterInstanceId: `adapter-${runId}`,
    status,
    acceptedAt: "2026-07-22T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-07-22T00:00:01.000Z",
    completedAt: terminal ? "2026-07-22T00:00:02.000Z" : null,
    discoveredRecords: 0,
    committedUniqueEvents: 0,
    projectedUniqueEvents: 0,
    projectionWatermark: null,
    error: status === "failed" ? { code: "SYNC_FAILED", summary: "Fixture failure" } : null
  };
}
