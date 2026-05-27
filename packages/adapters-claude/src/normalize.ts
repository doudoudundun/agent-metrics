import { randomUUID } from "node:crypto";
import type { AnyEvent, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";
import { diffTextStats } from "@agent-metrics/shared-utils";

type ToolStartObservation = {
  kind: "tool_start";
  toolName: string;
  argumentSummary: string;
};

type ToolFinishObservation = {
  kind: "tool_finish";
  toolName: string;
  ok: boolean;
  durationMs: number;
};

type EditAppliedObservation = {
  kind: "edit_applied";
  toolName: string;
  files: Array<{
    path: string;
    before: string;
    after: string;
  }>;
};

type ClaudeObservation = ToolStartObservation | ToolFinishObservation | EditAppliedObservation;

const CLAUDE_SOURCE_VENDOR: SourceVendor = "claude-code";
const CLAUDE_HOOK_ADAPTER: SourceAdapter = "claude-hook";

export function normalizeClaudeObservation(input: {
  sessionId: string;
  workspacePath: string;
  observation: ClaudeObservation;
}): AnyEvent {
  const base = {
    event_id: randomUUID(),
    session_id: input.sessionId,
    timestamp: new Date().toISOString(),
    source_vendor: CLAUDE_SOURCE_VENDOR,
    source_adapter: CLAUDE_HOOK_ADAPTER,
    workspace_path: input.workspacePath
  };

  if (input.observation.kind === "tool_start") {
    return {
      ...base,
      type: "tool.called",
      tool_name: input.observation.toolName,
      status: "started",
      argument_summary: input.observation.argumentSummary
    };
  }

  if (input.observation.kind === "tool_finish") {
    if (input.observation.ok) {
      return {
        ...base,
        type: "tool.succeeded",
        tool_name: input.observation.toolName,
        status: "succeeded",
        duration_ms: input.observation.durationMs
      };
    }

    return {
      ...base,
      type: "tool.failed",
      tool_name: input.observation.toolName,
      status: "failed",
      duration_ms: input.observation.durationMs
    };
  }

  const totals = input.observation.files.reduce(
    (acc, file) => {
      const diff = diffTextStats(file.before, file.after);
      acc.insertions += diff.insertions;
      acc.deletions += diff.deletions;
      return acc;
    },
    { insertions: 0, deletions: 0 }
  );

  return {
    ...base,
    type: "code.edit.applied",
    tool_name: input.observation.toolName,
    files_changed: input.observation.files.map((file) => file.path),
    file_count: input.observation.files.length,
    insertions: totals.insertions,
    deletions: totals.deletions,
    edit_operation_count: 1
  };
}
