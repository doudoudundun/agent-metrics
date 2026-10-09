import { z } from "zod";
import {
  SourceAdapterSchema,
  SourceVendorSchema,
  UsageSourceSchema
} from "@agent-metrics/event-schema";
import {
  AggregateMetaSchema,
  EventTypeSchema,
  NonNegativeInt,
  PageResponseSchema
} from "./common.js";

/**
 * Session list, detail, and timeline contracts. Spec section 13.1.
 */

export const SessionRowSchema = z.object({
  sourceInstanceId: z.string().min(1),
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
  sourceVendor: SourceVendorSchema,
  sourceAdapters: z.array(SourceAdapterSchema),
  providerId: z.string().min(1),
  providerHost: z.string().min(1).nullable(),
  turnCount: NonNegativeInt,
  totalTokens: NonNegativeInt,
  lastModel: z.string().min(1).nullable(),
  lastActivityAt: z.string().datetime()
});

export const SessionsResponseSchema = AggregateMetaSchema.extend({
  rows: z.array(SessionRowSchema),
  nextCursor: z.string().nullable()
});

export const SessionTimelineEntrySchema = z.object({
  eventId: z.string().min(1),
  createdAt: z.string().datetime(),
  type: EventTypeSchema,
  sourceVendor: SourceVendorSchema,
  sourceAdapters: z.array(SourceAdapterSchema),
  toolCallId: z.string().min(1).nullable(),
  toolName: z.string().min(1).nullable(),
  status: z.string().min(1).nullable(),
  durationMs: NonNegativeInt.nullable(),
  providerId: z.string().min(1).nullable(),
  providerHost: z.string().min(1).nullable(),
  filesChanged: z.array(z.string().min(1)),
  insertions: NonNegativeInt.nullable(),
  deletions: NonNegativeInt.nullable(),
  promptId: z.string().min(1).nullable(),
  promptChars: NonNegativeInt.nullable(),
  messageId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  stopReason: z.string().min(1).nullable(),
  responseChars: NonNegativeInt.nullable(),
  inputTokens: NonNegativeInt.nullable(),
  outputTokens: NonNegativeInt.nullable(),
  cacheReadTokens: NonNegativeInt.nullable(),
  cacheCreationTokens: NonNegativeInt.nullable(),
  totalTokens: NonNegativeInt.nullable(),
  usageSource: UsageSourceSchema.nullable()
});

export const SessionContextSchema = z.object({
  executionPath: z.string().min(1).nullable(),
  skillsLoaded: z.boolean(),
  skillNames: z.array(z.string().min(1))
});

export const SessionDetailResponseSchema = AggregateMetaSchema.extend({
  sourceInstanceId: z.string().min(1),
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
  sourceVendor: SourceVendorSchema,
  sourceAdapters: z.array(SourceAdapterSchema),
  context: SessionContextSchema.nullable(),
  timeline: PageResponseSchema(SessionTimelineEntrySchema)
});

export type SessionRow = z.infer<typeof SessionRowSchema>;
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;
export type SessionTimelineEntry = z.infer<typeof SessionTimelineEntrySchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type SessionDetailResponse = z.infer<typeof SessionDetailResponseSchema>;
