import { normalizeNativeId, normalizeWorkspacePath, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";
import { diffTextStats } from "@agent-metrics/shared-utils";

const DSH_SOURCE_VENDOR: SourceVendor = "dsh";
const DSH_SOURCE_ADAPTER: SourceAdapter = "dsh-jsonl";
const PACKED_ROW_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);

export type DshSessionHeader = {
  id: string;
  createdAt: number;
  cwd?: string;
};

export type DshParseState = {
  lastModel: string | null;
  lastProviderId: string | null;
  toolStarts: Map<string, { name: string; startedAt: number; args: Record<string, unknown> | null }>;
};

export function createDshParseState(): DshParseState {
  return {
    lastModel: null,
    lastProviderId: null,
    toolStarts: new Map()
  };
}

export function normalizeDshSessionHeader(header: DshSessionHeader): NormalizedEventV2[] {
  const workspacePath = normalizeWorkspacePath(header.cwd);
  return toV2Events([
    {
      event_id: buildEventId(`${header.id}:started`),
      session_id: header.id,
      timestamp: toIsoTimestamp(header.createdAt),
      source_vendor: DSH_SOURCE_VENDOR,
      source_adapter: DSH_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "session.started"
    }
  ]);
}

export function normalizeDshLogRecord(
  record: unknown,
  sessionId: string,
  workspacePath: string,
  state: DshParseState
): NormalizedEventV2[] {
  const parsed = asRecord(record);
  if (parsed === null) {
    return [];
  }

  const type = readString(parsed.type);
  if (type === null || PACKED_ROW_TYPES.has(type)) {
    return [];
  }

  if (type === "user/message") {
    return toV2Events(normalizeUserMessage(parsed, sessionId, workspacePath));
  }

  if (type === "tool/call") {
    return toV2Events(normalizeToolCall(parsed, sessionId, workspacePath, state));
  }

  if (type === "tool/result") {
    return toV2Events(normalizeToolResult(parsed, sessionId, workspacePath, state));
  }

  if (type === "assistant/message") {
    return toV2Events(normalizeAssistantMessage(parsed, sessionId, workspacePath, state));
  }

  if (type === "request/header") {
    rememberRequestHeader(parsed, state);
    return [];
  }

  return [];
}

