import { randomUUID } from "node:crypto";
import type { AnyEvent } from "@agent-metrics/event-schema";

export type ClaudeTranscriptObservation =
  | {
      kind: "prompt_submitted";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      promptId: string;
      promptChars: number;
    }
  | {
      kind: "assistant_responded";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      messageId: string;
      model: string | null;
      stopReason: string | null;
      responseChars: number;
    }
  | {
      kind: "token_usage_recorded";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      messageId: string;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      serverToolUse: string;
    };

export function extractClaudeTranscriptObservations(record: unknown): ClaudeTranscriptObservation[] {
  const row = asRecord(record);
  if (row === null) {
    return [];
  }

  const message = asRecord(row.message);
  if (message === null) {
    return [];
  }

  const sessionId = normalizeOptionalString(row.sessionId ?? row.session_id);
  const workspacePath = normalizeOptionalString(row.cwd ?? row.workspace_path);
  const timestamp = normalizeValidTimestamp(row.timestamp);
  if (sessionId === undefined || workspacePath === undefined || timestamp === undefined) {
    return [];
  }

  const rowType = normalizeOptionalString(row.type);
  const role = normalizeOptionalString(message.role);

  if (rowType === "user" || role === "user") {
    const promptText = flattenClaudeContent(message.content);
    const promptId = normalizeOptionalString(row.promptId ?? row.prompt_id ?? row.uuid);
    if (promptId === undefined) {
      return [];
    }

    return [
      {
        kind: "prompt_submitted",
        sessionId,
        workspacePath,
        timestamp,
        promptId,
        promptChars: promptText.length
      }
    ];
  }

  if (rowType !== "assistant" && role !== "assistant") {
    return [];
  }

  const observations: ClaudeTranscriptObservation[] = [];
  const messageId = normalizeOptionalString(message.id ?? row.message_id);
  const model = normalizeNullableString(message.model ?? row.model);

  if (messageId !== undefined && isTerminalAssistantMessage(message)) {
    observations.push({
      kind: "assistant_responded",
      sessionId,
      workspacePath,
      timestamp,
      messageId,
      model,
      stopReason: normalizeNullableString(message.stop_reason),
      responseChars: flattenClaudeContent(message.content).length
    });
  }

  const usage = asRecord(message.usage);
  if (messageId !== undefined && usage !== null) {
    observations.push({
      kind: "token_usage_recorded",
      sessionId,
      workspacePath,
      timestamp,
      messageId,
      model,
      inputTokens: normalizeNonNegativeInteger(usage.input_tokens),
      outputTokens: normalizeNonNegativeInteger(usage.output_tokens),
      cacheCreationInputTokens: normalizeNonNegativeInteger(usage.cache_creation_input_tokens),
      cacheReadInputTokens: normalizeNonNegativeInteger(usage.cache_read_input_tokens),
      serverToolUse: serializeCompactJson(usage.server_tool_use)
    });
  }

  return observations;
}

export function normalizeClaudeTranscriptObservation(
  observation: ClaudeTranscriptObservation
): AnyEvent {
  const base = {
    event_id: randomUUID(),
    session_id: observation.sessionId,
    timestamp: observation.timestamp,
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: observation.workspacePath
  };

  if (observation.kind === "prompt_submitted") {
    return {
      ...base,
      type: "prompt.submitted",
      prompt_id: observation.promptId,
      prompt_chars: observation.promptChars
    };
  }

  if (observation.kind === "assistant_responded") {
    return {
      ...base,
      type: "assistant.responded",
      message_id: observation.messageId,
      model: observation.model,
      stop_reason: observation.stopReason,
      response_chars: observation.responseChars
    };
  }

  return {
    ...base,
    type: "token.usage.recorded",
    message_id: observation.messageId,
    model: observation.model,
    input_tokens: observation.inputTokens,
    output_tokens: observation.outputTokens,
    cache_creation_input_tokens: observation.cacheCreationInputTokens,
    cache_read_input_tokens: observation.cacheReadInputTokens,
    server_tool_use: observation.serverToolUse,
    usage_source: "claude-transcript"
  };
}

function isTerminalAssistantMessage(message: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(message, "stop_reason")) {
    return false;
  }

  return flattenClaudeContent(message.content).length > 0;
}

function flattenClaudeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => flattenClaudeContentEntry(entry))
    .filter((entry) => entry.length > 0)
    .join("\n");
}

function flattenClaudeContentEntry(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }

  const block = asRecord(entry);
  if (block === null) {
    return "";
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  if (typeof block.content === "string") {
    return block.content;
  }

  if (Array.isArray(block.content)) {
    return flattenClaudeContent(block.content);
  }

  return "";
}

function serializeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeValidTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}
