import { basename } from "node:path";
import type { AnyEvent, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

const CODEX_SOURCE_VENDOR: SourceVendor = "codex";
const CODEX_ROLLOUT_ADAPTER: SourceAdapter = "codex-rollout";

export type CodexProviderConfig = {
  baseUrl: string | null;
  host: string | null;
};

type PendingCodexToolCall = {
  sessionId: string;
  workspacePath: string;
  timestamp: string;
  toolName: string;
  argumentSummary: string;
};

export function extractCodexEventsFromRollout(input: {
  filePath: string;
  contents: string;
  sessionModels?: Record<string, string>;
  providerConfigs?: Record<string, CodexProviderConfig>;
}): AnyEvent[] {
  const lines = input.contents.split(/\r?\n/u).filter((line) => line.length > 0);
  const events: AnyEvent[] = [];
  const pendingToolCalls = new Map<string, PendingCodexToolCall>();
  let sessionMeta:
    | {
        sessionId: string;
        timestamp: string;
        workspacePath: string;
        providerId: string | null;
      }
    | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    const parsed = parseJsonRecord(line);
    if (parsed === null) {
      continue;
    }

    const eventType = normalizeOptionalString(parsed.type);
    const payload = asRecord(parsed.payload);

    if (eventType === "session_meta" && payload !== null) {
      const sessionId =
        normalizeOptionalString(payload.id) ?? inferSessionIdFromPath(input.filePath);
      const timestamp =
        normalizeOptionalString(payload.timestamp) ??
        normalizeOptionalString(parsed.timestamp);

      if (sessionId === null || timestamp === null) {
        continue;
      }

      sessionMeta = {
        sessionId,
        timestamp,
        workspacePath: normalizeOptionalString(payload.cwd) ?? ".",
        providerId: normalizeOptionalString(payload.model_provider)
      };
      events.push({
        event_id: `codex:session:${sessionId}:started`,
        session_id: sessionId,
        timestamp,
        source_vendor: CODEX_SOURCE_VENDOR,
        source_adapter: CODEX_ROLLOUT_ADAPTER,
        workspace_path: sessionMeta.workspacePath,
        type: "session.started"
      });
      continue;
    }

    if (eventType === "response_item" && payload !== null) {
      const payloadType = normalizeOptionalString(payload.type);
      const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
      const timestamp =
        normalizeOptionalString(parsed.timestamp) ??
        sessionMeta?.timestamp ??
        new Date(0).toISOString();

      if (sessionId !== null && payloadType === "custom_tool_call") {
        const callId = normalizeOptionalString(payload.call_id);
        if (callId === null) {
          continue;
        }

        const toolName = normalizeOptionalString(payload.name) ?? "unknown";
        const argumentSummary = serializeArgumentSummary(payload.input);

        pendingToolCalls.set(callId, {
          sessionId,
          workspacePath: sessionMeta?.workspacePath ?? ".",
          timestamp,
          toolName,
          argumentSummary
        });
        events.push({
          event_id: `codex:session:${sessionId}:tool:${callId}:started`,
          session_id: sessionId,
          timestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: sessionMeta?.workspacePath ?? ".",
          type: "tool.called",
          tool_name: toolName,
          status: "started",
          argument_summary: argumentSummary
        });
        continue;
      }

      if (payloadType === "custom_tool_call_output") {
        const callId = normalizeOptionalString(payload.call_id);
        const pending = callId ? pendingToolCalls.get(callId) : null;

        if (callId === null || pending == null) {
          continue;
        }

        const result = parseCustomToolOutput(normalizeOptionalString(payload.output));

        if (result.success) {
          events.push({
            event_id: `codex:session:${pending.sessionId}:tool:${callId}:succeeded`,
            session_id: pending.sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: pending.workspacePath,
            type: "tool.succeeded",
            tool_name: pending.toolName,
            status: "succeeded",
            duration_ms: result.durationMs
          });
        } else {
          events.push({
            event_id: `codex:session:${pending.sessionId}:tool:${callId}:failed`,
            session_id: pending.sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: pending.workspacePath,
            type: "tool.failed",
            tool_name: pending.toolName,
            status: "failed",
            duration_ms: result.durationMs
          });
        }
        pendingToolCalls.delete(callId);
        continue;
      }
    }

    if (eventType === "event_msg" && payload !== null) {
      const payloadType = normalizeOptionalString(payload.type);
      const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
      const timestamp =
        normalizeOptionalString(parsed.timestamp) ??
        sessionMeta?.timestamp ??
        new Date(0).toISOString();
      const eventKey = buildEventKey(parsed, payloadType ?? "event_msg", lineIndex);

      if (sessionId !== null && payloadType === "user_message") {
        const promptText = normalizeOptionalString(payload.message) ?? "";

        events.push({
          event_id: `codex:session:${sessionId}:prompt:${eventKey}`,
          session_id: sessionId,
          timestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: sessionMeta?.workspacePath ?? ".",
          type: "prompt.submitted",
          prompt_id: `prompt_${eventKey}`,
          prompt_chars: promptText.length
        });
        continue;
      }

      if (sessionId !== null && payloadType === "agent_message") {
        const responseText = normalizeOptionalString(payload.message) ?? "";
        const providerId = sessionMeta?.providerId ?? null;
        const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;

        events.push({
          event_id: `codex:session:${sessionId}:response:${eventKey}`,
          session_id: sessionId,
          timestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: sessionMeta?.workspacePath ?? ".",
          type: "assistant.responded",
          message_id: `response_${eventKey}`,
          model: input.sessionModels?.[sessionId] ?? null,
          stop_reason: normalizeOptionalString(payload.phase) ?? null,
          response_chars: responseText.length,
          provider_id: providerId,
          provider_base_url: providerConfig?.baseUrl ?? null,
          provider_host: providerConfig?.host ?? null
        });
        continue;
      }

      if (sessionId !== null && payloadType === "web_search_end") {
        events.push({
          event_id: `codex:session:${sessionId}:web_search:${buildEventKey(
            parsed,
            payloadType,
            lineIndex,
            normalizeOptionalString(payload.call_id)
          )}:tool`,
          session_id: sessionId,
          timestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: sessionMeta?.workspacePath ?? ".",
          type: "tool.succeeded",
          tool_name: "WebSearch",
          status: "succeeded",
          duration_ms: 0
        });
        continue;
      }

      if (sessionId !== null && payloadType === "patch_apply_end") {
        const callId = buildEventKey(
          parsed,
          payloadType,
          lineIndex,
          normalizeOptionalString(payload.call_id)
        );
        const success = payload.success === true;

        if (success) {
          events.push({
            event_id: `codex:session:${sessionId}:patch:${callId}:tool`,
            session_id: sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: sessionMeta?.workspacePath ?? ".",
            type: "tool.succeeded",
            tool_name: "apply_patch",
            status: "succeeded",
            duration_ms: 0
          });
        } else {
          events.push({
            event_id: `codex:session:${sessionId}:patch:${callId}:tool`,
            session_id: sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: sessionMeta?.workspacePath ?? ".",
            type: "tool.failed",
            tool_name: "apply_patch",
            status: "failed",
            duration_ms: 0
          });
        }

        if (success) {
          const changes = asRecord(payload.changes) ?? {};
          const filesChanged = Object.keys(changes);
          const totals = summarizePatchChanges(changes);

          events.push({
            event_id: `codex:session:${sessionId}:patch:${callId}:edit`,
            session_id: sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: sessionMeta?.workspacePath ?? ".",
            type: "code.edit.applied",
            tool_name: "apply_patch",
            files_changed: filesChanged,
            file_count: filesChanged.length,
            insertions: totals.insertions,
            deletions: totals.deletions,
            edit_operation_count: 1
          });
        }
        continue;
      }
    }

    if (
      eventType !== "event_msg" ||
      payload === null ||
      normalizeOptionalString(payload.type) !== "token_count"
    ) {
      continue;
    }

    const info = asRecord(payload.info);
    if (info === null) {
      continue;
    }

    const totalUsage = asRecord(info.total_token_usage);
    const lastUsage = asRecord(info.last_token_usage);
    if (lastUsage === null && totalUsage === null) {
      continue;
    }

    const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
    if (sessionId === null) {
      continue;
    }

    const totalTokens =
      normalizeInteger(totalUsage?.total_tokens) ??
      normalizeInteger(lastUsage?.total_tokens);
    if (totalTokens === null) {
      continue;
    }

    const inputTokens = normalizeInteger(lastUsage?.input_tokens) ?? 0;
    const cacheReadTokens = normalizeInteger(lastUsage?.cached_input_tokens) ?? 0;
    const outputTokens =
      (normalizeInteger(lastUsage?.output_tokens) ?? 0) +
      (normalizeInteger(lastUsage?.reasoning_output_tokens) ?? 0);

    if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
      continue;
    }

    const providerId = sessionMeta?.providerId ?? null;
    const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;

    events.push({
      event_id: `codex:session:${sessionId}:usage:${totalTokens}`,
      session_id: sessionId,
      timestamp:
        normalizeOptionalString(parsed.timestamp) ??
        sessionMeta?.timestamp ??
        new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "token.usage.recorded",
      message_id: `usage_${totalTokens}`,
      model: input.sessionModels?.[sessionId] ?? null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      server_tool_use: "{}",
      usage_source: "codex-rollout",
      provider_id: providerId,
      provider_base_url: providerConfig?.baseUrl ?? null,
      provider_host: providerConfig?.host ?? null
    });
  }

  return events.sort(compareCodexEvents);
}