function normalizeUserMessage(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string
): AnyEvent[] {
  const time = readTimestamp(record.time);
  const data = asRecord(record.data);
  if (time === null || data === null) {
    return [];
  }

  const source = asRecord(data.source);
  if (readString(source?.kind) !== "user") {
    return [];
  }

  const seq = readNonNegativeInt(record.seq);
  const messageId = readString(data.id) ?? (seq !== null ? `user:${seq}` : null);
  if (messageId === null) {
    return [];
  }

  return [
    {
      event_id: buildEventId(`${sessionId}:prompt:${messageId}`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: DSH_SOURCE_VENDOR,
      source_adapter: DSH_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "prompt.submitted",
      prompt_id: messageId,
      prompt_chars: extractTextLength(data.content)
    }
  ];
}

function normalizeToolCall(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: DshParseState
): AnyEvent[] {
  const time = readTimestamp(record.time);
  const data = asRecord(record.data);
  if (time === null || data === null) {
    return [];
  }

  const toolCallId = readString(data.callId);
  const toolName = readString(data.name);
  if (toolCallId === null || toolName === null) {
    return [];
  }

  state.toolStarts.set(toolCallId, { name: toolName, startedAt: time, args: parseToolArguments(data.arguments) });
  return [
    {
      event_id: buildEventId(`${sessionId}:tool:${toolCallId}:started`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: DSH_SOURCE_VENDOR,
      source_adapter: DSH_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "tool.called",
      tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
      tool_name: toolName,
      status: "started",
      argument_summary: typeof data.arguments === "string" ? data.arguments : serializeCompactJson(data.arguments)
    }
  ];
}

function normalizeToolResult(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: DshParseState
): AnyEvent[] {
  const time = readTimestamp(record.time);
  const data = asRecord(record.data);
  if (time === null || data === null) {
    return [];
  }

  const message = asRecord(data.message);
  const source = asRecord(message?.source);
  const content = Array.isArray(message?.content) ? message.content : [];
  const firstBlock = asRecord(content[0]);
  const toolCallId =
    readString(source?.callId) ??
    readString(firstBlock?.toolCallId) ??
    readString(asRecord(data.error)?.code);
  if (toolCallId === null) {
    return [];
  }

  const started = state.toolStarts.get(toolCallId);
  const toolName = started?.name ?? "unknown";
  const durationMs = Math.max(0, time - (started?.startedAt ?? time));
  const failed = firstBlock?.isError === true || asRecord(data.error) !== null;
  if (failed) {
    return [
      {
        event_id: buildEventId(`${sessionId}:tool:${toolCallId}:failed`),
        session_id: sessionId,
        timestamp: toIsoTimestamp(time),
        source_vendor: DSH_SOURCE_VENDOR,
        source_adapter: DSH_SOURCE_ADAPTER,
        workspace_path: workspacePath,
        type: "tool.failed",
        tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
        tool_name: toolName,
        status: "failed",
        duration_ms: durationMs
      }
    ];
  }

  const events: AnyEvent[] = [
    {
      event_id: buildEventId(`${sessionId}:tool:${toolCallId}:succeeded`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: DSH_SOURCE_VENDOR,
      source_adapter: DSH_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "tool.succeeded",
      tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
      tool_name: toolName,
      status: "succeeded",
      duration_ms: durationMs
    }
  ];

  const edit = buildDshCodeEdit(toolName, started?.args ?? null);
  if (edit !== null) {
    events.push({
      event_id: buildEventId(`${sessionId}:tool:${toolCallId}:edit`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: DSH_SOURCE_VENDOR,
      source_adapter: DSH_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "code.edit.applied",
      ...edit
    });
  }

  return events;
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function buildDshCodeEdit(
  toolName: string,
  args: Record<string, unknown> | null
): { tool_name: string; files_changed: string[]; file_count: number; insertions: number; deletions: number; edit_operation_count: number } | null {
  if (args === null) {
    return null;
  }

  const normalizedTool = toolName.toLowerCase();
  const path = readString(args.file_path) ?? readString(args.path) ?? readString(args.filePath);
  if (path === null) {
    return null;
  }

  if (normalizedTool === "edit") {
    const diff = diffTextStats(readString(args.old_string) ?? "", readString(args.new_string) ?? "");
    return {
      tool_name: toolName,
      files_changed: [path],
      file_count: 1,
      insertions: diff.insertions,
      deletions: diff.deletions,
      edit_operation_count: 1
    };
  }

  if (normalizedTool === "write") {
    const diff = diffTextStats("", readString(args.content) ?? "");
    return {
      tool_name: toolName,
      files_changed: [path],
      file_count: 1,
      insertions: diff.insertions,
      deletions: diff.deletions,
      edit_operation_count: 1
    };
  }

  return null;
}

function normalizeAssistantMessage(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: DshParseState
): AnyEvent[] {
  const time = readTimestamp(record.time);
  const data = asRecord(record.data);
  if (time === null || data === null) {
    return [];
  }

  const message = asRecord(data.message);
  const seq = readNonNegativeInt(record.seq);
  const messageId = readString(message?.id) ?? (seq !== null ? `assistant:${seq}` : null);
  if (messageId === null) {
    return [];
  }

  const source = asRecord(message?.source);
  const model = readString(source?.model) ?? state.lastModel;
  const providerId = readString(source?.provider) ?? state.lastProviderId;
  if (model !== null) {
    state.lastModel = model;
  }
  if (providerId !== null) {
    state.lastProviderId = providerId;
  }

  const events: AnyEvent[] = [
    {
      event_id: buildEventId(`${sessionId}:assistant:${messageId}`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: DSH_SOURCE_VENDOR,
      source_adapter: DSH_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "assistant.responded",
      message_id: messageId,
      model,
      stop_reason: null,
      response_chars: extractTextLength(message?.content),
      provider_id: providerId,
      provider_base_url: null,
      provider_host: null
    }
  ];

  const usage = asRecord(data.usage);
  if (usage !== null) {
    const inputTokens = readNonNegativeInt(usage.inputTokens) ?? 0;
    const outputTokens = readNonNegativeInt(usage.outputTokens) ?? 0;
    const cacheReadTokens = readNonNegativeInt(usage.cacheReadTokens) ?? 0;
    const cacheWriteTokens = readNonNegativeInt(usage.cacheWriteTokens) ?? 0;
    if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0) {
      events.push({
        event_id: buildEventId(`${sessionId}:usage:${messageId}`),
        session_id: sessionId,
        timestamp: toIsoTimestamp(time),
        source_vendor: DSH_SOURCE_VENDOR,
        source_adapter: DSH_SOURCE_ADAPTER,
        workspace_path: workspacePath,
        type: "token.usage.recorded",
        message_id: messageId,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheWriteTokens,
        cache_read_input_tokens: cacheReadTokens,
        server_tool_use: "{}",
        usage_source: "dsh-usage",
        provider_id: providerId,
        provider_base_url: null,
        provider_host: null
      });
    }
  }

  return events;
}

function rememberRequestHeader(record: Record<string, unknown>, state: DshParseState): void {
  const data = asRecord(record.data);
  const header = asRecord(data?.header);
  const config = asRecord(header?.config);
  const model = readString(config?.model);
  const provider = readString(config?.provider);
  if (model !== null) {
    state.lastModel = model;
  }
  if (provider !== null) {
    state.lastProviderId = provider;
  }
}

function extractTextLength(value: unknown): number {
  if (!Array.isArray(value)) {
    return typeof value === "string" ? value.length : 0;
  }

  return value.reduce((total, entry) => {
    const record = asRecord(entry);
    if (record === null || record.type !== "text") {
      return total;
    }
    return total + (readString(record.text)?.length ?? 0);
  }, 0);
}

function buildEventId(suffix: string): string {
  return `dsh:${suffix}`;
}

function toV2Events(events: AnyEvent[]): NormalizedEventV2[] {
  return events.map((event) => toNormalizedEventV2(event, { sourceRecordId: event.event_id }));
}

function toIsoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function serializeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
