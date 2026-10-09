import { z } from "zod";
import { NonNegativeInt } from "./common.js";

export const CursorModelAggregationSchema = z.object({
  model: z.string().min(1),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  totalCents: z.number().finite().nonnegative(),
  tier: z.number().int().nonnegative().nullable()
});

export const CursorAccountUsageResponseSchema = z.object({
  sourceInstanceId: z.string().min(1),
  email: z.string().nullable(),
  planName: z.string().nullable(),
  planTier: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
  hostname: z.string().nullable(),
  machineId: z.string().nullable(),
  billingCycleStart: z.string().datetime(),
  billingCycleEnd: z.string().datetime(),
  totalSpendCents: NonNegativeInt,
  includedSpendCents: NonNegativeInt,
  bonusSpendCents: NonNegativeInt,
  limitCents: NonNegativeInt,
  remainingCents: NonNegativeInt.nullable(),
  autoPercentUsed: z.number().finite().nonnegative(),
  apiPercentUsed: z.number().finite().nonnegative(),
  totalPercentUsed: z.number().finite().nonnegative(),
  displayMessage: z.string().nullable(),
  syncedAt: z.string().datetime(),
  modelAggregations: z.array(CursorModelAggregationSchema),
  modelUsageTotalCostCents: z.number().finite().nonnegative()
});

export type CursorModelAggregation = z.infer<typeof CursorModelAggregationSchema>;
export type CursorAccountUsageResponse = z.infer<typeof CursorAccountUsageResponseSchema>;