export function inferSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const match = /^rollout-.*-([0-9a-f]{8,}-[0-9a-f-]+)\.jsonl$/iu.exec(name);
  return match?.[1] ?? null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function buildEventKey(
  parsed: Record<string, unknown>,
  payloadType: string,
  lineIndex: number,
  callId?: string | null
): string {
  if (callId) {
    return callId;
  }

  const timestamp = normalizeOptionalString(parsed.timestamp) ?? "unknown";
  return `${timestamp.replaceAll(/[:.]/gu, "-")}:${payloadType}:${lineIndex}`;
}

function compareCodexEvents(left: AnyEvent, right: AnyEvent): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp.localeCompare(right.timestamp);
  }

  const priorityDifference = getEventSortPriority(left) - getEventSortPriority(right);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return left.event_id.localeCompare(right.event_id);
}

function getEventSortPriority(event: AnyEvent): number {
  switch (event.type) {
    case "session.started":
      return 0;
    case "prompt.submitted":
      return 1;
    case "tool.called":
      return 2;
    case "assistant.responded":
      return 3;
    case "tool.succeeded":
    case "tool.failed":
      return 4;
    case "code.edit.applied":
      return 5;
    case "token.usage.recorded":
      return 6;
    case "session.ended":
      return 7;
    default:
      return 99;
  }
}

