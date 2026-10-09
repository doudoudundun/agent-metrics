import type { SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

export type SyncAdapterStatus =
  | "idle"
  | "queued"
  | "syncing"
  | "ready"
  | "stale"
  | "error"
  | "disabled";

export type SyncRunStatus = "queued" | "syncing" | "succeeded" | "failed" | "aborted";

export type SyncAdapter = {
  adapterInstanceId: string;
  sourceInstanceId: string;
  sourceAdapter: SourceAdapter;
  sourceVendor: SourceVendor;
  enabled: boolean;
  sync(context: { runId: string; signal: AbortSignal }): Promise<SyncResult>;
};

export type SyncResult = {
  discoveredRecords: number;
  committedUniqueEvents: number;
  projectedUniqueEvents: number;
  projectionWatermark: number;
};

export type SyncError = {
  code: string;
  summary: string;
};

export type SyncAdapterState = {
  adapterInstanceId: string;
  sourceInstanceId: string;
  sourceAdapter: SourceAdapter;
  sourceVendor: SourceVendor;
  status: SyncAdapterStatus;
  activeRunId: string | null;
  pendingRunId: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  nextScheduledAt: string | null;
  lastError: SyncError | null;
  consecutiveFailures: number;
};

export type SyncRun = {
  runId: string;
  adapterInstanceId: string;
  status: SyncRunStatus;
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  discoveredRecords: number;
  committedUniqueEvents: number;
  projectedUniqueEvents: number;
  projectionWatermark: number | null;
  error: SyncError | null;
};

export type SyncStatusSnapshot = {
  generatedAt: string;
  shuttingDown: boolean;
  adapters: SyncAdapterState[];
};

export type SyncTriggerDisposition = "started" | "queued" | "coalesced";

export type SyncTriggerResult = {
  adapterInstanceId: string;
  runId: string;
  disposition: SyncTriggerDisposition;
};

export type ManualSyncResponse = {
  requestId: string;
  acceptedAt: string;
  runs: SyncTriggerResult[];
};

export type SyncCoordinatorOptions = {
  adapters?: readonly SyncAdapter[];
  maxConcurrency?: number;
  freshnessMs?: number;
  runRetentionMs?: number;
  periodicIntervalMs?: number;
  now?: () => Date | string | number;
  runId?: (context: { adapterInstanceId: string; acceptedAt: string }) => string;
  requestId?: () => string;
  persistence?: SyncRunPersistence;
};

export type SyncRunPersistence = {
  save(run: SyncRun): void;
  load(nowMs: number, retentionMs: number): SyncRun[];
  remove(runId: string): void;
};

