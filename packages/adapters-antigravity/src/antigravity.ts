import { normalizeWorkspacePath, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, SourceAdapter, SourceVendor, UsageSource } from "@agent-metrics/event-schema";
import { matchAntigravityTiming, type AntigravityTimingIndex } from "./antigravity-timing.js";

const ANTIGRAVITY_SOURCE_VENDOR: SourceVendor = "antigravity";
const ANTIGRAVITY_SOURCE_ADAPTER: SourceAdapter = "antigravity-acp";
const ANTIGRAVITY_USAGE_SOURCE: UsageSource = "antigravity-acp";

export type AntigravityEventContext = {
  /** Brain directory UUID; the only session identity the ACP transcript carries. */
  sessionId: string;
  /** Already-normalized workspace path; the transcript has none, so this is the normalized default. */
  workspacePath?: string;
  /** Optional per-step timing telemetry loaded from sibling `conversations/<session>.db`. */
  timings?: AntigravityTimingIndex;
};

/**
 * Normalize one `transcript_full.jsonl` record from an Antigravity ACP brain
 * session. Only `USER_INPUT` and `PLANNER_RESPONSE` rows map to metrics; other
 * row types (`GENERIC`, `SYSTEM_MESSAGE`, `CHECKPOINT`, ...) are ignored, and
 * prompt/assistant bodies are never inspected beyond their character counts.
 */
export function normalizeAntigravityTranscriptRecord(
  record: unknown,
  context: AntigravityEventContext
): NormalizedEventV2[] {
  const parsed = asRecord(record);
  if (parsed === null) {
    return [];
  }

  if (parsed.type === "USER_INPUT") {
    return toV2Events(normalizeUserInput(parsed, context));
  }

  if (parsed.type === "PLANNER_RESPONSE") {
    return toV2Events(normalizePlannerResponse(parsed, context));
  }

  return [];
}

export function normalizeAntigravitySessionStarted(input: {
  sessionId: string;
  timestamp: string;
  workspacePath?: string;
}): NormalizedEventV2 {
  const event: AnyEvent = {
    event_id: `antigravity:${input.sessionId}:session:started`,
    session_id: input.sessionId,
    timestamp: input.timestamp,
    source_vendor: ANTIGRAVITY_SOURCE_VENDOR,
    source_adapter: ANTIGRAVITY_SOURCE_ADAPTER,
    workspace_path: input.workspacePath ?? normalizeWorkspacePath(undefined),
    type: "session.started"
  };
  return toNormalizedEventV2(event, { sourceRecordId: event.event_id });
}

function normalizeUserInput(record: Record<string, unknown>, context: AntigravityEventContext): AnyEvent[] {
  const stepIndex = readNonNegativeInt(record.step_index);
  const timestamp = readTimestamp(record.created_at);
  if (stepIndex === null || timestamp === null) {
    return [];
  }

  return [
    {
      event_id: `antigravity:${context.sessionId}:step:${stepIndex}:user:prompt`,
      session_id: context.sessionId,
      timestamp,
      source_vendor: ANTIGRAVITY_SOURCE_VENDOR,
      source_adapter: ANTIGRAVITY_SOURCE_ADAPTER,
      workspace_path: context.workspacePath ?? normalizeWorkspacePath(undefined),
      type: "prompt.submitted",
      prompt_id: `antigravity:${context.sessionId}:step:${stepIndex}:user`,
      prompt_chars: readChars(record.content)
    }
  ];
}

function normalizePlannerResponse(record: Record<string, unknown>, context: AntigravityEventContext): AnyEvent[] {
  const model = readString(record.model);
  const stepIndex = readNonNegativeInt(record.step_index);
  const timestamp = readTimestamp(record.created_at);
  if (model === null || stepIndex === null || timestamp === null) {
    return [];
  }

  const messageId = `antigravity:${context.sessionId}:step:${stepIndex}:${model}`;
  const providerId = providerIdFromModel(model);
  const base = {
    session_id: context.sessionId,
    timestamp,
    source_vendor: ANTIGRAVITY_SOURCE_VENDOR,
    source_adapter: ANTIGRAVITY_SOURCE_ADAPTER,
    workspace_path: context.workspacePath ?? normalizeWorkspacePath(undefined)
  };

  const events: AnyEvent[] = [
    {
      event_id: `antigravity:${context.sessionId}:step:${stepIndex}:${model}:assistant`,
      ...base,
      type: "assistant.responded",
      message_id: messageId,
      model,
      stop_reason: null,
      response_chars: readChars(record.content),
      provider_id: providerId,
      provider_base_url: null,
      provider_host: null
    }
  ];

  const inputTokens = readNonNegativeInt(record.input_tokens) ?? 0;
  const outputTokens = readNonNegativeInt(record.output_tokens) ?? 0;
  const cacheReadTokens = readNonNegativeInt(record.cache_read_tokens) ?? 0;
  if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
    const timing = matchAntigravityTiming(context.timings, {
      stepIndex,
      inputTokens,
      outputTokens,
      cacheReadTokens
    });
    events.push({
      event_id: `antigravity:${context.sessionId}:step:${stepIndex}:${model}:usage`,
      ...base,
      type: "token.usage.recorded",
      message_id: messageId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      server_tool_use: "{}",
      usage_source: ANTIGRAVITY_USAGE_SOURCE,
      first_token_latency_ms: timing?.firstTokenLatencyMs ?? null,
      decode_duration_ms: timing?.decodeDurationMs ?? null,
      provider_id: providerId,
      provider_base_url: null,
      provider_host: null
    });
  }

  return events;
}

/**
 * Antigravity routes requests through provider-agnostic worker names, so the
 * provider is inferred from the model family prefix. Unknown families stay
 * "unknown" rather than guessing a vendor.
 */
function providerIdFromModel(model: string): string {
  const lowered = model.toLowerCase();
  if (lowered.includes("gemini")) {
    return "google";
  }
  if (lowered.includes("claude")) {
    return "anthropic";
  }
  if (lowered.includes("gpt")) {
    return "openai";
  }
  return "unknown";
}

function toV2Events(events: AnyEvent[]): NormalizedEventV2[] {
  return events.map((event) => toNormalizedEventV2(event, { sourceRecordId: event.event_id }));
}

function readChars(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
