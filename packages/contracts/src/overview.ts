import { z } from "zod";
import { SourceVendorSchema } from "@agent-metrics/event-schema";
import {
  AggregateMetaSchema,
  FiniteRate,
  NonNegativeInt,
  TokenComponentsSchema
} from "./common.js";

/**
 * Overview, token-trend, tools, and widget snapshot contracts.
 * Spec section 13.1.
 */

export const TokensByModelRowSchema = TokenComponentsSchema.extend({
  model: z.string().min(1),
  sourceVendor: SourceVendorSchema,
  costUsd: z.number().nonnegative().nullable(),
  avgOutputTokensPerSecond: z.number().nonnegative().nullable(),
  avgFirstTokenLatencyMs: z.number().nonnegative().nullable()
});

export const SourceBreakdownRowSchema = z.object({
  sourceVendor: SourceVendorSchema,
  sessionCount: NonNegativeInt,
  turnCount: NonNegativeInt,
  totalTokens: NonNegativeInt,
  toolCalls: NonNegativeInt,
  costUsd: z.number().nonnegative().nullable()
});

export const ProviderBreakdownRowSchema = z.object({
  providerId: z.string().min(1),
  providerHost: z.string().min(1).nullable(),
  totalTokens: NonNegativeInt
});

export const OverviewResponseSchema = AggregateMetaSchema.merge(TokenComponentsSchema).extend({
  sessionCount: NonNegativeInt,
  turnCount: NonNegativeInt,
  responseCount: NonNegativeInt,
  totalToolCalls: NonNegativeInt,
  successfulExecutions: NonNegativeInt,
  failedExecutions: NonNegativeInt,
  startedOnlyExecutions: NonNegativeInt,
  successRate: FiniteRate,
  editOperationCount: NonNegativeInt,
  affectedFileCount: NonNegativeInt,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  tokensByModel: z.array(TokensByModelRowSchema),
  sourceBreakdown: z.array(SourceBreakdownRowSchema),
  providerBreakdown: z.array(ProviderBreakdownRowSchema),
  totalCostUsd: z.number().nonnegative().nullable()
});

export const ToolRowSchema = z.object({
  toolName: z.string().min(1),
  count: NonNegativeInt,
  failures: NonNegativeInt,
  averageDurationMs: z.number().finite().nonnegative()
});

export const ToolsResponseSchema = AggregateMetaSchema.extend({
  rows: z.array(ToolRowSchema)
});

export const TokenTrendPointSchema = TokenComponentsSchema.extend({
  bucketStart: z.string().datetime(),
  label: z.string().min(1),
  cacheHitRate: FiniteRate
});

export const TokenTrendResponseSchema = AggregateMetaSchema.extend({
  rows: z.array(TokenTrendPointSchema)
});

/**
 * Widget snapshot uses the local calendar day (Today).
 * Spec section 13.1 WidgetSnapshotResponse — product default is calendar today.
 */
export const WidgetSnapshotResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  scope: z.object({
    mode: z.literal("calendar"),
    range: z.literal("day"),
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime()
  }),
  metrics: TokenComponentsSchema.extend({
    sessionCount: NonNegativeInt,
    logicalToolCalls: NonNegativeInt,
    cacheHitRate: FiniteRate,
    toolSuccessRate: FiniteRate,
    editOperationCount: NonNegativeInt,
    affectedFileCount: NonNegativeInt,
    totalCostUsd: z.number().nonnegative().nullable()
  })
});

export type TokensByModelRow = z.infer<typeof TokensByModelRowSchema>;
export type SourceBreakdownRow = z.infer<typeof SourceBreakdownRowSchema>;
export type ProviderBreakdownRow = z.infer<typeof ProviderBreakdownRowSchema>;
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;
export type ToolRow = z.infer<typeof ToolRowSchema>;
export type ToolsResponse = z.infer<typeof ToolsResponseSchema>;
export type TokenTrendPoint = z.infer<typeof TokenTrendPointSchema>;
export type TokenTrendResponse = z.infer<typeof TokenTrendResponseSchema>;
export type WidgetSnapshotResponse = z.infer<typeof WidgetSnapshotResponseSchema>;
