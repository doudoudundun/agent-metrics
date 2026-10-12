import {
  AnyEventSchema,
  NormalizedEventV2Schema,
  type AnyEvent,
  type NormalizedEventV2
} from "./events.js";
import {
  createEventId,
  deriveToolCallId,
  normalizeEventTimestamp,
  normalizeWorkspacePath
} from "./identity.js";
import { USAGE_SOURCE_SEMANTICS } from "./usage.js";
import type { SourceAdapter, SourceVendor, UsageSource } from "./sources.js";

export type EventNormalizationOptions = {
  sourceInstanceId?: string;
  adapterInstanceId?: string;
  sourceRecordNamespace?: string;
  sourceRecordId?: string | null;
  sourceSequence?: string | number | null;
  sourceLocation?: unknown;
  toolCallId?: string;
};

export type EventNormalizationSuccess = {
  ok: true;
  event: NormalizedEventV2;
};

export type EventNormalizationFailure = {
  ok: false;
  diagnosticCode: "INVALID_EVENT" | "INVALID_USAGE" | "PENDING_USAGE_MAPPING";
  message: string;
};

export type EventNormalizationResult = EventNormalizationSuccess | EventNormalizationFailure;

/**
 * Convert a legacy/unversioned event (or pass through a strict V2 event) into
 * the V2 domain form, throwing when the input cannot be normalized. Intended
 * for write-path callers that must emit V2 events and cannot silently drop
 * invalid input.
 */
export function toNormalizedEventV2(
  value: unknown,
  options?: EventNormalizationOptions
): NormalizedEventV2 {
  const result = normalizeEventV2(value, options);
  if (!result.ok) {
    throw new Error(`${result.diagnosticCode}: ${result.message}`);
  }
  return result.event;
}

/**
 * Parse a strict V2 event or convert one legacy/unversioned event into the V2
 * domain form used by migrations and the canonical projector.
 */
export function normalizeEventV2(
  value: unknown,
  options: EventNormalizationOptions = {}
): EventNormalizationResult {
  if (isRecord(value) && value.schema_version === 2) {
    const parsed = NormalizedEventV2Schema.safeParse(value);
    return parsed.success
      ? { ok: true, event: parsed.data }
      : failureForEvent(parsed.error.issues[0]?.message ?? "Invalid V2 event", value);
  }

  const parsed = AnyEventSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnosticCode: "INVALID_EVENT",
      message: parsed.error.issues[0]?.message ?? "Invalid legacy event"
    };
  }

  return normalizeLegacyEvent(parsed.data, options);
}

function normalizeLegacyEvent(event: AnyEvent, options: EventNormalizationOptions): EventNormalizationResult {
  const sourceAdapter = resolveSourceAdapter(event, options);
  const sourceInstanceId = options.sourceInstanceId ?? defaultSourceInstanceId(event.source_vendor, sourceAdapter);
  const adapterInstanceId = options.adapterInstanceId ?? `${sourceAdapter}@${sourceInstanceId}`;
  const sourceRecordNamespace = options.sourceRecordNamespace ?? defaultRecordNamespace(sourceAdapter, event.type);
  const sourceRecordId = options.sourceRecordId ?? event.event_id;
  const timestamp = normalizeEventTimestamp(event.timestamp);
  const base = {
    schema_version: 2 as const,
    event_id: createEventId({
      sourceInstanceId,
      sourceRecordNamespace,
      eventKind: event.type,
      sessionId: event.session_id,
      sourceRecordId,
      timestamp,
      sourceSequence: options.sourceSequence,
      location: options.sourceLocation
    }),
    session_id: event.session_id,
    timestamp,
    source_vendor: event.source_vendor,
    source_adapter: sourceAdapter,
    source_instance_id: sourceInstanceId,
    adapter_instance_id: adapterInstanceId,
    source_record_namespace: sourceRecordNamespace,
    source_record_id: sourceRecordId,
    workspace_path: normalizeWorkspacePath(event.workspace_path)
  };

  const candidate = toV2Candidate(event, base, options);
  const parsed = NormalizedEventV2Schema.safeParse(candidate);
  if (parsed.success) {
    return { ok: true, event: parsed.data };
  }

  return failureForEvent(parsed.error.issues[0]?.message ?? "Invalid normalized event", event);
}

