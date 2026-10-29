import { basename } from "node:path";
import { normalizeNativeId, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, ServiceTier, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

const CODEX_SOURCE_VENDOR: SourceVendor = "codex";
const CODEX_ROLLOUT_ADAPTER: SourceAdapter = "codex-rollout";
// Consecutive token_count gaps beyond this still include unobserved tool runs
// or idle time even within a turn; treat them as unknown rather than decode.
const MAX_DECODE_GAP_MS = 120_000;
// The first token_count of a turn is written on the periodic reporting tick that
// follows the first generated token, so the measured latency is an upper bound
// quantized by that interval. A first report later than this means the turn sat
// idle or was abandoned, which must not be reported as a slow first token.
const MAX_FIRST_TOKEN_LATENCY_MS = 600_000;

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
  sourceInstanceId?: string;
}): NormalizedEventV2[] {
  const lines = input.contents.split(/\r?\n/u).filter((line) => line.length > 0);
  const events: AnyEvent[] = [];
  const pendingToolCalls = new Map<string, PendingCodexToolCall>();
  // Rollouts also mirror each response's usage into a `token_usage_record`
  // line. The `event_msg/token_count` stream stays authoritative because the
  // timing heuristics below are anchored on it, but a rollout that only writes
  // the mirror (or a future Codex that drops token_count) would otherwise
  // contribute zero usage. Mirror rows are buffered and only consumed when the
  // file produced no token_count usage at all, so the two never double count.
  const mirroredUsageEvents: AnyEvent[] = [];
  let tokenCountUsageCount = 0;
  let lastTokenEventMs: number | null = null;
  // Turn start anchor (task_started) and whether this turn already spent its
  // first-token observation on a token_count report.
  let turnStartedMs: number | null = null;
  let turnFirstTokenReported = false;
  // Codex persists the session's speed tier in `thread_settings_applied` (written
  // on /fast, model switches and profile changes). Usage reported after such an
  // event is billed at that tier until the next settings record, so the tier is
  // carried forward in file order rather than read from config.
  let currentServiceTier: ServiceTier | null = null;
  // Codex writes the model actually serving the turn into `turn_context`. It is
  // the authoritative source: the session's model can change mid-session, and
  // the tracing log this adapter used to rely on
  // (`resolveCodexLogsDbPath` → `conversation.id=... model=...`) is not written
  // for every invocation, which left usage rows with a NULL model.
  let currentModel: string | null = null;
  let sourceInstanceId =
    input.sourceInstanceId ??
    (isMulticaRolloutPath(input.filePath) ? "codex:multica" : undefined);
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

      const originator = normalizeOptionalString(payload.originator);
      if (originator === "multica-agent-sdk") {
        sourceInstanceId = "codex:multica";
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

    if (eventType === "turn_context" && payload !== null) {
      const model = normalizeOptionalString(payload.model);
      if (model !== null) {
        currentModel = model;
      }
      continue;
    }

    if (eventType === "token_usage_record" && payload !== null) {
      const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
      if (sessionId !== null) {
        const mirrored = buildMirroredUsageEvent({
          parsed,
          payload,
          sessionId,
          workspacePath: sessionMeta?.workspacePath ?? ".",
          model: currentModel ?? input.sessionModels?.[sessionId] ?? null,
          serviceTier: currentServiceTier,
          providerId: sessionMeta?.providerId ?? null,
          providerConfig:
            sessionMeta?.providerId != null ? input.providerConfigs?.[sessionMeta.providerId] : undefined
        });
        if (mirrored !== null) {
          mirroredUsageEvents.push(mirrored);
        }
      }
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
          tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
          tool_name: toolName,
          status: "started",
          argument_summary: argumentSummary
        });
        continue;
      }

      if (sessionId !== null && payloadType === "function_call") {
        const callId = normalizeOptionalString(payload.call_id);
        if (callId === null) {
          continue;
        }

        const functionName = normalizeOptionalString(payload.name) ?? "unknown";
        if (!shouldTrackFunctionCall(functionName)) {
          continue;
        }
        const argumentText = normalizeOptionalString(payload.arguments);

        pendingToolCalls.set(callId, {
          sessionId,
          workspacePath: sessionMeta?.workspacePath ?? ".",
          timestamp,
          toolName: inferFunctionCallToolName(functionName, argumentText),
          argumentSummary: summarizeFunctionCallArguments(functionName, argumentText)
        });
        const pending = pendingToolCalls.get(callId);
        if (pending) {
          events.push({
            event_id: `codex:session:${sessionId}:function:${callId}:started`,
            session_id: sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: sessionMeta?.workspacePath ?? ".",
            type: "tool.called",
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
            tool_name: pending.toolName,
            status: "started",
            argument_summary: pending.argumentSummary
          });
        }
        continue;
      }

      if (payloadType === "custom_tool_call_output") {
        const callId = normalizeOptionalString(payload.call_id);
        const pending = callId ? pendingToolCalls.get(callId) : null;

        if (callId === null || pending == null) {
          continue;
        }

        // Codex often stores custom_tool_call_output.output as an array of
        // {type,text} parts rather than a plain string. Coerce before parsing.
        const result = parseCustomToolOutput(coerceToolOutputText(payload.output));

        if (result.success) {
          events.push({
            event_id: `codex:session:${pending.sessionId}:tool:${callId}:succeeded`,
            session_id: pending.sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: pending.workspacePath,
            type: "tool.succeeded",
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
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
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
            tool_name: pending.toolName,
            status: "failed",
            duration_ms: result.durationMs
          });
        }
        pendingToolCalls.delete(callId);
        continue;
      }

      if (payloadType === "function_call_output") {
        const callId = normalizeOptionalString(payload.call_id);
        const pending = callId ? pendingToolCalls.get(callId) : null;

        if (callId === null || pending == null) {
          continue;
        }

        const result = parseFunctionCallOutput(coerceToolOutputText(payload.output));

        if (result.success) {
          events.push({
            event_id: `codex:session:${pending.sessionId}:function:${callId}:succeeded`,
            session_id: pending.sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: pending.workspacePath,
            type: "tool.succeeded",
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
            tool_name: pending.toolName,
            status: "succeeded",
            duration_ms: result.durationMs
          });
        } else {
          events.push({
            event_id: `codex:session:${pending.sessionId}:function:${callId}:failed`,
            session_id: pending.sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: pending.workspacePath,
            type: "tool.failed",
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
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

      if (payloadType === "thread_settings_applied") {
        const settings = asRecord(payload.thread_settings);
        currentServiceTier = normalizeCodexServiceTier(
          settings?.service_tier ?? payload.service_tier
        );
        continue;
      }

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
          model: currentModel ?? input.sessionModels?.[sessionId] ?? null,
          stop_reason: normalizeOptionalString(payload.phase) ?? null,
          response_chars: responseText.length,
          provider_id: providerId,
          provider_base_url: providerConfig?.baseUrl ?? null,
          provider_host: providerConfig?.host ?? null
        });
        continue;
      }

      if (sessionId !== null && payloadType === "web_search_end") {
        const callId = buildEventKey(
          parsed,
          payloadType,
          lineIndex,
          normalizeOptionalString(payload.call_id)
        );
        events.push({
          event_id: `codex:session:${sessionId}:web_search:${callId}:tool`,
          session_id: sessionId,
          timestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: sessionMeta?.workspacePath ?? ".",
          type: "tool.succeeded",
          tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
          tool_name: "WebSearch",
          status: "succeeded",
          duration_ms: 0
        });
        continue;
      }

      if (sessionId !== null && payloadType === "exec_command_end") {
        const callId = buildEventKey(
          parsed,
          payloadType,
          lineIndex,
          normalizeOptionalString(payload.call_id)
        );
        const exitCode = normalizeInteger(payload.exit_code);
        const baseEvent = {
          event_id: `codex:session:${sessionId}:exec:${callId}:tool`,
          session_id: sessionId,
          timestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: sessionMeta?.workspacePath ?? ".",
          tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
          tool_name: inferExecCommandToolName(payload.command),
          duration_ms: getExecCommandDurationMs(payload)
        };

        if (exitCode === 0) {
          events.push({
            ...baseEvent,
            type: "tool.succeeded",
            status: "succeeded"
          });
        } else {
          events.push({
            ...baseEvent,
            type: "tool.failed",
            status: "failed"
          });
        }
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
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
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
            tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
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

      if (sessionId !== null && payloadType === "item_completed") {
        const item = asRecord(payload.item);
        if (item === null || normalizeOptionalString(item.type) !== "FileChange") {
          continue;
        }

        if (normalizeOptionalString(item.status) !== "completed") {
          continue;
        }

        const changes = asRecord(item.changes) ?? {};
        const filesChanged = Object.keys(changes);
        if (filesChanged.length > 0) {
          const changeId = normalizeOptionalString(item.id) ?? eventKey;
          const totals = summarizePatchChanges(changes);
          events.push({
            event_id: `codex:session:${sessionId}:filechange:${changeId}:edit`,
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
      eventType === "event_msg" &&
      payload !== null &&
      normalizeOptionalString(payload.type) === "task_started"
    ) {
      // Turn boundary: the wait between turns (user thinking, overnight gaps)
      // must never be attributed to decoding, so drop the previous anchor.
      lastTokenEventMs = null;
      // task_started carries the turn start in unix seconds; older rollouts omit
      // it, so fall back to the row timestamp.
      turnStartedMs = resolveTurnStartedMs(payload, parsed.timestamp);
      turnFirstTokenReported = false;
      continue;
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
    // Codex reports cached input as a subset of input_tokens. Preserve the
    // source-reported gross counter so the shared accounting policy can derive
    // displayed input by subtracting cache-read input exactly once.
    // Reasoning (chain-of-thought) tokens are model-generated output and must be
    // counted alongside output_tokens, matching the opencode adapter and the
    // accounting that Anthropic/OpenAI bill against. Excluding them understates
    // real model output.
    const outputTokens =
      (normalizeInteger(lastUsage?.output_tokens) ?? 0) +
      (normalizeInteger(lastUsage?.reasoning_output_tokens) ?? 0);

    if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
      continue;
    }

    const providerId = sessionMeta?.providerId ?? null;
    const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;

    const usageTimestamp =
      normalizeOptionalString(parsed.timestamp) ??
      sessionMeta?.timestamp ??
      new Date(0).toISOString();
    // Codex rollouts carry no per-request timing, so approximate the decode
    // window with the gap between consecutive token_count events. Gaps past
    // MAX_DECODE_GAP_MS are dominated by tool execution or idle time and are
    // dropped instead of polluting the speed average.
    const usageMs = Date.parse(usageTimestamp);
    const decodeDurationMs =
      lastTokenEventMs !== null &&
      Number.isFinite(usageMs) &&
      usageMs >= lastTokenEventMs &&
      usageMs - lastTokenEventMs <= MAX_DECODE_GAP_MS
        ? usageMs - lastTokenEventMs
        : null;
    if (Number.isFinite(usageMs)) {
      lastTokenEventMs = usageMs;
    }

    // Only the turn's first token_count report can be a first-token observation:
    // later reports are periodic snapshots of an already decoding response.
    const firstTokenLatencyMs =
      !turnFirstTokenReported &&
      turnStartedMs !== null &&
      Number.isFinite(usageMs) &&
      usageMs >= turnStartedMs &&
      usageMs - turnStartedMs <= MAX_FIRST_TOKEN_LATENCY_MS
        ? usageMs - turnStartedMs
        : null;
    turnFirstTokenReported = true;

    events.push({
      event_id: `codex:session:${sessionId}:usage:${totalTokens}`,
      session_id: sessionId,
      timestamp: usageTimestamp,
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "token.usage.recorded",
      message_id: `usage_${totalTokens}`,
      model: currentModel ?? input.sessionModels?.[sessionId] ?? null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      server_tool_use: "{}",
      usage_source: "codex-rollout",
      ...(currentServiceTier ? { service_tier: currentServiceTier } : {}),
      provider_id: providerId,
      provider_base_url: providerConfig?.baseUrl ?? null,
      provider_host: providerConfig?.host ?? null,
      first_token_latency_ms: firstTokenLatencyMs,
      decode_duration_ms: decodeDurationMs
    });
    tokenCountUsageCount += 1;
  }

  // Only fall back to the mirrored `token_usage_record` rows when this rollout
  // produced no usage through the token_count stream at all.
  if (tokenCountUsageCount === 0 && mirroredUsageEvents.length > 0) {
    events.push(...mirroredUsageEvents);
  }

  // Sort on the legacy AnyEvent shape (readable, stable event_id) before
  // wrapping to V2 so ordering among same-timestamp events is unaffected by
  // the hash-based V2 event_id.
  return events
    .sort(compareCodexEvents)
    .map((event) =>
      toNormalizedEventV2(event, {
        sourceRecordId: event.event_id,
        ...(sourceInstanceId ? { sourceInstanceId } : {})
      })
    );
}

export function inferSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const match = /^rollout-.*-([0-9a-f]{8,}-[0-9a-f-]+)\.jsonl$/iu.exec(name);
  return match?.[1] ?? null;
}

/**
 * Build a usage event from a `token_usage_record` line.
 *
 * Codex writes this mirror once per response with the response's own `usage`
 * block, which is the same shape `token_count` reports as `last_token_usage`.
 * No timing is attached: the record carries no decode window and the
 * token_count heuristics that estimate one are keyed on the token_count
 * stream, which by definition is absent when this fallback is used.
 */
function buildMirroredUsageEvent(input: {
  parsed: Record<string, unknown>;
  payload: Record<string, unknown>;
  sessionId: string;
  workspacePath: string;
  model: string | null;
  serviceTier: ServiceTier | null;
  providerId: string | null;
  providerConfig?: CodexProviderConfig;
}): AnyEvent | null {
  const usage = asRecord(input.payload.usage);
  if (usage === null) {
    return null;
  }

  const inputTokens = normalizeInteger(usage.input_tokens) ?? 0;
  const cacheReadTokens = normalizeInteger(usage.cached_input_tokens) ?? 0;
  const outputTokens =
    (normalizeInteger(usage.output_tokens) ?? 0) + (normalizeInteger(usage.reasoning_output_tokens) ?? 0);
  if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
    return null;
  }

  const responseId = normalizeOptionalString(input.payload.response_id);
  const ordinal = normalizeInteger(input.payload.ordinal);
  const key = responseId ?? (ordinal !== null ? `ordinal-${ordinal}` : null);
  if (key === null) {
    return null;
  }

  const timestamp = normalizeOptionalString(input.parsed.timestamp) ?? new Date(0).toISOString();
  return {
    event_id: `codex:session:${input.sessionId}:usage:record:${key}`,
    session_id: input.sessionId,
    timestamp,
    source_vendor: CODEX_SOURCE_VENDOR,
    source_adapter: CODEX_ROLLOUT_ADAPTER,
    workspace_path: input.workspacePath,
    type: "token.usage.recorded",
    message_id: responseId !== null ? `usage_${responseId}` : `usage_record_${ordinal}`,
    model: input.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: normalizeInteger(usage.cache_write_input_tokens) ?? 0,
    cache_read_input_tokens: cacheReadTokens,
    server_tool_use: "{}",
    usage_source: "codex-rollout",
    ...(input.serviceTier ? { service_tier: input.serviceTier } : {}),
    provider_id: input.providerId,
    provider_base_url: input.providerConfig?.baseUrl ?? null,
    provider_host: input.providerConfig?.host ?? null,
    first_token_latency_ms: null,
    decode_duration_ms: null
  };
}

function isMulticaRolloutPath(filePath: string): boolean {
  return /(?:^|[/\\])multica-sessions(?:[/\\]|$)/iu.test(filePath);
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

function resolveTurnStartedMs(payload: Record<string, unknown>, lineTimestamp: unknown): number | null {
  const startedAtSeconds = payload.started_at;
  if (typeof startedAtSeconds === "number" && Number.isFinite(startedAtSeconds) && startedAtSeconds > 0) {
    // Round to whole milliseconds: the schema requires an integer latency, and a
    // fractional unix-seconds value would otherwise leak into the subtraction.
    return Math.round(startedAtSeconds * 1000);
  }

  const lineMs = typeof lineTimestamp === "string" ? Date.parse(lineTimestamp) : Number.NaN;
  return Number.isFinite(lineMs) ? lineMs : null;
}

/**
 * Map Codex's `service_tier` string onto the normalized speed tier. `fast`
 * (renamed from `priority`, the old value still works) and `ultrafast` cost 2x
 * and 6x of list price; `flex` is the discounted batch queue. Every other value
 * ("default", "auto", "standard", unknown) means the standard queue, which is
 * stored as null so the cost layer bills the plain rate card.
 */
function normalizeCodexServiceTier(value: unknown): ServiceTier | null {
  const tier = normalizeOptionalString(value)?.toLowerCase();
  if (tier === "fast" || tier === "priority" || tier === "ultrafast" || tier === "flex") {
    return tier;
  }
  return null;
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

/**
 * Codex tool outputs arrive as either a plain string or an array of content
 * parts (`{type, text}` / raw strings). normalizeOptionalString alone drops
 * array forms and previously forced every such terminal event to "failed".
 */
function coerceToolOutputText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.length > 0) {
        parts.push(item);
      }
      continue;
    }

    const record = asRecord(item);
    const text = normalizeOptionalString(record?.text);
    if (text !== null) {
      parts.push(text);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n");
}

function parseCustomToolOutput(value: string | null): {
  success: boolean;
  durationMs: number;
} {
  return interpretToolOutputText(value);
}

function tryParseStructuredToolOutput(value: string | null): {
  success: boolean;
  durationMs: number;
} | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    const record = asRecord(parsed);
    const metadata = asRecord(record?.metadata);
    const exitCode = normalizeSignedInteger(metadata?.exit_code);
    const durationSeconds = normalizeNumber(metadata?.duration_seconds);

    if (exitCode !== null) {
      return {
        success: exitCode === 0,
        durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : 0
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parseFunctionCallOutput(value: string | null): {
  success: boolean;
  durationMs: number;
} {
  return interpretToolOutputText(value);
}

/**
 * Decide success/failure from a terminal tool output payload.
 *
 * Codex frequently omits "Exit code: 0" for completed tools (search/read
 * results, script cell updates, structured content blocks). Treat only an
 * explicit non-zero exit as failure; any other non-empty terminal output is
 * success so the failure rate matches user experience.
 */
function interpretToolOutputText(value: string | null): {
  success: boolean;
  durationMs: number;
} {
  const structured = tryParseStructuredToolOutput(value);
  if (structured !== null) {
    return structured;
  }

  if (value === null) {
    return {
      success: false,
      durationMs: 0
    };
  }

  const exitCodeMatch = /Exit code:\s*(-?\d+)/iu.exec(value);
  const processExitCodeMatch = /Process exited with code\s*(-?\d+)/iu.exec(value);
  const durationMs = extractWallTimeMs(value) ?? 0;
  const runningSessionMatch = /Process running with session ID\s+\d+/iu.exec(value);
  const scriptRunningMatch = /Script running with cell ID\s+\S+/iu.exec(value);
  const scriptCompletedMatch = /Script completed/iu.exec(value);

  const normalizedExitCode = exitCodeMatch?.[1] ?? processExitCodeMatch?.[1] ?? null;
  if (normalizedExitCode !== null) {
    const exitCode = Number.parseInt(normalizedExitCode, 10);
    return {
      success: exitCode === 0,
      durationMs
    };
  }

  if (
    runningSessionMatch !== null ||
    scriptRunningMatch !== null ||
    scriptCompletedMatch !== null ||
    value.trim().length > 0
  ) {
    return {
      success: true,
      durationMs
    };
  }

  return {
    success: false,
    durationMs: 0
  };
}

function extractWallTimeMs(value: string): number | null {
  // "Wall time: 2.7 seconds" / "Wall time 10.0 seconds" / "Wall time: 64 ms"
  const wallTimeMatch =
    /Wall time:?\s*([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|ms|seconds?|s)\b/iu.exec(value);
  if (wallTimeMatch === null) {
    return null;
  }

  const durationValue = Number.parseFloat(wallTimeMatch[1]);
  if (!Number.isFinite(durationValue)) {
    return null;
  }

  const unit = wallTimeMatch[2].toLowerCase();
  return unit.startsWith("ms") || unit.startsWith("millisecond")
    ? Math.round(durationValue)
    : Math.round(durationValue * 1000);
}

function normalizeSignedInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
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

function getExecCommandDurationMs(payload: Record<string, unknown>): number {
  const duration = asRecord(payload.duration);
  const seconds = normalizeInteger(duration?.secs) ?? 0;
  const nanoseconds = normalizeInteger(duration?.nanos) ?? 0;

  return Math.round(seconds * 1000 + nanoseconds / 1_000_000);
}

function inferExecCommandToolName(command: unknown): string {
  if (!Array.isArray(command) || command.length === 0) {
    return "ExecCommand";
  }

  const executable = normalizeOptionalString(command[0]);
  if (executable === null) {
    return "ExecCommand";
  }

  const normalized = basename(executable).toLowerCase();
  const wrappedCommand = findWrappedCommandArgument(command.slice(1));
  if (wrappedCommand !== null) {
    return inferCommandStringToolName(wrappedCommand);
  }

  switch (normalized) {
    case "powershell.exe":
    case "powershell":
    case "pwsh.exe":
    case "pwsh":
      return "PowerShell";
    case "bash.exe":
    case "bash":
    case "zsh":
      return "Bash";
    case "cmd.exe":
    case "cmd":
      return "Cmd";
    default: {
      const withoutExtension = normalized.endsWith(".exe")
        ? normalized.slice(0, -4)
        : normalized;

      return withoutExtension.length > 0
        ? `${withoutExtension[0]?.toUpperCase() ?? ""}${withoutExtension.slice(1)}`
        : "ExecCommand";
    }
  }
}

function shouldTrackFunctionCall(functionName: string): boolean {
  return functionName === "shell_command" || functionName === "exec_command";
}

function inferFunctionCallToolName(functionName: string, argumentText: string | null): string {
  if (functionName === "shell_command") {
    const argumentsRecord = argumentText ? parseJsonRecord(argumentText) : null;
    const command = normalizeOptionalString(argumentsRecord?.command);

    return command !== null ? inferCommandStringToolName(command) : functionName;
  }

  if (functionName === "exec_command") {
    const argumentsRecord = argumentText ? parseJsonRecord(argumentText) : null;
    const command = normalizeOptionalString(argumentsRecord?.cmd);

    return command !== null ? inferCommandStringToolName(command) : functionName;
  }

  return functionName;
}

function summarizeFunctionCallArguments(functionName: string, argumentText: string | null): string {
  if (argumentText === null) {
    return "{}";
  }

  if (functionName === "shell_command") {
    const argumentsRecord = parseJsonRecord(argumentText);
    return normalizeOptionalString(argumentsRecord?.command) ?? argumentText;
  }

  if (functionName === "exec_command") {
    const argumentsRecord = parseJsonRecord(argumentText);
    return normalizeOptionalString(argumentsRecord?.cmd) ?? argumentText;
  }

  return argumentText;
}

function inferCommandStringToolName(command: string): string {
  const normalized = findCommandStringToolToken(command);

  switch (normalized) {
    case null:
      return "PowerShell";
    case "powershell.exe":
    case "powershell":
    case "pwsh.exe":
    case "pwsh":
      return "PowerShell";
    case "bash.exe":
    case "bash":
      return "Bash";
    case "cmd.exe":
    case "cmd":
      return "Cmd";
    default:
      return normalized.endsWith(".exe") ? normalized.slice(0, -4) : normalized;
  }
}

const SHELL_CONTROL_KEYWORDS = new Set([
  "if",
  "else",
  "elseif",
  "for",
  "foreach",
  "while",
  "switch",
  "try",
  "catch",
  "finally",
  "function",
  "param",
  "return",
  "throw",
  "do",
  "until",
  "where-object",
  "select-object",
  "measure-object"
]);

const NON_COMMAND_FILE_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".pid",
  ".sqlite",
  ".test.ts",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

function findCommandStringToolToken(command: string): string | null {
  const tokens = command.split(/\s+/u).filter((token) => token.length > 0);
  let hereStringTerminator: "'@" | '"@' | null = null;

  for (const rawToken of tokens) {
    if (hereStringTerminator !== null) {
      if (rawToken.endsWith(hereStringTerminator)) {
        hereStringTerminator = null;
      }
      continue;
    }

    if (rawToken.startsWith("@'")) {
      if (!rawToken.endsWith("'@") || rawToken === "@'") {
        hereStringTerminator = "'@";
      }
      continue;
    }

    if (rawToken.startsWith('@"')) {
      if (!rawToken.endsWith('"@') || rawToken === '@"') {
        hereStringTerminator = '"@';
      }
      continue;
    }

    const normalized = normalizeCommandToken(rawToken);
    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

function findWrappedCommandArgument(commandArgs: unknown[]): string | null {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const token = normalizeOptionalString(commandArgs[index]);
    if (token === null) {
      continue;
    }

    const normalized = token.toLowerCase();
    if (
      normalized === "-c" ||
      normalized === "-lc" ||
      normalized === "-command" ||
      normalized === "/c"
    ) {
      return normalizeOptionalString(commandArgs[index + 1]);
    }
  }

  return null;
}

function normalizeCommandToken(rawToken: string): string | null {
  const candidates = [rawToken, extractAssignedCommand(rawToken)];

  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }

    const normalized = normalizeCommandCandidate(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

function extractAssignedCommand(rawToken: string): string | null {
  const match = /^\$[A-Za-z0-9_:.{}-]+=(.+)$/u.exec(rawToken);
  if (match === null) {
    return null;
  }

  return match[1] ?? null;
}

function normalizeCommandCandidate(candidate: string): string | null {
  let cleaned = candidate.trim();
  if (cleaned.length === 0) {
    return null;
  }

  cleaned = cleaned.replace(/^[&([{]+/u, "");
  cleaned = cleaned.replace(/^[`'"]+/u, "");
  cleaned = cleaned.replace(/[;|)\]}]+$/u, "");
  cleaned = cleaned.replace(/[`'"]+$/u, "");
  cleaned = cleaned.replace(/^[@(]+/u, "");

  if (cleaned.length === 0 || cleaned === "-" || cleaned === "=") {
    return null;
  }

  if (/^(?:https?:\/\/|sk-[A-Za-z0-9_-]{8,}|[0-9.]+)$/u.test(cleaned)) {
    return null;
  }

  const extension = inferFileExtension(cleaned);
  if (cleaned.includes(":") || cleaned.includes("\\") || cleaned.includes("/")) {
    if (extension !== ".exe" && extension !== ".cmd" && extension !== ".bat") {
      return null;
    }
  }

  const normalized = basename(cleaned).toLowerCase();
  if (normalized.length === 0 || normalized.startsWith("$")) {
    return null;
  }

  if (SHELL_CONTROL_KEYWORDS.has(normalized)) {
    return null;
  }

  if (NON_COMMAND_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  return normalized;
}

function inferFileExtension(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.endsWith(".test.ts")) {
    return ".test.ts";
  }

  const lastDot = normalized.lastIndexOf(".");
  return lastDot >= 0 ? normalized.slice(lastDot) : "";
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
