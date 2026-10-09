import { NormalizedEventV2Schema } from "@agent-metrics/event-schema";
import { describe, expect, it } from "vitest";
import { normalizeClaudeObservation } from "./normalize.js";

describe("normalizeClaudeObservation", () => {
  it("maps tool start observations into tool.called events", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "tool_start",
        toolName: "Read",
        argumentSummary: "Read package.json"
      }
    });

    expect(event.type).toBe("tool.called");
    expect(event.schema_version).toBe(2);
    expect((event as { tool_name: string }).tool_name).toBe("Read");
    expect((event as { tool_call_id: string }).tool_call_id).toMatch(/^derived:/);
    expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
  });

  it("uses native tool_use_id when provided on tool observations", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "tool_start",
        toolName: "Read",
        argumentSummary: "Read package.json",
        toolUseId: "toolu_123"
      }
    });

    expect((event as { tool_call_id: string }).tool_call_id).toBe("native:toolu_123");
    expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
  });

  it("maps successful tool finish observations into tool.succeeded events", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "tool_finish",
        toolName: "Read",
        ok: true,
        durationMs: 123
      }
    });

    expect(event.type).toBe("tool.succeeded");
    expect(event.schema_version).toBe(2);
    expect((event as { tool_name: string }).tool_name).toBe("Read");
    expect((event as { duration_ms: number }).duration_ms).toBe(123);
    expect((event as { tool_call_id: string }).tool_call_id).toMatch(/^derived:/);
    expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
  });

  it("maps failed tool finish observations into tool.failed events", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "tool_finish",
        toolName: "Read",
        ok: false,
        durationMs: 456
      }
    });

    expect(event.type).toBe("tool.failed");
    expect(event.schema_version).toBe(2);
    expect((event as { tool_name: string }).tool_name).toBe("Read");
    expect((event as { duration_ms: number }).duration_ms).toBe(456);
    expect((event as { tool_call_id: string }).tool_call_id).toMatch(/^derived:/);
    expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
  });

  it("maps edit observations into code.edit.applied events", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "edit_applied",
        toolName: "Edit",
        files: [
          {
            path: "README.md",
            before: "# Agent Metrics\n",
            after: "# Agent Metrics\n\nUpdated\n"
          }
        ]
      }
    });

    expect(event.type).toBe("code.edit.applied");
    expect(event.schema_version).toBe(2);
    expect((event as { file_count: number }).file_count).toBe(1);
    expect((event as { insertions: number }).insertions).toBe(2);
    expect((event as { deletions: number }).deletions).toBe(0);
    expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
  });
});
