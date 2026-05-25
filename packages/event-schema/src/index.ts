import { z } from "zod";

const BaseEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  timestamp: z.string().datetime(),
  source_vendor: z.string().min(1),
  source_adapter: z.string().min(1),
  workspace_path: z.string().min(1)
});

export const SessionStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("session.started")
});

export const SessionEndedEventSchema = BaseEventSchema.extend({
  type: z.literal("session.ended"),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nonnegative().optional()
});

export const ToolCalledEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.called"),
  tool_name: z.string().min(1),
  status: z.literal("started"),
  argument_summary: z.string().default("")
});

export const ToolSucceededEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.succeeded"),
  tool_name: z.string().min(1),
  status: z.literal("succeeded"),
  duration_ms: z.number().int().nonnegative()
});

export const ToolFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.failed"),
  tool_name: z.string().min(1),
  status: z.literal("failed"),
  duration_ms: z.number().int().nonnegative()
});

const ToolFinishedEventSchemas = [
  ToolSucceededEventSchema,
  ToolFailedEventSchema
] as const;

export const ToolFinishedEventSchema = z.discriminatedUnion(
  "type",
  ToolFinishedEventSchemas
);

export const CodeEditAppliedEventSchema = BaseEventSchema.extend({
  type: z.literal("code.edit.applied"),
  tool_name: z.string().min(1),
  files_changed: z.array(z.string().min(1)),
  file_count: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  edit_operation_count: z.number().int().positive()
});

export const SnapshotCreatedEventSchema = BaseEventSchema.extend({
  type: z.literal("snapshot.created"),
  file_path: z.string().min(1),
  snapshot_role: z.union([z.literal("before"), z.literal("after")])
});

export const IngestErrorEventSchema = BaseEventSchema.extend({
  type: z.literal("ingest_error"),
  message: z.string().min(1)
});

export const AnyEventSchema = z.discriminatedUnion("type", [
  SessionStartedEventSchema,
  SessionEndedEventSchema,
  ToolCalledEventSchema,
  ...ToolFinishedEventSchemas,
  CodeEditAppliedEventSchema,
  SnapshotCreatedEventSchema,
  IngestErrorEventSchema
]);

export type AnyEvent = z.infer<typeof AnyEventSchema>;
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;
export type SessionEndedEvent = z.infer<typeof SessionEndedEventSchema>;
export type ToolCalledEvent = z.infer<typeof ToolCalledEventSchema>;
export type ToolFinishedEvent = z.infer<typeof ToolFinishedEventSchema>;
export type CodeEditAppliedEvent = z.infer<typeof CodeEditAppliedEventSchema>;
