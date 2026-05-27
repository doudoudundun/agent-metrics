import { describe, expect, it } from "vitest";
import {
  AssistantRespondedEventSchema,
  AnyEventSchema,
  CodeEditAppliedEventSchema,
  IngestErrorEventSchema,
  PromptSubmittedEventSchema,
  SessionEndedEventSchema,
  SessionStartedEventSchema,
  SnapshotCreatedEventSchema,
  TokenUsageRecordedEventSchema,
  ToolCalledEventSchema,
  ToolFailedEventSchema,
  ToolFinishedEventSchema,
  ToolSucceededEventSchema
} from "./index.js";

describe("AnyEventSchema", () => {
  it("parses a session.started event", () => {
    const result = SessionStartedEventSchema.safeParse({
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    expect(result.success).toBe(true);
  });

  it("rejects a tool event without a tool name", () => {
    const result = AnyEventSchema.safeParse({
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.called",
      status: "started"
    });

    expect(result.success).toBe(false);
  });

  it("parses a session.ended event", () => {
    const result = SessionEndedEventSchema.safeParse({
      event_id: "evt_3",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:02.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.ended",
      exit_code: 0,
      duration_ms: 1234
    });

    expect(result.success).toBe(true);
  });

  it("parses a tool.called event with a default argument summary", () => {
    const result = ToolCalledEventSchema.safeParse({
      event_id: "evt_4",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:03.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.called",
      tool_name: "edit_file",
      status: "started"
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.argument_summary).toBe("");
  });

  it("parses the finished tool variants", () => {
    const successPayload = {
      event_id: "evt_5",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:04.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "edit_file",
      status: "succeeded",
      duration_ms: 12
    };

    const failurePayload = {
      event_id: "evt_6",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:05.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.failed",
      tool_name: "edit_file",
      status: "failed",
      duration_ms: 13
    };

    const successResult = ToolSucceededEventSchema.safeParse(successPayload);
    const failureResult = ToolFailedEventSchema.safeParse(failurePayload);
    const finishedSuccessResult = ToolFinishedEventSchema.safeParse(successPayload);
    const finishedFailureResult = ToolFinishedEventSchema.safeParse(failurePayload);

    expect(successResult.success).toBe(true);
    expect(failureResult.success).toBe(true);
    expect(finishedSuccessResult.success).toBe(true);
    expect(finishedFailureResult.success).toBe(true);
  });

  it("parses a code.edit.applied event", () => {
    const result = CodeEditAppliedEventSchema.safeParse({
      event_id: "evt_7",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:06.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "code.edit.applied",
      tool_name: "edit_file",
      files_changed: ["packages/event-schema/src/index.ts"],
      file_count: 1,
      insertions: 10,
      deletions: 2,
      edit_operation_count: 1
    });

    expect(result.success).toBe(true);
  });

  it("parses a snapshot.created event", () => {
    const result = SnapshotCreatedEventSchema.safeParse({
      event_id: "evt_8",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:07.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "snapshot.created",
      file_path: "packages/event-schema/src/index.ts",
      snapshot_role: "before"
    });

    expect(result.success).toBe(true);
  });

  it("parses an ingest_error event", () => {
    const result = IngestErrorEventSchema.safeParse({
      event_id: "evt_9",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:08.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "ingest_error",
      message: "invalid payload"
    });

    expect(result.success).toBe(true);
  });

  it("parses a prompt.submitted event", () => {
    const payload = {
      event_id: "evt_10",
      session_id: "ses_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "prompt.submitted",
      prompt_id: "prompt_1",
      prompt_chars: 27
    };

    const result = PromptSubmittedEventSchema.safeParse(payload);
    const unionResult = AnyEventSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(unionResult.success).toBe(true);
  });

  it("parses an assistant.responded event", () => {
    const payload = {
      event_id: "evt_11",
      session_id: "ses_1",
      timestamp: "2026-05-27T10:00:10.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "assistant.responded",
      message_id: "msg_1",
      model: "sonnet-test",
      stop_reason: "end_turn",
      response_chars: 16
    };

    const result = AssistantRespondedEventSchema.safeParse(payload);
    const unionResult = AnyEventSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(unionResult.success).toBe(true);
  });

  it("parses a token.usage.recorded event", () => {
    const payload = {
      event_id: "evt_12",
      session_id: "ses_1",
      timestamp: "2026-05-27T10:00:10.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "token.usage.recorded",
      message_id: "msg_1",
      model: "sonnet-test",
      input_tokens: 120,
      output_tokens: 48,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 16,
      server_tool_use: "{\"web_search_requests\":0}",
      usage_source: "claude-transcript"
    };

    const result = TokenUsageRecordedEventSchema.safeParse(payload);
    const unionResult = AnyEventSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(unionResult.success).toBe(true);
  });

  it("parses the full AnyEventSchema surface", () => {
    expect(
      AnyEventSchema.safeParse({
        event_id: "evt_13",
        session_id: "ses_1",
        timestamp: "2026-05-25T08:00:09.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "tool.failed",
        tool_name: "edit_file",
        status: "failed",
        duration_ms: 9
      }).success
    ).toBe(true);
  });
});
