import { z } from "zod";
import {
  EventTypeSchema,
  NormalizedEventV2Schema,
  SourceAdapterSchema,
  SourceVendorSchema,
  UsageSourceSchema
} from "@agent-metrics/event-schema";

// Re-export shared identifiers so consumers import them from contracts without
// redeclaring enums or event-type literals. Spec section 14.
export {
  EventTypeSchema,
  NormalizedEventV2Schema,
  SourceAdapterSchema,
  SourceVendorSchema,
  UsageSourceSchema
};
export type {
  EventType,
  NormalizedEventV2,
  SourceAdapter,
  SourceVendor,
  UsageSource
} from "@agent-metrics/event-schema";

const NonNegativeInt = z.number().int().nonnegative();
const FiniteRate = z.number().finite().min(0).max(1);
const Rfc3339 = z.string().datetime();

export const TimeScopeModeSchema = z.enum(["calendar", "rolling", "lifetime", "custom"]);
export const TimeScopeRangeSchema = z.enum(["day", "week", "month"]);

/**
 * Time scope for analytics queries. Spec section 13.
 * custom requires startAt < endAt; non-custom modes reject bounds at the route layer.
 */
export const TimeScopeSchema = z.union([
  z.object({
    mode: z.enum(["calendar", "rolling"]),
    range: TimeScopeRangeSchema
  }),
  z.object({
    mode: z.literal("lifetime"),
    range: TimeScopeRangeSchema
  }),
  z.object({
    mode: z.literal("custom"),
    startAt: Rfc3339,
    endAt: Rfc3339
  })
]);

/**
 * Additive analytics filter. Spec section 13.
 * Within one dimension values combine with OR; different dimensions with AND.
 * Omitted arrays mean all. Explicit empty arrays mean no rows (clients short-circuit).
 */
export const AnalyticsFilterSchema = z.intersection(
  TimeScopeSchema,
  z.object({
    sourceVendors: z.array(SourceVendorSchema).optional(),
    sourceInstanceIds: z.array(z.string().min(1)).optional(),
    adapterInstanceIds: z.array(z.string().min(1)).optional(),
    workspacePaths: z.array(z.string().min(1)).optional()
  })
);

export const PageRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional()
});

export const PageResponseSchema = <T extends z.ZodTypeAny>(rowSchema: T) =>
  z.object({
    rows: z.array(rowSchema),
    nextCursor: z.string().nullable()
  });

export const AggregateMetaSchema = z.object({
  mode: TimeScopeModeSchema,
  range: TimeScopeRangeSchema.nullable(),
  timezone: z.string().min(1),
  windowStart: Rfc3339.nullable(),
  windowEnd: Rfc3339.nullable(),
  updatedAt: Rfc3339
});

export const TokenComponentsSchema = z.object({
  totalTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt
});

export type TimeScope = z.infer<typeof TimeScopeSchema>;
export type AnalyticsFilter = z.infer<typeof AnalyticsFilterSchema>;
export type PageRequest = z.infer<typeof PageRequestSchema>;
export type AggregateMeta = z.infer<typeof AggregateMetaSchema>;
export type TokenComponents = z.infer<typeof TokenComponentsSchema>;
export type PageResponse<T> = { rows: T[]; nextCursor: string | null };

export { NonNegativeInt, FiniteRate, Rfc3339 };
