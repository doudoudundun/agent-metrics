import { z } from "zod";
import { SourceAdapterSchema, SourceVendorSchema } from "@agent-metrics/event-schema";
import { NonNegativeInt, Rfc3339 } from "./common.js";

/**
 * Sync coordinator contracts. Spec section 12.4.
 */

export const SyncAdapterStatusSchema = z.enum([
  "idle",
  "queued",
  "syncing",
  "ready",
  "stale",
  "error",
  "disabled"
]);

export const SyncRunStatusSchema = z.enum([
  "queued",
  "syncing",
  "succeeded",
  "failed",
  "aborted"
]);

export const SyncErrorSchema = z.object({
  code: z.string().min(1),
  summary: z.string().min(1).max(2048)
});

export const SyncAdapterStateSchema = z.object({
  adapterInstanceId: z.string().min(1),
  sourceInstanceId: z.string().min(1),
  sourceAdapter: SourceAdapterSchema,
  sourceVendor: SourceVendorSchema,
  status: SyncAdapterStatusSchema,
  activeRunId: z.string().min(1).nullable(),
  pendingRunId: z.string().min(1).nullable(),
  lastStartedAt: Rfc3339.nullable(),
  lastCompletedAt: Rfc3339.nullable(),
  lastSuccessfulAt: Rfc3339.nullable(),
  nextScheduledAt: Rfc3339.nullable(),
  lastError: SyncErrorSchema.nullable(),
  consecutiveFailures: NonNegativeInt
});

export const SyncRunSchema = z.object({
  runId: z.string().min(1),
  adapterInstanceId: z.string().min(1),
  status: SyncRunStatusSchema,
  acceptedAt: Rfc3339,
  startedAt: Rfc3339.nullable(),
  completedAt: Rfc3339.nullable(),
  discoveredRecords: NonNegativeInt,
  committedUniqueEvents: NonNegativeInt,
  projectedUniqueEvents: NonNegativeInt,
  projectionWatermark: NonNegativeInt.nullable(),
  error: SyncErrorSchema.nullable()
});

export const SyncStatusResponseSchema = z.object({
  generatedAt: Rfc3339,
  shuttingDown: z.boolean(),
  adapters: z.array(SyncAdapterStateSchema)
});

export const ManualSyncRequestSchema = z.object({
  reason: z.string().max(200).optional()
});

export const ManualSyncDispositionSchema = z.enum(["started", "queued", "coalesced"]);

export const ManualSyncResponseSchema = z.object({
  requestId: z.string().min(1),
  acceptedAt: Rfc3339,
  runs: z.array(
    z.object({
      adapterInstanceId: z.string().min(1),
      runId: z.string().min(1),
      disposition: ManualSyncDispositionSchema
    })
  )
});

export const SyncRunResponseSchema = SyncRunSchema;

export type SyncAdapterStatus = z.infer<typeof SyncAdapterStatusSchema>;
export type SyncRunStatus = z.infer<typeof SyncRunStatusSchema>;
export type SyncAdapterState = z.infer<typeof SyncAdapterStateSchema>;
export type SyncRun = z.infer<typeof SyncRunSchema>;
export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>;
export type ManualSyncRequest = z.infer<typeof ManualSyncRequestSchema>;
export type ManualSyncDisposition = z.infer<typeof ManualSyncDispositionSchema>;
export type ManualSyncResponse = z.infer<typeof ManualSyncResponseSchema>;
export type SyncRunResponse = z.infer<typeof SyncRunResponseSchema>;
