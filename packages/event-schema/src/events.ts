import { z } from "zod";
import { SourceAdapterSchema, SourceVendorSchema, UsageSourceSchema } from "./sources.js";
import { ToolCallIdSchema } from "./tool-lifecycle.js";
import {
  InputTokenSemanticsSchema,
  ServerToolUseSchema,
  UsageMeasurementSchema
} from "./usage.js";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const NonEmptyString = z.string().min(1);
const NonNegativeInt = z.number().int().nonnegative().safe();
const PositiveInt = z.number().int().positive().safe();
const Rfc3339Timestamp = z.string().datetime({ offset: true });

/**
 * Closed set of normalized event type literals. Spec section 9.4 / 14.
 * Contracts and timeline payloads MUST reuse this enum rather than redeclaring strings.
 */
export const EventTypeSchema = z.enum([
  "session.started",
  "session.ended",
  "tool.called",
  "tool.succeeded",
  "tool.failed",
  "code.edit.applied",
  "prompt.submitted",
  "assistant.responded",
  "token.usage.recorded",
  "snapshot.created",
  "ingest_error"
]);

export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Provider metadata. Spec section 9.4: provider_id is literal "unknown" when
 * unavailable. V1 historically allowed null; V2 requires a non-empty string
 * (use "unknown").
 */
export const ProviderMetadataSchema = z.object({
  provider_id: NonEmptyString.nullable().optional(),
  provider_base_url: NonEmptyString.nullable().optional(),
  provider_host: NonEmptyString.nullable().optional()
});

export const ProviderMetadataV2Schema = z.object({
  provider_id: NonEmptyString,
  provider_base_url: NonEmptyString.nullable().optional(),
  provider_host: NonEmptyString.nullable().optional()
});

// ---------------------------------------------------------------------------
// Legacy (schema version 1 / unversioned) event schemas
// ---------------------------------------------------------------------------
// Kept for existing producers. Phase 2 migrates producers to V2; until then
// adapters continue to emit these shapes. Spec section 9.1: schema version 1
// and unversioned historical records are legacy input.

export const BaseEventSchema = z.object({
  event_id: NonEmptyString,
  session_id: NonEmptyString,
  timestamp: Rfc3339Timestamp,
  source_vendor: SourceVendorSchema,
  source_adapter: SourceAdapterSchema,
  workspace_path: NonEmptyString
});

export const SessionStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("session.started")
});

export const SessionEndedEventSchema = BaseEventSchema.extend({
  type: z.literal("session.ended"),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: NonNegativeInt.optional()
});

export const ToolCalledEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.called"),
  tool_call_id: ToolCallIdSchema.optional(),
  tool_name: NonEmptyString,
  status: z.literal("started"),
  argument_summary: z.string().default("")
});

export const ToolSucceededEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.succeeded"),
  tool_call_id: ToolCallIdSchema.optional(),
  tool_name: NonEmptyString,
  status: z.literal("succeeded"),
  duration_ms: NonNegativeInt
});

export const ToolFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.failed"),
  tool_call_id: ToolCallIdSchema.optional(),
  tool_name: NonEmptyString,
  status: z.literal("failed"),
  duration_ms: NonNegativeInt
});

const ToolFinishedEventSchemas = [ToolSucceededEventSchema, ToolFailedEventSchema] as const;

export const ToolFinishedEventSchema = z.discriminatedUnion("type", ToolFinishedEventSchemas);

export const CodeEditAppliedEventSchema = BaseEventSchema.extend({
  type: z.literal("code.edit.applied"),
  tool_name: NonEmptyString,
  files_changed: z.array(NonEmptyString),
  file_count: NonNegativeInt,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  edit_operation_count: PositiveInt
});

export const PromptSubmittedEventSchema = BaseEventSchema.extend({
  type: z.literal("prompt.submitted"),
  prompt_id: NonEmptyString,
  prompt_chars: NonNegativeInt
});