function toV2Candidate(
  event: AnyEvent,
  base: Omit<NormalizedEventV2, "type"> & { schema_version: 2 },
  options: EventNormalizationOptions
): Record<string, unknown> {
  if (event.type === "session.started") {
    return { ...base, type: event.type };
  }

  if (event.type === "session.ended") {
    return {
      ...base,
      type: event.type,
      exit_code: event.exit_code ?? null,
      duration_ms: event.duration_ms
    };
  }

  if (event.type === "tool.called" || event.type === "tool.succeeded" || event.type === "tool.failed") {
    const toolCallId =
      options.toolCallId ??
      event.tool_call_id ??
      deriveToolCallId({
        sourceInstanceId: base.source_instance_id,
        sessionId: event.session_id,
        timestamp: base.timestamp,
        sourceSequence: options.sourceSequence,
        toolName: event.tool_name,
        sourceLocation: options.sourceLocation ?? { sourceRecordId: event.event_id }
      });

    if (event.type === "tool.called") {
      return {
        ...base,
        type: event.type,
        tool_call_id: toolCallId,
        tool_name: event.tool_name,
        status: event.status,
        argument_summary: event.argument_summary
      };
    }

    return {
      ...base,
      type: event.type,
      tool_call_id: toolCallId,
      tool_name: event.tool_name,
      status: event.status,
      duration_ms: event.duration_ms
    };
  }

  if (event.type === "code.edit.applied") {
    return { ...event, ...base, schema_version: 2, type: event.type };
  }

  if (event.type === "prompt.submitted") {
    return { ...event, ...base, schema_version: 2, type: event.type };
  }

  if (event.type === "assistant.responded") {
    return {
      ...base,
      type: event.type,
      message_id: event.message_id,
      model: event.model ?? null,
      stop_reason: event.stop_reason ?? null,
      response_chars: event.response_chars,
      provider_id: event.provider_id ?? "unknown",
      provider_base_url: event.provider_base_url ?? null,
      provider_host: event.provider_host ?? null
    };
  }

  if (event.type === "token.usage.recorded") {
    const semantics = USAGE_SOURCE_SEMANTICS[event.usage_source as UsageSource];
    if (!semantics) {
      return {
        ...base,
        type: event.type,
        usage_source: event.usage_source
      };
    }

    return {
      ...base,
      type: event.type,
      message_id: event.message_id,
      model: event.model ?? null,
      input_tokens: event.input_tokens,
      input_token_semantics: semantics.inputTokenSemantics,
      usage_measurement: semantics.usageMeasurement,
      output_tokens: event.output_tokens,
      cache_creation_input_tokens: event.cache_creation_input_tokens,
      cache_read_input_tokens: event.cache_read_input_tokens,
      server_tool_use: event.server_tool_use,
      usage_source: event.usage_source,
      first_token_latency_ms: event.first_token_latency_ms ?? null,
      decode_duration_ms: event.decode_duration_ms ?? null,
      provider_id: event.provider_id ?? "unknown",
      provider_base_url: event.provider_base_url ?? null,
      provider_host: event.provider_host ?? null
    };
  }

  if (event.type === "snapshot.created") {
    return { ...event, ...base, schema_version: 2, type: event.type };
  }

  return { ...event, ...base, schema_version: 2, type: event.type };
}

function resolveSourceAdapter(event: AnyEvent, options: EventNormalizationOptions): SourceAdapter {
  if (options.adapterInstanceId?.startsWith("claude-transcript@")) {
    return "claude-transcript";
  }

  if (event.source_adapter !== "claude") {
    return event.source_adapter;
  }

  return event.type === "prompt.submitted" || event.type === "assistant.responded" || event.type === "token.usage.recorded"
    ? "claude-transcript"
    : "claude-hook";
}

function defaultSourceInstanceId(sourceVendor: SourceVendor, sourceAdapter: SourceAdapter): string {
  if (sourceAdapter === "zcode-db") {
    return "zcode:default";
  }
  if (sourceAdapter === "kimicode-wire") {
    return "kimicode:default";
  }
  if (sourceAdapter === "dsh-jsonl") {
    return "dsh:default";
  }

  return `${sourceVendor === "claude-code" ? "claude" : sourceVendor}:default`;
}

function defaultRecordNamespace(sourceAdapter: SourceAdapter, eventType: AnyEvent["type"]): string {
  if (sourceAdapter === "claude-hook") return "hook";
  if (sourceAdapter === "claude-transcript") return "transcript";
  if (
    sourceAdapter === "opencode-db" ||
    sourceAdapter === "zcode-db" ||
    sourceAdapter === "mimo-db"
  ) {
    return eventType === "tool.called" || eventType === "tool.succeeded" || eventType === "tool.failed"
      ? "part"
      : "message";
  }
  if (sourceAdapter === "kimicode-wire") return "wire";
  if (sourceAdapter === "dsh-jsonl") return "session";
  if (sourceAdapter === "codex-rollout") return "rollout";
  if (sourceAdapter === "codex-logs") return "logs";
  if (sourceAdapter === "cursor-ide") return "cursor";
  return sourceAdapter;
}

function failureForEvent(message: string, value: unknown): EventNormalizationFailure {
  return {
    ok: false,
    diagnosticCode: isRecord(value) && value.type === "token.usage.recorded" ? "INVALID_USAGE" : "INVALID_EVENT",
    message
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
