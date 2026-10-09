import { normalizeNativeId, normalizeWorkspacePath, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";
import { diffTextStats } from "@agent-metrics/shared-utils";

const KIMICODE_SOURCE_VENDOR: SourceVendor = "kimicode";
const KIMICODE_SOURCE_ADAPTER: SourceAdapter = "kimicode-wire";

export type KimicodeSessionState = {
  id: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
  agents?: Record<string, { homedir?: string; type?: string }>;
};

export type KimicodeWireContext = {
  sessionId: string;
  workspacePath: string;
  agentId: string;
};

export type KimicodeWireParseState = {
  lastModel: string | null;
  lastProviderId: string | null;
  lastMessageId: string | null;
  toolStarts: Map<string, { name: string; startedAt: number; args: Record<string, unknown> | null }>;
};

export function createKimicodeWireParseState(): KimicodeWireParseState {
  return {
    lastModel: null,
    lastProviderId: null,
    lastMessageId: null,
    toolStarts: new Map()
  };
}

export function normalizeKimicodeSessionState(input: {
  state: KimicodeSessionState;
  workspacePath?: string;
}): NormalizedEventV2[] {
  const workspacePath = normalizeWorkspacePath(input.workspacePath ?? input.state.cwd);
  const createdAt = toIsoTimestamp(input.state.createdAt ?? Date.now());
  const events: AnyEvent[] = [
    {
      event_id: buildEventId(`session:${input.state.id}:started`),
      session_id: input.state.id,
      timestamp: createdAt,
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "session.started"
    }
  ];

  if (input.state.archived === true && typeof input.state.updatedAt === "number") {
    events.push({
      event_id: buildEventId(`session:${input.state.id}:ended`),
      session_id: input.state.id,
      timestamp: toIsoTimestamp(input.state.updatedAt),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "session.ended",
      duration_ms: Math.max(0, input.state.updatedAt - (input.state.createdAt ?? input.state.updatedAt))
    });
  }

  return toV2Events(events);
}

export function normalizeKimicodeWireRecord(
  record: unknown,
  context: KimicodeWireContext,
  state: KimicodeWireParseState
): NormalizedEventV2[] {
  const parsed = asRecord(record);
  if (parsed === null) {
    return [];
  }

  const unwrapped = unwrapWireRecord(parsed);
  const type = typeof unwrapped.type === "string" ? unwrapped.type : null;
  if (type === null) {
    return [];
  }

  if (type === "llm.request") {
    rememberModel(unwrapped, state);
    return [];
  }

  if (type === "turn.prompt") {
    return toV2Events(normalizeTurnPrompt(unwrapped, context));
  }

  if (type === "tool.call") {
    return toV2Events(normalizeToolCall(unwrapped, context, state));
  }

  if (type === "tool.result") {
    return toV2Events(normalizeToolResult(unwrapped, context, state));
  }

  if (type === "step.end") {
    rememberStepMessage(unwrapped, state);
    return toV2Events(normalizeStepEnd(unwrapped, context, state));
  }

  if (type === "usage.record") {
    return toV2Events(normalizeUsageRecord(unwrapped, context, state));
  }

  return [];
}

function unwrapWireRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (record.type !== "context.append_loop_event") {
    return record;
  }

  const nested = asRecord(record.event);
  if (nested === null) {
    return record;
  }

  return {
    ...nested,
    time: nested.time ?? record.time
  };
}

function rememberModel(record: Record<string, unknown>, state: KimicodeWireParseState): void {
  const modelAlias = readString(record.modelAlias) ?? readString(record.model);
  if (modelAlias !== null) {
    state.lastModel = modelAlias;
    state.lastProviderId = readString(record.provider) ?? splitProvider(modelAlias);
  }
}

function rememberStepMessage(record: Record<string, unknown>, state: KimicodeWireParseState): void {
  const messageId = readString(record.messageId);
  if (messageId !== null) {
    state.lastMessageId = messageId;
  }
}

function normalizeTurnPrompt(record: Record<string, unknown>, context: KimicodeWireContext): AnyEvent[] {
  const time = readTimestamp(record.time);
  if (time === null) {
    return [];
  }

  const promptText = extractPromptText(record.input);
  const promptId = `${context.agentId}:${time}`;
  return [
    {
      event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:prompt:${time}`),
      session_id: context.sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: context.workspacePath,
      type: "prompt.submitted",
      prompt_id: promptId,
      prompt_chars: promptText.length
    }
  ];
}

function normalizeToolCall(
  record: Record<string, unknown>,
  context: KimicodeWireContext,
  state: KimicodeWireParseState
): AnyEvent[] {
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.name);
  const time = readTimestamp(record.time);
  if (toolCallId === null || toolName === null || time === null) {
    return [];
  }

  state.toolStarts.set(toolCallId, { name: toolName, startedAt: time, args: asRecord(record.args) });
  return [
    {
      event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:tool:${toolCallId}:started`),
      session_id: context.sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: context.workspacePath,
      type: "tool.called",
      tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
      tool_name: toolName,
      status: "started",
      argument_summary: serializeCompactJson(record.args)
    }
  ];
}

