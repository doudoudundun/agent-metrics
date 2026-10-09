import type {
  SyncAdapter,
  SyncAdapterState,
  SyncError,
  SyncRun,
  SyncResult
} from "./sync-types.js";

export type StateSnapshot = Omit<
  SyncAdapterState,
  "adapterInstanceId" | "sourceInstanceId" | "sourceAdapter" | "sourceVendor"
>;

const ERROR_SUMMARY_LIMIT = 2048;
export const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;
export const DEFAULT_RUN_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_PERIODIC_SYNC_MS = 60 * 1000;
/** Hard cap so a stuck adapter (stale lock / huge projection) cannot pin UI on syncing forever. */
export const DEFAULT_SYNC_RUN_TIMEOUT_MS = 3 * 60 * 1000;

export class SyncCoordinatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SyncCoordinatorError";
    this.code = code;
  }
}


export function validateAdapter(adapter: SyncAdapter): void {
  for (const [name, value] of [
    ["adapterInstanceId", adapter.adapterInstanceId],
    ["sourceInstanceId", adapter.sourceInstanceId]
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SyncCoordinatorError("INVALID_ADAPTER", `${name} must be a non-empty string`);
    }
  }
  if (typeof adapter.sync !== "function") {
    throw new SyncCoordinatorError("INVALID_ADAPTER", "sync must be a function");
  }
}

export function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return 2;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SyncCoordinatorError("INVALID_CONCURRENCY", "maxConcurrency must be a positive integer");
  }
  return Math.min(value, 2);
}

export function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new SyncCoordinatorError("INVALID_DURATION", "duration must be a non-negative finite number");
  }
  return value;
}

export function normalizeId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyncCoordinatorError("INVALID_ID", `${field} must be a non-empty string`);
  }
  return value;
}

export function normalizeResult(value: SyncResult): SyncResult {
  if (value === null || typeof value !== "object") {
    throw new SyncCoordinatorError("INVALID_SYNC_RESULT", "Adapter returned an invalid sync result");
  }
  for (const [name, count] of [
    ["discoveredRecords", value.discoveredRecords],
    ["committedUniqueEvents", value.committedUniqueEvents],
    ["projectedUniqueEvents", value.projectedUniqueEvents],
    ["projectionWatermark", value.projectionWatermark]
  ] as const) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new SyncCoordinatorError("INVALID_SYNC_RESULT", `${name} must be a non-negative safe integer`);
    }
  }
  return { ...value };
}

export function toSyncError(error: unknown): SyncError {
  if (error instanceof SyncCoordinatorError) {
    return {
      code: error.code,
      summary: sanitizeSummary(error.message)
    };
  }

  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Synchronization failed";
  return {
    code: "SYNC_FAILED",
    summary: sanitizeSummary(message)
  };
}

export function sanitizeSummary(value: string): string {
  const summary = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (summary || "Synchronization failed").slice(0, ERROR_SUMMARY_LIMIT);
}

export function snapshotState(state: SyncAdapterState): StateSnapshot {
  return {
    status: state.status,
    activeRunId: state.activeRunId,
    pendingRunId: state.pendingRunId,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastSuccessfulAt: state.lastSuccessfulAt,
    nextScheduledAt: state.nextScheduledAt,
    lastError: state.lastError ? { ...state.lastError } : null,
    consecutiveFailures: state.consecutiveFailures
  };
}

export function restoreState(state: SyncAdapterState, snapshot: StateSnapshot): void {
  state.status = snapshot.status;
  state.activeRunId = snapshot.activeRunId;
  state.pendingRunId = snapshot.pendingRunId;
  state.lastStartedAt = snapshot.lastStartedAt;
  state.lastCompletedAt = snapshot.lastCompletedAt;
  state.lastSuccessfulAt = snapshot.lastSuccessfulAt;
  state.nextScheduledAt = snapshot.nextScheduledAt;
  state.lastError = snapshot.lastError ? { ...snapshot.lastError } : null;
  state.consecutiveFailures = snapshot.consecutiveFailures;
}

export function cloneState(state: SyncAdapterState): SyncAdapterState {
  return {
    ...state,
    lastError: state.lastError ? { ...state.lastError } : null
  };
}

export function cloneRun(run: SyncRun): SyncRun {
  return {
    ...run,
    error: run.error ? { ...run.error } : null
  };
}
