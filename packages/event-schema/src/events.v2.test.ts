import { describe, expect, it } from "vitest";
import {
  AssistantRespondedEventV2Schema,
  CodeEditAppliedEventV2Schema,
  EventTypeSchema,
  IngestErrorEventV2Schema,
  NormalizedEventV2Schema,
  PromptSubmittedEventV2Schema,
  SessionEndedEventV2Schema,
  SessionStartedEventV2Schema,
  SnapshotCreatedEventV2Schema,
  TokenUsageRecordedEventV2Schema,
  ToolCalledEventV2Schema,
  ToolFailedEventV2Schema,
  ToolSucceededEventV2Schema
} from "./events.js";
import { SessionKeySchema, ToolCallKeySchema } from "./tool-lifecycle.js";
import {
  InputTokenSemanticsSchema,
  ServerToolUseSchema,
  UsageMeasurementSchema
} from "./usage.js";

const baseV2 = {
  schema_version: 2 as const,
  event_id: "v2:claude:default:hook:tool.called:abc",
  session_id: "ses_1",
  timestamp: "2026-05-25T08:00:00.000Z",
  source_vendor: "claude-code" as const,
  source_adapter: "claude-hook" as const,
  source_instance_id: "claude:default",
  adapter_instance_id: "claude-hook@claude:default",
  source_record_namespace: "hook",
  source_record_id: "tool_use_1",
  workspace_path: "D:/projects/dev/agent-metrics"
};

