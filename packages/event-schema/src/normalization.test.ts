import { describe, expect, it } from "vitest";
import { NormalizedEventV2Schema } from "./events.js";
import { normalizeEventV2, toNormalizedEventV2 } from "./normalization.js";

describe("legacy event normalization", () => {
  it("converts a legacy tool event into a strict V2 event", () => {
    const result = normalizeEventV2({
      event_id: "legacy-tool-1",
      session_id: "session-1",
      timestamp: "2026-07-17T18:00:00+08:00",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "c:\\work\\.\\agent\\",
      type: "tool.called",
      tool_call_id: "native:tool-1",
      tool_name: "Read",
      status: "started",
      argument_summary: "{}"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.event).toMatchObject({
      schema_version: 2,
      session_id: "session-1",
      source_instance_id: "claude:default",
      adapter_instance_id: "claude-hook@claude:default",
      source_record_namespace: "hook",
      source_record_id: "legacy-tool-1",
      workspace_path: "C:/work/agent",
      tool_call_id: "native:tool-1"
    });
    expect(NormalizedEventV2Schema.safeParse(result.event).success).toBe(true);
  });

  it("preserves explicit V2 provenance and identity without remapping it", () => {
    const event = {
      schema_version: 2 as const,
      event_id: "v2:cursor:default:composer:token.usage.recorded:abc",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_vendor: "cursor" as const,
      source_adapter: "cursor-ide" as const,
      source_instance_id: "cursor:default",
      adapter_instance_id: "cursor-ide@cursor:default",
      source_record_namespace: "composer",
      source_record_id: "generation-1",
      workspace_path: ".",
      type: "token.usage.recorded" as const,
      message_id: "message-1",
      model: null,
      input_tokens: 10,
      input_token_semantics: "delta" as const,
      usage_measurement: "session-context-snapshot" as const,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: "{}",
      usage_source: "cursor-composer-context" as const,
      provider_id: "unknown"
    };

    const result = normalizeEventV2(event);

    expect(result).toEqual({ ok: true, event });
  });

  it("derives a replayable tool identity when legacy input has no native ID", () => {
    const result = normalizeEventV2(
      {
        event_id: "hook-record-1",
        session_id: "session-1",
        timestamp: "2026-07-17T10:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: ".",
        type: "tool.called",
        tool_name: "Read",
        status: "started",
        argument_summary: "{}"
      },
      {
        sourceSequence: 7,
        sourceLocation: { path: "events.jsonl", line: 7 }
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.event.tool_call_id).toMatch(/^derived:[0-9a-f]{64}$/u);
  });

  it("quarantines invalid gross usage instead of clamping it", () => {
    const result = normalizeEventV2({
      event_id: "legacy-usage-1",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: ".",
      type: "token.usage.recorded",
      message_id: "message-1",
      model: null,
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 11,
      server_tool_use: "{}",
      usage_source: "codex-rollout"
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        diagnosticCode: "INVALID_USAGE"
      })
    );
  });
});

describe("toNormalizedEventV2", () => {
  it("returns the normalized V2 event for valid legacy input", () => {
    const event = toNormalizedEventV2({
      event_id: "legacy-tool-2",
      session_id: "session-1",
      timestamp: "2026-07-17T18:00:00+08:00",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: ".",
      type: "tool.called",
      tool_call_id: "native:tool-2",
      tool_name: "Read",
      status: "started",
      argument_summary: "{}"
    });

    expect(event.schema_version).toBe(2);
    expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
  });

  it("throws with the diagnostic code and message when the input cannot be normalized", () => {
    expect(() => toNormalizedEventV2({ type: "tool.called" })).toThrow("INVALID_EVENT");
  });
});
