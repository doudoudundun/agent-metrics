import { z } from "zod";
import { NonNegativeInt, Rfc3339 } from "./common.js";

/**
 * Official account quota snapshot for provider-issued API keys (Codex rollout
 * `rate_limits`, and later other vendors). One window = one rolling quota
 * bucket; `resetsAt` is ISO or null when the source omitted it. Spec section 13.
 */
export const KeyUsageWindowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowMinutes: NonNegativeInt,
  resetsAt: Rfc3339.nullable()
});

export const KeyUsageCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean()
});

export const KeyUsageEntrySchema = z.object({
  vendor: z.string().min(1),
  source: z.string().min(1),
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  primary: KeyUsageWindowSchema.nullable(),
  secondary: KeyUsageWindowSchema.nullable(),
  credits: KeyUsageCreditsSchema.nullable(),
  /** Plan/key expiry when the source reports one (e.g. ZCode plan ends_at). */
  expiresAt: Rfc3339.nullable()
});

export const KeyUsageResponseSchema = z.object({
  updatedAt: Rfc3339.nullable(),
  entries: z.array(KeyUsageEntrySchema)
});

export type KeyUsageWindow = z.infer<typeof KeyUsageWindowSchema>;
export type KeyUsageCredits = z.infer<typeof KeyUsageCreditsSchema>;
export type KeyUsageEntry = z.infer<typeof KeyUsageEntrySchema>;
export type KeyUsageResponse = z.infer<typeof KeyUsageResponseSchema>;
