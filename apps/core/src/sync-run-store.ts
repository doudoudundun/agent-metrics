import type { SyncRun, SyncRunPersistence } from "./sync-coordinator.js";
import type { SqliteDatabaseLike } from "./domain-migrations.js";

type SyncRunRow = {
  runId: string;
  adapterInstanceId: string;
  status: SyncRun["status"];
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  discoveredRecords: number;
  committedUniqueEvents: number;
  projectedUniqueEvents: number;
  projectionWatermark: number | null;
  errorCode: string | null;
  errorSummary: string | null;
};

export function createSqliteSyncRunStore(db: SqliteDatabaseLike): SyncRunPersistence {
  const saveStatement = db.prepare(
    `
      INSERT INTO sync_runs (
        run_id, adapter_instance_id, status, accepted_at, started_at, completed_at,
        discovered_records, committed_unique_events, projected_unique_events,
        projection_watermark, error_code, error_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        adapter_instance_id = excluded.adapter_instance_id,
        status = excluded.status,
        accepted_at = excluded.accepted_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        discovered_records = excluded.discovered_records,
        committed_unique_events = excluded.committed_unique_events,
        projected_unique_events = excluded.projected_unique_events,
        projection_watermark = excluded.projection_watermark,
        error_code = excluded.error_code,
        error_summary = excluded.error_summary
    `
  );
  const loadStatement = db.prepare<SyncRunRow>(
    `
      SELECT
        run_id AS runId,
        adapter_instance_id AS adapterInstanceId,
        status,
        accepted_at AS acceptedAt,
        started_at AS startedAt,
        completed_at AS completedAt,
        discovered_records AS discoveredRecords,
        committed_unique_events AS committedUniqueEvents,
        projected_unique_events AS projectedUniqueEvents,
        projection_watermark AS projectionWatermark,
        error_code AS errorCode,
        error_summary AS errorSummary
      FROM sync_runs
      WHERE completed_at IS NULL OR completed_at >= ?
      ORDER BY accepted_at ASC, run_id ASC
    `
  );
  const deleteStatement = db.prepare("DELETE FROM sync_runs WHERE run_id = ?");

  return {
    save(run) {
      saveStatement.run(
        run.runId,
        run.adapterInstanceId,
        run.status,
        run.acceptedAt,
        run.startedAt,
        run.completedAt,
        run.discoveredRecords,
        run.committedUniqueEvents,
        run.projectedUniqueEvents,
        run.projectionWatermark,
        run.error?.code ?? null,
        run.error?.summary ?? null
      );
    },
    load(nowMs, retentionMs) {
      const cutoff = new Date(nowMs - retentionMs).toISOString();
      const rows = loadStatement.all(cutoff);
      const interrupted = rows.filter((row) => row.status === "queued" || row.status === "syncing");
      if (interrupted.length > 0) {
        const markAborted = db.prepare(
          "UPDATE sync_runs SET status = 'aborted', completed_at = ?, error_code = NULL, error_summary = NULL WHERE run_id = ?"
        );
        const completedAt = new Date(nowMs).toISOString();
        for (const row of interrupted) {
          markAborted.run(completedAt, row.runId);
          row.status = "aborted";
          row.completedAt = completedAt;
          row.errorCode = null;
          row.errorSummary = null;
        }
      }
      return rows.map(toSyncRun);
    },
    remove(runId) {
      deleteStatement.run(runId);
    }
  };
}

function toSyncRun(row: SyncRunRow): SyncRun {
  return {
    runId: row.runId,
    adapterInstanceId: row.adapterInstanceId,
    status: row.status,
    acceptedAt: row.acceptedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    discoveredRecords: row.discoveredRecords,
    committedUniqueEvents: row.committedUniqueEvents,
    projectedUniqueEvents: row.projectedUniqueEvents,
    projectionWatermark: row.projectionWatermark,
    error: row.errorCode === null || row.errorSummary === null
      ? null
      : { code: row.errorCode, summary: row.errorSummary }
  };
}
