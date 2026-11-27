import { normalizeNativeId, normalizeWorkspacePath, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";
import { diffTextStats } from "@agent-metrics/shared-utils";
import { matchWorkbuddyTiming, type WorkbuddyTimingIndex } from "./workbuddy-timing.js";

const WORKBUDDY_SOURCE_VENDOR: SourceVendor = "workbuddy";
const WORKBUDDY_SOURCE_ADAPTER: SourceAdapter = "workbuddy-jsonl";

/** Record types that never carry session activity worth normalizing. */
const IGNORED_RECORD_TYPES = new Set([
  "session-meta",
  "ai-title",
  "file-history-snapshot",
  "reasoning"
]);

export type WorkbuddyToolStart = {
  name: string;
  startedAt: number;
  args: Record<string, unknown> | null;
};

export type WorkbuddyParseState = {
  timings?: WorkbuddyTimingIndex;
  sessionIdentityMarkers?: ReadonlySet<string>;
  lastModel: string | null;
  toolStarts: Map<string, WorkbuddyToolStart>;
  /**
   * WorkBuddy attaches the aggregated provider usage to the last record of a
   * step (either the closing `function_call` or the closing assistant
   * `message`), and both records can carry the same `messageId`. Dedupe by
   * messageId so a step is never counted twice.
   */
  usageMessageIds: Set<string>;
  /** `stepSeq` of the step currently being parsed, when the record carries one. */
  currentStepSeq: number | null;
  /**
   * Wall-clock start of the current step's generation window: the timestamp of
   * the record that closed the previous step (the tool result that triggered
   * this request). Null when that anchor is unusable.
   */
  stepAnchorAt: number | null;
  lastRecordAt: number | null;
  /** Only a tool result can anchor the following request's step window. */
  lastRecordAnchors: boolean;
};

export function createWorkbuddyParseState(
  timings?: WorkbuddyTimingIndex,
  sessionIdentityMarkers?: ReadonlySet<string>
): WorkbuddyParseState {
  return {
    timings,
    sessionIdentityMarkers,
    lastModel: null,
    toolStarts: new Map(),
    usageMessageIds: new Set(),
    currentStepSeq: null,
    stepAnchorAt: null,
    lastRecordAt: null,
    lastRecordAnchors: false
  };
}

export function normalizeWorkbuddySessionHeader(header: {
  id: string;
  startedAt: number;
  cwd?: string | null;
}): NormalizedEventV2[] {
  const workspacePath = normalizeWorkspacePath(header.cwd ?? ".");
  return toV2Events([
    {
      event_id: buildEventId(`${header.id}:started`),
      session_id: header.id,
      timestamp: toIsoTimestamp(header.startedAt),
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "session.started"
    }
  ]);
}

/**
 * WorkBuddy transcripts carry no provider-side timing fields, so output speed
 * has to be derived from the record timestamps. A step's records are written
 * only once the step settles: its closing record (the usage-bearing
 * `function_call` or assistant `message`) lands at the end of generation, and
 * the record before it is the tool result that triggered the request. The gap
 * between those two is therefore the whole step latency — request upload,
 * queueing, prefill, TTFT and decode — so it is an upper bound on decode time
 * and the derived speed is a lower bound. Gaps over two minutes are idle time,
 * not generation, and are dropped.
 */
const MAX_DERIVED_STEP_MS = 120_000;

export function normalizeWorkbuddyRecord(
  record: unknown,
  sessionId: string,
  workspacePath: string,
  state: WorkbuddyParseState
): NormalizedEventV2[] {
  const parsed = asRecord(record);
  if (parsed === null) {
    return [];
  }

  const type = readString(parsed.type);
  if (type === null || IGNORED_RECORD_TYPES.has(type)) {
    return [];
  }

  const stepSeq = readNonNegativeInt(asRecord(parsed.providerData)?.stepSeq);
  const isPrompt = type === "message" && readString(parsed.role) === "user";
  if (isPrompt) {
    // A new turn: the next step's request starts whenever the user hits send,
    // so the previous record cannot time its generation.
    state.currentStepSeq = null;
    state.stepAnchorAt = null;
  } else if (stepSeq !== null && stepSeq !== state.currentStepSeq) {
    state.currentStepSeq = stepSeq;
    state.stepAnchorAt = state.lastRecordAnchors ? state.lastRecordAt : null;
  }

  const recordWorkspace = normalizeWorkspacePath(readString(parsed.cwd) ?? workspacePath);
  const events: AnyEvent[] = [];

  if (type === "message") {
    const role = readString(parsed.role);
    if (role === "user") {
      events.push(...normalizeUserMessage(parsed, sessionId, recordWorkspace));
    } else if (role === "assistant") {
      events.push(...normalizeAssistantMessage(parsed, sessionId, recordWorkspace, state));
    }
  } else if (type === "function_call") {
    events.push(...normalizeToolCall(parsed, sessionId, recordWorkspace, state));
  } else if (type === "function_call_result") {
    events.push(...normalizeToolResult(parsed, sessionId, recordWorkspace, state));
  }

  events.push(...normalizeUsage(parsed, sessionId, recordWorkspace, state));

  const recordTime = readTimestamp(parsed.timestamp);
  state.lastRecordAt = recordTime;
  state.lastRecordAnchors = type === "function_call_result" && recordTime !== null;

  return toV2Events(events, state.sessionIdentityMarkers);
}

function normalizeUserMessage(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string
): AnyEvent[] {
  const time = readTimestamp(record.timestamp);
  const messageId = readString(record.id);
  if (time === null || messageId === null) {
    return [];
  }

  return [
    {
      event_id: buildEventId(`${sessionId}:prompt:${messageId}`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "prompt.submitted",
      prompt_id: messageId,
      prompt_chars: extractTextLength(record.content)
    }
  ];
}

function normalizeToolCall(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: WorkbuddyParseState
): AnyEvent[] {
  const time = readTimestamp(record.timestamp);
  const toolCallId = readString(record.callId);
  const toolName = readString(record.name);
  if (time === null || toolCallId === null || toolName === null) {
    return [];
  }

  const args = parseToolArguments(record.arguments);
  state.toolStarts.set(toolCallId, { name: toolName, startedAt: time, args });

  return [
    {
      event_id: buildEventId(`${sessionId}:tool:${toolCallId}:started`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "tool.called",
      tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
      tool_name: toolName,
      status: "started",
      argument_summary:
        typeof record.arguments === "string" ? record.arguments : serializeCompactJson(record.arguments)
    }
  ];
}

function normalizeToolResult(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: WorkbuddyParseState
): AnyEvent[] {
  const time = readTimestamp(record.timestamp);
  const toolCallId = readString(record.callId);
  if (time === null || toolCallId === null) {
    return [];
  }

  const started = state.toolStarts.get(toolCallId);
  const toolName = readString(record.name) ?? started?.name ?? "unknown";
  const durationMs = Math.max(0, time - (started?.startedAt ?? time));
  const status = readString(record.status);
  const failed = status !== null && status !== "completed";

  if (failed) {
    return [
      {
        event_id: buildEventId(`${sessionId}:tool:${toolCallId}:failed`),
        session_id: sessionId,
        timestamp: toIsoTimestamp(time),
        source_vendor: WORKBUDDY_SOURCE_VENDOR,
        source_adapter: WORKBUDDY_SOURCE_ADAPTER,
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
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "tool.succeeded",
      tool_call_id: normalizeNativeId(toolCallId) ?? `native:${toolCallId}`,
      tool_name: toolName,
      status: "succeeded",
      duration_ms: durationMs
    }
  ];

  const edit = buildWorkbuddyCodeEdit(toolName, started?.args ?? null);
  if (edit !== null) {
    events.push({
      event_id: buildEventId(`${sessionId}:tool:${toolCallId}:edit`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "code.edit.applied",
      ...edit
    });
  }

  return events;
}

function normalizeAssistantMessage(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: WorkbuddyParseState
): AnyEvent[] {
  const time = readTimestamp(record.timestamp);
  const messageId = readString(record.id);
  if (time === null || messageId === null) {
    return [];
  }

  const providerData = asRecord(record.providerData);
  const rawCredit = asRecord(providerData?.rawUsage)?.credit;
  const credit = typeof rawCredit === "number" && Number.isFinite(rawCredit) && rawCredit >= 0
    ? rawCredit
    : undefined;
  const model = readString(providerData?.model) ?? state.lastModel;
  if (model !== null) {
    state.lastModel = model;
  }

  return [
    {
      event_id: buildEventId(`${sessionId}:assistant:${messageId}`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "assistant.responded",
      message_id: messageId,
      model,
      stop_reason: null,
      response_chars: extractTextLength(record.content),
      provider_id: "unknown",
      provider_base_url: null,
      provider_host: null
    }
  ];
}

function normalizeUsage(
  record: Record<string, unknown>,
  sessionId: string,
  workspacePath: string,
  state: WorkbuddyParseState
): AnyEvent[] {
  const providerData = asRecord(record.providerData);
  const usage = asRecord(providerData?.usage);
  if (usage === null) {
    return [];
  }

  const messageId = readString(providerData?.messageId) ?? readString(record.id);
  if (messageId === null || state.usageMessageIds.has(messageId)) {
    return [];
  }

  const time = readTimestamp(record.timestamp);
  if (time === null) {
    return [];
  }
  const inputTokens = readNonNegativeInt(usage.inputTokens) ?? 0;
  const outputTokens = readNonNegativeInt(usage.outputTokens) ?? 0;
  const cacheReadTokens = readCacheReadTokens(usage, providerData?.rawUsage, record.message);
  const cacheWriteTokens = readCacheWriteTokens(providerData?.rawUsage);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return [];
  }

  const rawCredit = asRecord(providerData?.rawUsage)?.credit;
  const credit = typeof rawCredit === "number" && Number.isFinite(rawCredit) && rawCredit >= 0
    ? rawCredit
    : undefined;
  const model = readString(providerData?.model) ?? state.lastModel;
  if (model !== null) {
    state.lastModel = model;
  }
  state.usageMessageIds.add(messageId);
  const timing = matchWorkbuddyTiming(state.timings, sessionId, providerData!, usage);

  // Only a step we can anchor gets a derived duration; anything else stays
  // unknown rather than borrowing another step's window.
  const stepSeq = readNonNegativeInt(providerData?.stepSeq);
  const windowMs =
    stepSeq !== null && stepSeq === state.currentStepSeq && state.stepAnchorAt !== null
      ? time - state.stepAnchorAt
      : null;
  const decodeDurationMs = windowMs !== null && windowMs > 0 && windowMs <= MAX_DERIVED_STEP_MS ? windowMs : null;

  return [
    {
      event_id: buildEventId(`${sessionId}:usage:${messageId}`),
      session_id: sessionId,
      timestamp: toIsoTimestamp(time),
      source_vendor: WORKBUDDY_SOURCE_VENDOR,
      source_adapter: WORKBUDDY_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "token.usage.recorded",
      message_id: messageId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheWriteTokens,
      cache_read_input_tokens: cacheReadTokens,
      credit,
      server_tool_use: "{}",
      usage_source: "workbuddy-usage",
      provider_id: "unknown",
      provider_base_url: null,
      provider_host: null,
      first_token_latency_ms: timing?.firstTokenLatencyMs ?? null,
      decode_duration_ms: timing?.decodeDurationMs ?? decodeDurationMs
    }
  ];
}

/**
 * WorkBuddy reports `usage.inputTokens` as the full prompt size (cache hits
 * included), so the cache read count is both mirrored into
 * `cache_read_input_tokens` and subtracted by the canonical
 * `displayedInputTokens` math for `gross` sources.
 */
function readCacheReadTokens(
  usage: Record<string, unknown>,
  rawUsage: unknown,
  legacyMessage: unknown
): number {
  const inputDetails = Array.isArray(usage.inputTokensDetails) ? usage.inputTokensDetails : [];
  for (const detail of inputDetails) {
    const cached = readNonNegativeInt(asRecord(detail)?.cached_tokens);
    if (cached !== null) {
      return cached;
    }
  }

  const raw = asRecord(rawUsage);
  const fromRaw =
    readNonNegativeInt(raw?.prompt_cache_hit_tokens) ??
    readNonNegativeInt(asRecord(raw?.prompt_tokens_details)?.cached_tokens);
  if (fromRaw !== null) {
    return fromRaw;
  }

  return readNonNegativeInt(asRecord(asRecord(legacyMessage)?.usage)?.cache_read_input_tokens) ?? 0;
}

function readCacheWriteTokens(rawUsage: unknown): number {
  const raw = asRecord(rawUsage);
  return (
    readNonNegativeInt(raw?.prompt_cache_write_tokens) ??
    readNonNegativeInt(raw?.cache_creation_input_tokens) ??
    0
  );
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

function buildWorkbuddyCodeEdit(
  toolName: string,
  args: Record<string, unknown> | null
): {
  tool_name: string;
  files_changed: string[];
  file_count: number;
  insertions: number;
  deletions: number;
  edit_operation_count: number;
} | null {
  if (args === null) {
    return null;
  }

  const normalizedTool = toolName.toLowerCase();
  const path = readString(args.file_path) ?? readString(args.path) ?? readString(args.filePath);
  if (path === null) {
    return null;
  }

  if (normalizedTool === "edit" || normalizedTool === "multiedit" || normalizedTool === "str_replace") {
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

  if (normalizedTool === "write" || normalizedTool === "create_file") {
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

function extractTextLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (!Array.isArray(value)) {
    return 0;
  }

  return value.reduce((total, entry) => {
    const record = asRecord(entry);
    if (record === null) {
      return total;
    }
    if (record.type !== "text" && record.type !== "input_text" && record.type !== "output_text") {
      return total;
    }
    return total + (readString(record.text)?.length ?? 0);
  }, 0);
}

function buildEventId(suffix: string): string {
  return `workbuddy:${suffix}`;
}

function toV2Events(events: AnyEvent[], sessionIdentityMarkers?: ReadonlySet<string>): NormalizedEventV2[] {
  return events.map((event) => toNormalizedEventV2(event, {
    sourceRecordId: sessionIdentityMarkers?.has(workbuddySessionIdentityMarker(event.event_id))
      ? event.event_id
      : ledgerIdentity(event)
  }));
}

/** The key encodes a legacy session-scoped record ID without looking like a usage key. */
export function workbuddySessionIdentityMarker(sourceRecordId: string): string {
  return `workbuddy:session-identity-v1:${encodeURIComponent(sourceRecordId)}`;
}

/** Default to upstream's session-less source identity for new records. */
function ledgerIdentity(event: AnyEvent): string {
  if (event.type === "session.started") return event.event_id;
  const prefix = "workbuddy:";
  if (!event.event_id.startsWith(prefix)) return event.event_id;
  const rest = event.event_id.slice(prefix.length);
  const separator = rest.indexOf(":");
  return separator === -1 ? event.event_id : `${prefix}${rest.slice(separator + 1)}`;
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