function normalizeToolResult(
  record: Record<string, unknown>,
  context: KimicodeWireContext,
  state: KimicodeWireParseState
): AnyEvent[] {
  const toolCallId = readString(record.toolCallId);
  const time = readTimestamp(record.time);
  if (toolCallId === null || time === null) {
    return [];
  }

  const started = state.toolStarts.get(toolCallId);
  const toolName = started?.name ?? readString(record.name) ?? "unknown";
  const durationMs = Math.max(0, time - (started?.startedAt ?? time));
  const result = asRecord(record.result);
  const failed = result?.isError === true;
  if (failed) {
    return [
      {
        event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:tool:${toolCallId}:failed`),
        session_id: context.sessionId,
        timestamp: toIsoTimestamp(time),
        source_vendor: KIMICODE_SOURCE_VENDOR,
        source_adapter: KIMICODE_SOURCE_ADAPTER,
        workspace_path: context.workspacePath,
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
      event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:tool:${toolCallId}:succeeded`),
      session_id: context.sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: context.workspacePath,
      type: "tool.succeeded",
      tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
      tool_name: toolName,
      status: "succeeded",
      duration_ms: durationMs
    }
  ];

  const edit = buildCodeEdit(toolName, started?.args ?? null);
  if (edit !== null) {
    events.push({
      event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:tool:${toolCallId}:edit`),
      session_id: context.sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: context.workspacePath,
      type: "code.edit.applied",
      ...edit
    });
  }

  return events;
}

function buildCodeEdit(
  toolName: string,
  args: Record<string, unknown> | null
): { tool_name: string; files_changed: string[]; file_count: number; insertions: number; deletions: number; edit_operation_count: number } | null {
  if (args === null) {
    return null;
  }

  const path = readString(args.path);
  if (path === null) {
    return null;
  }

  if (toolName === "Edit") {
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

  if (toolName === "Write") {
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

  if (toolName === "MultiEdit" && Array.isArray(args.edits) && args.edits.length > 0) {
    let insertions = 0;
    let deletions = 0;
    for (const entry of args.edits) {
      const editArgs = asRecord(entry);
      if (editArgs === null) {
        continue;
      }
      const diff = diffTextStats(readString(editArgs.old_string) ?? "", readString(editArgs.new_string) ?? "");
      insertions += diff.insertions;
      deletions += diff.deletions;
    }
    return {
      tool_name: toolName,
      files_changed: [path],
      file_count: 1,
      insertions,
      deletions,
      edit_operation_count: args.edits.length
    };
  }

  return null;
}

function normalizeStepEnd(
  record: Record<string, unknown>,
  context: KimicodeWireContext,
  state: KimicodeWireParseState
): AnyEvent[] {
  const time = readTimestamp(record.time);
  const messageId = readString(record.messageId) ?? state.lastMessageId;
  if (time === null || messageId === null) {
    return [];
  }

  const model = state.lastModel ?? readString(record.model);
  return [
    {
      event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:assistant:${messageId}`),
      session_id: context.sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: context.workspacePath,
      type: "assistant.responded",
      message_id: messageId,
      model,
      stop_reason: readString(record.finishReason) ?? readString(record.providerFinishReason),
      response_chars: 0,
      provider_id: state.lastProviderId,
      provider_base_url: null,
      provider_host: null
    }
  ];
}

function normalizeUsageRecord(
  record: Record<string, unknown>,
  context: KimicodeWireContext,
  state: KimicodeWireParseState
): AnyEvent[] {
  if (record.usageScope !== "turn") {
    return [];
  }

  const time = readTimestamp(record.time);
  const usage = asRecord(record.usage);
  if (time === null || usage === null) {
    return [];
  }

  const inputOther = readNonNegativeInt(usage.inputOther) ?? 0;
  const output = readNonNegativeInt(usage.output) ?? 0;
  const cacheRead = readNonNegativeInt(usage.inputCacheRead) ?? 0;
  const cacheCreation = readNonNegativeInt(usage.inputCacheCreation) ?? 0;
  if (inputOther === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
    return [];
  }

  const model = readString(record.model) ?? state.lastModel;
  if (model !== null) {
    state.lastModel = model;
    state.lastProviderId = splitProvider(model);
  }
  const messageId = state.lastMessageId ?? `usage:${context.agentId}:${time}`;
  return [
    {
      event_id: buildEventId(`${context.sessionId}:agent:${context.agentId}:usage:${time}`),
      session_id: context.sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: KIMICODE_SOURCE_VENDOR,
      source_adapter: KIMICODE_SOURCE_ADAPTER,
      workspace_path: context.workspacePath,
      type: "token.usage.recorded",
      message_id: messageId,
      model,
      input_tokens: inputOther,
      output_tokens: output,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      server_tool_use: "{}",
      usage_source: "kimicode-usage",
      provider_id: state.lastProviderId,
      provider_base_url: null,
      provider_host: null
    }
  ];
}

function extractPromptText(value: unknown): string {
  if (!Array.isArray(value)) {
    return typeof value === "string" ? value : "";
  }

  return value
    .map((entry) => {
      const record = asRecord(entry);
      return record !== null ? (readString(record.text) ?? "") : "";
    })
    .join("");
}

function splitProvider(model: string): string {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : model;
}

function buildEventId(suffix: string): string {
  return `kimicode:${suffix}`;
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
