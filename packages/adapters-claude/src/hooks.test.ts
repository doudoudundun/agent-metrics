import { AnyEventSchema } from "@agent-metrics/event-schema";
import { describe, expect, it } from "vitest";
import { buildClaudeRawEnvelope, extractMutationTargets, normalizeClaudeHookEvent } from "./hooks.js";

describe("normalizeClaudeHookEvent", () => {
  it("maps PreToolUse into a tool.called event", () => {
    const event = normalizeClaudeHookEvent({
      session_id: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {
        file_path: "package.json"
      }
    });

    expect(event?.type).toBe("tool.called");
    expect(event).toMatchObject({
      session_id: "ses_1",
      workspace_path: "D:/projects/dev/agent-metrics",
      tool_name: "Read",
      status: "started"
    });
  });

  it("maps PostToolUseFailure into a tool.failed event", () => {
    const event = normalizeClaudeHookEvent({
      session_id: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Edit"
    });

    expect(event?.type).toBe("tool.failed");
    expect(event).toMatchObject({
      tool_name: "Edit",
      status: "failed",
      duration_ms: 0
    });
  });

  it("returns null for unknown hook events", () => {
    const event = normalizeClaudeHookEvent({
      session_id: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      hook_event_name: "Notification"
    });

    expect(event).toBeNull();
  });

  it("replaces invalid timestamps with schema-safe ISO timestamps", () => {
    const event = normalizeClaudeHookEvent({
      session_id: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      hook_event_name: "SessionStart",
      timestamp: "not-a-timestamp"
    });

    expect(event).not.toBeNull();
    expect(event?.timestamp).not.toBe("not-a-timestamp");
    expect(() => AnyEventSchema.parse(event)).not.toThrow();
  });
});

describe("extractMutationTargets", () => {
  it("returns the file path for Edit inputs", () => {
    expect(
      extractMutationTargets({
        toolName: "Edit",
        toolInput: {
          file_path: "src/app.ts"
        }
      })
    ).toEqual(["src/app.ts"]);
  });

  it("returns the file path for Bash sed -i edits", () => {
    expect(
      extractMutationTargets({
        toolName: "Bash",
        toolInput: {
          command: "sed -i '1d' src/app.ts"
        }
      })
    ).toEqual(["src/app.ts"]);
  });

  it("returns the file path for Bash rm deletions", () => {
    expect(
      extractMutationTargets({
        toolName: "Bash",
        toolInput: {
          command: "rm src/app.ts"
        }
      })
    ).toEqual(["src/app.ts"]);
  });
});

describe("buildClaudeRawEnvelope", () => {
  it("wraps Claude hook payloads in a raw envelope with stable metadata", () => {
    const envelope = buildClaudeRawEnvelope({
      session_id: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "tool_1",
      transcript_path: "C:/Users/test/.claude/projects/demo/session.jsonl"
    });

    expect(envelope).toMatchObject({
      hook_event_name: "PreToolUse",
      session_id: "ses_1",
      tool_name: "Read",
      tool_use_id: "tool_1",
      workspace_path: "D:/projects/dev/agent-metrics",
      transcript_path: "C:/Users/test/.claude/projects/demo/session.jsonl",
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Read"
      }
    });
    expect(envelope.raw_event_id).toEqual(expect.any(String));
    expect(envelope.captured_at).toEqual(expect.any(String));
  });
});
