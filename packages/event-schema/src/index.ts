import { z } from "zod";

export const SourceVendorSchema = z.enum(["claude-code", "opencode", "codex", "cursor"]);

export const SourceAdapterSchema = z.enum([
  "claude",
  "claude-hook",
  "claude-transcript",
  "opencode-db",
  "zcode-db",
  "cursor-ide",
  "codex-rollout",
  "codex-history",
  "codex-logs"
]);

export const UsageSourceSchema = z.enum([
  "claude-transcript",
  "opencode-message",
  "opencode-step-finish",
  "cursor-generation",
  "cursor-composer-context",
  "codex-rollout",
  "codex-logs"
]);

const BaseEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  timestamp: z.string().datetime(),
  source_vendor: SourceVendorSchema,
  source_adapter: SourceAdapterSchema,
  workspace_path: z.string().min(1)
});

const ProviderMetadataSchema = z.object({
  provider_id: z.string().min(1).nullable().optional(),
  provider_base_url: z.string().min(1).nullable().optional(),
  provider_host: z.string().min(1).nullable().optional()
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

export const PromptSubmittedEventSchema = BaseEventSchema.extend({
  type: z.literal("prompt.submitted"),
  prompt_id: z.string().min(1),
  prompt_chars: z.number().int().nonnegative()
});

export const AssistantRespondedEventSchema = BaseEventSchema.extend({
  type: z.literal("assistant.responded"),
  message_id: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  stop_reason: z.string().min(1).nullable().optional(),
  response_chars: z.number().int().nonnegative()
}).merge(ProviderMetadataSchema);

export const TokenUsageRecordedEventSchema = BaseEventSchema.extend({
  type: z.literal("token.usage.recorded"),
  message_id: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  server_tool_use: z.string().default("{}"),
  usage_source: UsageSourceSchema
}).merge(ProviderMetadataSchema);

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
  PromptSubmittedEventSchema,
  AssistantRespondedEventSchema,
  TokenUsageRecordedEventSchema,
  SnapshotCreatedEventSchema,
  IngestErrorEventSchema
]);

export type AnyEvent = z.infer<typeof AnyEventSchema>;
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;
export type SessionEndedEvent = z.infer<typeof SessionEndedEventSchema>;
export type ToolCalledEvent = z.infer<typeof ToolCalledEventSchema>;
export type ToolSucceededEvent = z.infer<typeof ToolSucceededEventSchema>;
export type ToolFailedEvent = z.infer<typeof ToolFailedEventSchema>;
export type ToolFinishedEvent = z.infer<typeof ToolFinishedEventSchema>;
export type CodeEditAppliedEvent = z.infer<typeof CodeEditAppliedEventSchema>;
export type PromptSubmittedEvent = z.infer<typeof PromptSubmittedEventSchema>;
export type AssistantRespondedEvent = z.infer<typeof AssistantRespondedEventSchema>;
export type TokenUsageRecordedEvent = z.infer<typeof TokenUsageRecordedEventSchema>;
export type SnapshotCreatedEvent = z.infer<typeof SnapshotCreatedEventSchema>;
export type IngestErrorEvent = z.infer<typeof IngestErrorEventSchema>;
export type SourceVendor = z.infer<typeof SourceVendorSchema>;
export type SourceAdapter = z.infer<typeof SourceAdapterSchema>;
