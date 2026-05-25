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
    expect((event as { tool_name: string }).tool_name).toBe("Read");
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
    expect((event as { tool_name: string }).tool_name).toBe("Read");
    expect((event as { duration_ms: number }).duration_ms).toBe(123);
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
    expect((event as { tool_name: string }).tool_name).toBe("Read");
    expect((event as { duration_ms: number }).duration_ms).toBe(456);
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
    expect((event as { file_count: number }).file_count).toBe(1);
    expect((event as { insertions: number }).insertions).toBe(2);
    expect((event as { deletions: number }).deletions).toBe(0);
  });
});