export const AssistantRespondedEventSchema = BaseEventSchema.extend({
  type: z.literal("assistant.responded"),
  message_id: NonEmptyString,
  model: NonEmptyString.nullable().optional(),
  stop_reason: NonEmptyString.nullable().optional(),
  response_chars: NonNegativeInt
}).merge(ProviderMetadataSchema);

export const TokenUsageRecordedEventSchema = BaseEventSchema.extend({
  type: z.literal("token.usage.recorded"),
  message_id: NonEmptyString,
  model: NonEmptyString.nullable().optional(),
  input_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
  cache_creation_input_tokens: NonNegativeInt,
  cache_read_input_tokens: NonNegativeInt,
  server_tool_use: z.string().default("{}"),
  usage_source: UsageSourceSchema,
  first_token_latency_ms: NonNegativeInt.nullable().optional(),
  decode_duration_ms: NonNegativeInt.nullable().optional()
}).merge(ProviderMetadataSchema);

export const SnapshotCreatedEventSchema = BaseEventSchema.extend({
  type: z.literal("snapshot.created"),
  file_path: NonEmptyString,
  snapshot_role: z.union([z.literal("before"), z.literal("after")])
});

export const IngestErrorEventSchema = BaseEventSchema.extend({
  type: z.literal("ingest_error"),
  message: NonEmptyString
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

// ---------------------------------------------------------------------------
// Schema version 2 (NormalizedEventV2)
// ---------------------------------------------------------------------------
// Spec section 9. Phase 1 finalizes these schemas without switching producers.
// Phase 2 migrates adapters to emit V2.

/**
 * Base fields required on every version-2 event. Spec section 9.1.
 * unknown keys are rejected at the normalized boundary via .strict().
 */
export const BaseEventV2Schema = z
  .object({
    schema_version: z.literal(2),
    event_id: NonEmptyString,
    session_id: NonEmptyString,
    timestamp: Rfc3339Timestamp,
    source_vendor: SourceVendorSchema,
    source_adapter: SourceAdapterSchema,
    source_instance_id: NonEmptyString,
    adapter_instance_id: NonEmptyString,
    source_record_namespace: NonEmptyString,
    source_record_id: NonEmptyString.nullable(),
    workspace_path: NonEmptyString
  })
  .strict();

export const SessionStartedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("session.started")
}).strict();

export const SessionEndedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("session.ended"),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: NonNegativeInt.optional()
}).strict();

export const ToolCalledEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("tool.called"),
  tool_call_id: ToolCallIdSchema,
  tool_name: NonEmptyString,
  status: z.literal("started"),
  argument_summary: z.string()
}).strict();

export const ToolSucceededEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("tool.succeeded"),
  tool_call_id: ToolCallIdSchema,
  tool_name: NonEmptyString,
  status: z.literal("succeeded"),
  duration_ms: NonNegativeInt
}).strict();

export const ToolFailedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("tool.failed"),
  tool_call_id: ToolCallIdSchema,
  tool_name: NonEmptyString,
  status: z.literal("failed"),
  duration_ms: NonNegativeInt
}).strict();

export const CodeEditAppliedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("code.edit.applied"),
  tool_name: NonEmptyString,
  files_changed: z.array(NonEmptyString),
  file_count: NonNegativeInt,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  edit_operation_count: PositiveInt
}).strict();

export const PromptSubmittedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("prompt.submitted"),
  prompt_id: NonEmptyString,
  prompt_chars: NonNegativeInt
}).strict();

export const AssistantRespondedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("assistant.responded"),
  message_id: NonEmptyString,
  model: NonEmptyString.nullable().optional(),
  stop_reason: NonEmptyString.nullable().optional(),
  response_chars: NonNegativeInt,
  provider_id: NonEmptyString,
  provider_base_url: NonEmptyString.nullable().optional(),
  provider_host: NonEmptyString.nullable().optional()
}).strict();

/**
 * Token usage event with explicit input semantics and measurement type.
 * Spec section 9.5. server_tool_use is a validated serialized JSON object.
 */