describe("NormalizedEventV2", () => {
  it("pins the closed EventType enum", () => {
    expect(EventTypeSchema.safeParse("session.started").success).toBe(true);
    expect(EventTypeSchema.safeParse("token.usage.recorded").success).toBe(true);
    expect(EventTypeSchema.safeParse("unknown.event").success).toBe(false);
  });

  it("parses a valid session.started V2 event", () => {
    const result = SessionStartedEventV2Schema.safeParse({
      ...baseV2,
      type: "session.started"
    });
    expect(result.success).toBe(true);
  });

  it("parses remaining V2 event kinds", () => {
    expect(
      SessionEndedEventV2Schema.safeParse({
        ...baseV2,
        type: "session.ended",
        exit_code: 0,
        duration_ms: 1200
      }).success
    ).toBe(true);

    expect(
      CodeEditAppliedEventV2Schema.safeParse({
        ...baseV2,
        type: "code.edit.applied",
        tool_name: "Edit",
        files_changed: ["a.ts"],
        file_count: 1,
        insertions: 2,
        deletions: 1,
        edit_operation_count: 1
      }).success
    ).toBe(true);

    expect(
      PromptSubmittedEventV2Schema.safeParse({
        ...baseV2,
        type: "prompt.submitted",
        prompt_id: "p1",
        prompt_chars: 12
      }).success
    ).toBe(true);

    expect(
      AssistantRespondedEventV2Schema.safeParse({
        ...baseV2,
        type: "assistant.responded",
        message_id: "m1",
        response_chars: 40,
        provider_id: "unknown"
      }).success
    ).toBe(true);

    expect(
      SnapshotCreatedEventV2Schema.safeParse({
        ...baseV2,
        type: "snapshot.created",
        file_path: "a.ts",
        snapshot_role: "before"
      }).success
    ).toBe(true);

    expect(
      IngestErrorEventV2Schema.safeParse({
        ...baseV2,
        type: "ingest_error",
        message: "malformed line"
      }).success
    ).toBe(true);

    expect(
      NormalizedEventV2Schema.safeParse({
        ...baseV2,
        type: "not.a.real.type"
      }).success
    ).toBe(false);
  });

  it("requires schema_version 2 and identity fields", () => {
    const missingIdentity = NormalizedEventV2Schema.safeParse({
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: ".",
      type: "session.started"
    });
    expect(missingIdentity.success).toBe(false);
  });

  it("rejects unknown keys on the V2 boundary", () => {
    const result = SessionStartedEventV2Schema.safeParse({
      ...baseV2,
      type: "session.started",
      unexpected_field: "nope"
    });
    expect(result.success).toBe(false);
  });

  it("requires tool_call_id on tool lifecycle events", () => {
    const withoutId = ToolCalledEventV2Schema.safeParse({
      ...baseV2,
      type: "tool.called",
      tool_name: "Read",
      status: "started",
      argument_summary: ""
    });
    expect(withoutId.success).toBe(false);

    const withId = ToolCalledEventV2Schema.safeParse({
      ...baseV2,
      type: "tool.called",
      tool_call_id: "native:tool_use_1",
      tool_name: "Read",
      status: "started",
      argument_summary: ""
    });
    expect(withId.success).toBe(true);

    const terminal = ToolSucceededEventV2Schema.safeParse({
      ...baseV2,
      type: "tool.succeeded",
      tool_call_id: "native:tool_use_1",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });
    expect(terminal.success).toBe(true);

    const failed = ToolFailedEventV2Schema.safeParse({
      ...baseV2,
      type: "tool.failed",
      tool_call_id: "native:tool_use_1",
      tool_name: "Write",
      status: "failed",
      duration_ms: 21
    });
    expect(failed.success).toBe(true);
  });

  it("requires input_token_semantics and usage_measurement on usage events", () => {
    const missingSemantics = TokenUsageRecordedEventV2Schema.safeParse({
      ...baseV2,
      type: "token.usage.recorded",
      message_id: "msg_1",
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20,
      server_tool_use: "{}",
      usage_source: "claude-transcript",
      provider_id: "unknown"
    });
    expect(missingSemantics.success).toBe(false);

    const valid = TokenUsageRecordedEventV2Schema.safeParse({
      ...baseV2,
      type: "token.usage.recorded",
      message_id: "msg_1",
      input_tokens: 100,
      input_token_semantics: "delta",
      usage_measurement: "increment",
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20,
      server_tool_use: "{}",
      usage_source: "claude-transcript",
      provider_id: "unknown"
    });
    expect(valid.success).toBe(true);
  });

  it("rejects negative token counts and invalid enums", () => {
    const negative = TokenUsageRecordedEventV2Schema.safeParse({
      ...baseV2,
      type: "token.usage.recorded",
      message_id: "msg_1",
      input_tokens: -1,
      input_token_semantics: "delta",
      usage_measurement: "increment",
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: "{}",
      usage_source: "claude-transcript",
      provider_id: "unknown"
    });
    expect(negative.success).toBe(false);

    const badEnum = TokenUsageRecordedEventV2Schema.safeParse({
      ...baseV2,
      type: "token.usage.recorded",
      message_id: "msg_1",
      input_tokens: 1,
      input_token_semantics: "net",
      usage_measurement: "increment",
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: "{}",
      usage_source: "claude-transcript",
      provider_id: "unknown"
    });
    expect(badEnum.success).toBe(false);
  });

  it("rejects gross input that is smaller than cache-read input", () => {
    const invalid = TokenUsageRecordedEventV2Schema.safeParse({
      ...baseV2,
      type: "token.usage.recorded",
      message_id: "msg_1",
      input_tokens: 10,
      input_token_semantics: "gross",
      usage_measurement: "increment",
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 11,
      server_tool_use: "{}",
      usage_source: "codex-rollout",
      provider_id: "unknown"
    });

    expect(invalid.success).toBe(false);
  });

  it("validates server_tool_use as a JSON object with non-negative integer counters", () => {
    expect(ServerToolUseSchema.safeParse("{}").success).toBe(true);
    expect(ServerToolUseSchema.safeParse('{"web_search_requests":2}').success).toBe(true);
    expect(ServerToolUseSchema.safeParse("not-json").success).toBe(false);
    expect(ServerToolUseSchema.safeParse("[]").success).toBe(false);
    expect(ServerToolUseSchema.safeParse('{"n":-1}').success).toBe(false);
    expect(ServerToolUseSchema.safeParse('{"n":1.5}').success).toBe(false);
  });

  it("pins input_token_semantics and usage_measurement enums", () => {
    expect(InputTokenSemanticsSchema.safeParse("delta").success).toBe(true);
    expect(InputTokenSemanticsSchema.safeParse("gross").success).toBe(true);
    expect(InputTokenSemanticsSchema.safeParse("net").success).toBe(false);
    expect(UsageMeasurementSchema.safeParse("increment").success).toBe(true);
    expect(UsageMeasurementSchema.safeParse("session-context-snapshot").success).toBe(true);
    expect(UsageMeasurementSchema.safeParse("absolute").success).toBe(false);
  });

  it("parses SessionKey and ToolCallKey", () => {
    expect(
      SessionKeySchema.safeParse({ sourceInstanceId: "claude:default", sessionId: "ses_1" })
        .success
    ).toBe(true);
    expect(
      ToolCallKeySchema.safeParse({
        sourceInstanceId: "claude:default",
        sessionId: "ses_1",
        toolCallId: "native:tool_use_1"
      }).success
    ).toBe(true);
    expect(ToolCallKeySchema.safeParse({ sourceInstanceId: "x", sessionId: "y" }).success).toBe(
      false
    );
  });
});
