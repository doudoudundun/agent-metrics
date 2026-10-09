import { z } from "zod";

/**
 * Shared HTTP error contract. Spec section 13.2.
 * Messages are sanitized and safe to show in the UI. Stack traces, filesystem
 * records, SQL, and source payloads MUST NOT cross the HTTP boundary.
 */
export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
  })
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/** Well-known error codes used by Core routes. Spec sections 12.4 and 13. */
export const ApiErrorCode = {
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_CURSOR: "INVALID_CURSOR",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  AMBIGUOUS_SESSION_ID: "AMBIGUOUS_SESSION_ID",
  ADAPTER_NOT_FOUND: "ADAPTER_NOT_FOUND",
  ADAPTER_DISABLED: "ADAPTER_DISABLED",
  SYNC_SHUTTING_DOWN: "SYNC_SHUTTING_DOWN",
  SYNC_RUN_NOT_FOUND: "SYNC_RUN_NOT_FOUND",
  NOT_READY: "NOT_READY",
  PROJECTION_NOT_READY: "PROJECTION_NOT_READY",
  UNSUPPORTED_LEGACY_SCHEMA: "UNSUPPORTED_LEGACY_SCHEMA"
} as const;

export type ApiErrorCodeName = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