const TokenUsageRecordedEventV2BaseSchema = z
  .object({
    ...BaseEventV2Schema.shape,
    type: z.literal("token.usage.recorded"),
    message_id: NonEmptyString,
    model: NonEmptyString.nullable().optional(),
    input_tokens: NonNegativeInt,
    input_token_semantics: InputTokenSemanticsSchema,
    usage_measurement: UsageMeasurementSchema,
    output_tokens: NonNegativeInt,
    cache_creation_input_tokens: NonNegativeInt,
    cache_read_input_tokens: NonNegativeInt,
    server_tool_use: ServerToolUseSchema,
    usage_source: UsageSourceSchema,
    first_token_latency_ms: NonNegativeInt.nullable().optional(),
    decode_duration_ms: NonNegativeInt.nullable().optional(),
    provider_id: NonEmptyString,
    provider_base_url: NonEmptyString.nullable().optional(),
    provider_host: NonEmptyString.nullable().optional()
  })
  .strict();

export const TokenUsageRecordedEventV2Schema = TokenUsageRecordedEventV2BaseSchema.superRefine((event, ctx) => {
    if (event.input_token_semantics === "gross" && event.cache_read_input_tokens > event.input_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cache_read_input_tokens"],
        message: "gross input_tokens must include cache-read input"
      });
    }
  });

export const SnapshotCreatedEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("snapshot.created"),
  file_path: NonEmptyString,
  snapshot_role: z.union([z.literal("before"), z.literal("after")])
}).strict();

export const IngestErrorEventV2Schema = BaseEventV2Schema.extend({
  type: z.literal("ingest_error"),
  message: NonEmptyString
}).strict();

const NormalizedEventV2Schemas = [
  SessionStartedEventV2Schema,
  SessionEndedEventV2Schema,
  ToolCalledEventV2Schema,
  ToolSucceededEventV2Schema,
  ToolFailedEventV2Schema,
  CodeEditAppliedEventV2Schema,
  PromptSubmittedEventV2Schema,
  AssistantRespondedEventV2Schema,
  TokenUsageRecordedEventV2BaseSchema,
  SnapshotCreatedEventV2Schema,
  IngestErrorEventV2Schema
] as const;

/**
 * Closed discriminated union of every version-2 event. Spec section 9.4.
 * Unknown keys are rejected because each member is .strict().
 */
export const NormalizedEventV2Schema = z
  .discriminatedUnion("type", [...NormalizedEventV2Schemas])
  .superRefine((event, ctx) => {
    if (event.type === "token.usage.recorded" && event.input_token_semantics === "gross" && event.cache_read_input_tokens > event.input_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cache_read_input_tokens"],
        message: "gross input_tokens must include cache-read input"
      });
    }
  });

export type BaseEventV2 = z.infer<typeof BaseEventV2Schema>;
export type SessionStartedEventV2 = z.infer<typeof SessionStartedEventV2Schema>;
export type SessionEndedEventV2 = z.infer<typeof SessionEndedEventV2Schema>;
export type ToolCalledEventV2 = z.infer<typeof ToolCalledEventV2Schema>;
export type ToolSucceededEventV2 = z.infer<typeof ToolSucceededEventV2Schema>;
export type ToolFailedEventV2 = z.infer<typeof ToolFailedEventV2Schema>;
export type CodeEditAppliedEventV2 = z.infer<typeof CodeEditAppliedEventV2Schema>;
export type PromptSubmittedEventV2 = z.infer<typeof PromptSubmittedEventV2Schema>;
export type AssistantRespondedEventV2 = z.infer<typeof AssistantRespondedEventV2Schema>;
export type TokenUsageRecordedEventV2 = z.infer<typeof TokenUsageRecordedEventV2Schema>;
export type SnapshotCreatedEventV2 = z.infer<typeof SnapshotCreatedEventV2Schema>;
export type IngestErrorEventV2 = z.infer<typeof IngestErrorEventV2Schema>;
export type NormalizedEventV2 = z.infer<typeof NormalizedEventV2Schema>;
