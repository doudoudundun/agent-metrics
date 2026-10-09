import { randomUUID } from "node:crypto";
import {
  deriveToolCallId,
  normalizeNativeId,
  toNormalizedEventV2,
  type AnyEvent,
  type EventNormalizationOptions,
  type NormalizedEventV2,
  type SourceAdapter,
  type SourceVendor
} from "@agent-metrics/event-schema";
import { diffTextStats } from "@agent-metrics/shared-utils";

type ToolStartObservation = {
  kind: "tool_start";
  toolName: string;
  argumentSummary: string;
  toolUseId?: string;
};

type ToolFinishObservation = {
  kind: "tool_finish";
  toolName: string;
  ok: boolean;
  durationMs: number;
  toolUseId?: string;
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

export function normalizeClaudeObservation(
  input: {
    sessionId: string;
    workspacePath: string;
    observation: ClaudeObservation;
  },
  options: EventNormalizationOptions = {}
): NormalizedEventV2 {
  const base = {
    event_id: randomUUID(),
    session_id: input.sessionId,
    timestamp: new Date().toISOString(),
    source_vendor: CLAUDE_SOURCE_VENDOR,
    source_adapter: CLAUDE_HOOK_ADAPTER,
    workspace_path: input.workspacePath
  };

  let legacy: AnyEvent;

  if (input.observation.kind === "tool_start") {
    legacy = {
      ...base,
      type: "tool.called",
      tool_call_id: resolveObservationToolCallId({
        sessionId: input.sessionId,
        timestamp: base.timestamp,
        toolName: input.observation.toolName,
        eventId: base.event_id,
        toolUseId: input.observation.toolUseId
      }),
      tool_name: input.observation.toolName,
      status: "started",
      argument_summary: input.observation.argumentSummary
    };
  } else if (input.observation.kind === "tool_finish") {
    const toolCallId = resolveObservationToolCallId({
      sessionId: input.sessionId,
      timestamp: base.timestamp,
      toolName: input.observation.toolName,
      eventId: base.event_id,
      toolUseId: input.observation.toolUseId
    });
    if (input.observation.ok) {
      legacy = {
        ...base,
        type: "tool.succeeded",
        tool_call_id: toolCallId,
        tool_name: input.observation.toolName,
        status: "succeeded",
        duration_ms: input.observation.durationMs
      };
    } else {
      legacy = {
        ...base,
        type: "tool.failed",
        tool_call_id: toolCallId,
        tool_name: input.observation.toolName,
        status: "failed",
        duration_ms: input.observation.durationMs
      };
    }
  } else {
    const totals = input.observation.files.reduce(
      (acc, file) => {
        const diff = diffTextStats(file.before, file.after);
        acc.insertions += diff.insertions;
        acc.deletions += diff.deletions;
        return acc;
      },
      { insertions: 0, deletions: 0 }
    );

    legacy = {
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

  const toolUseId =
    input.observation.kind === "tool_start" || input.observation.kind === "tool_finish"
      ? input.observation.toolUseId?.trim()
      : undefined;

  return toNormalizedEventV2(legacy, {
    sourceRecordNamespace: options.sourceRecordNamespace ?? "hook",
    ...options,
    ...(options.sourceRecordId === undefined && toolUseId && toolUseId.length > 0
      ? {
          sourceRecordId: toolUseId,
          toolCallId: options.toolCallId ?? normalizeNativeId(toolUseId) ?? undefined
        }
      : {})
  });
}

function resolveObservationToolCallId(input: {
  sessionId: string;
  timestamp: string;
  toolName: string;
  eventId: string;
  toolUseId?: string;
}): string {
  const nativeId = normalizeNativeId(input.toolUseId);
  if (nativeId !== null) {
    return nativeId;
  }

  return deriveToolCallId({
    sourceInstanceId: "claude:default",
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    toolName: input.toolName,
    sourceLocation: { eventId: input.eventId }
  });
}
