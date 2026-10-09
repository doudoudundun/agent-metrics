import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runDomainMigrations } from "./domain-migrations.js";
import { createSqliteSyncRunStore } from "./sync-run-store.js";
import type { SyncRun } from "./sync-coordinator.js";

function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    runId: "run-1",
    adapterInstanceId: "adapter-1",
    status: "succeeded",
    acceptedAt: "2026-07-17T00:00:00.000Z",
    startedAt: "2026-07-17T00:00:01.000Z",
    completedAt: "2026-07-17T00:00:02.000Z",
    discoveredRecords: 2,
    committedUniqueEvents: 2,
    projectedUniqueEvents: 2,
    projectionWatermark: 8,
    error: null,
    ...overrides
  };
}

describe("sqlite sync run store", () => {
  it("persists terminal runs and converts interrupted runs to aborted on reload", () => {
    const db = new Database(":memory:");
    runDomainMigrations(db);
    const store = createSqliteSyncRunStore(db);

    store.save(run());
    store.save(run({ runId: "run-2", status: "syncing", completedAt: null }));

    const loaded = store.load(Date.parse("2026-07-17T00:01:00.000Z"), 60 * 60 * 1000);
    expect(loaded).toEqual([
      run(),
      run({
        runId: "run-2",
        status: "aborted",
        completedAt: "2026-07-17T00:01:00.000Z"
      })
    ]);
    expect(db.prepare("SELECT status FROM sync_runs WHERE run_id = 'run-2'").get()).toEqual({ status: "aborted" });
    db.close();
  });

  it("removes runs after the retention window", () => {
    const db = new Database(":memory:");
    runDomainMigrations(db);
    const store = createSqliteSyncRunStore(db);
    store.save(run());
    expect(store.load(Date.parse("2026-07-17T02:00:00.000Z"), 60 * 60 * 1000)).toEqual([]);
    store.remove("run-1");
    expect(db.prepare("SELECT COUNT(*) AS count FROM sync_runs").get()).toEqual({ count: 0 });
    db.close();
  });
});