function parseCustomToolOutput(value: string | null): {
  success: boolean;
  durationMs: number;
} {
  if (value === null) {
    return {
      success: false,
      durationMs: 0
    };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    const record = asRecord(parsed);
    const metadata = asRecord(record?.metadata);
    const exitCode = normalizeInteger(metadata?.exit_code);
    const durationSeconds = normalizeNumber(metadata?.duration_seconds);

    if (exitCode !== null) {
      return {
        success: exitCode === 0,
        durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : 0
      };
    }
  } catch {
    return {
      success: false,
      durationMs: 0
    };
  }

  return {
    success: false,
    durationMs: 0
  };
}

function summarizePatchChanges(changes: Record<string, unknown>): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;

  for (const value of Object.values(changes)) {
    const change = asRecord(value);
    if (change === null) {
      continue;
    }

    const diff = normalizeOptionalString(change.unified_diff);
    if (diff !== null) {
      const counts = countUnifiedDiffLines(diff);
      insertions += counts.insertions;
      deletions += counts.deletions;
      continue;
    }

    if (normalizeOptionalString(change.type) === "add") {
      insertions += countContentLines(normalizeOptionalString(change.content));
    }
  }

  return {
    insertions,
    deletions
  };
}

function countUnifiedDiffLines(diff: string): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/u)) {
    if (
      line.startsWith("@@") ||
      line.startsWith("+++") ||
      line.startsWith("---")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      insertions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return {
    insertions,
    deletions
  };
}

function countContentLines(value: string | null): number {
  if (value === null || value.length === 0) {
    return 0;
  }

  const normalized = value.replace(/\r\n/gu, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function serializeArgumentSummary(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
