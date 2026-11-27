import { basename } from "node:path";
import { normalizeModelId, normalizeNativeId, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";
import { codexTurnMetadataKey, type CodexTurnInputMetadata } from "./turn-metadata.js";

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

type SessionMetadata = {
  sessionId: string;
  timestamp: string;
  workspacePath: string;
  providerId: string | null;
};

type CodexUsageEvent = Extract<AnyEvent, { type: "token.usage.recorded" }>;

export type CodexParserState = {
  lineIndex: number;
  sourceInstanceId: string | null;
  /** Model and service tier from the most recent turn_context record. */
  turnId?: string | null;
  turnModel?: string | null;
  turnServiceTier?: string | null;
  /** Persisted session setting, used when a turn lacks more specific tier data. */
  threadServiceTier?: string | null;
  sessionMeta: SessionMetadata | null;
  childUsageMeta?: SessionMetadata | null;
  pendingToolCalls: [string, PendingCodexToolCall][];
  /**
   * Events sharing the newest timestamp seen so far. They are held (also
   * across parseLines calls and checkpoints) so same-timestamp ordering stays
   * identical to a whole-file extraction when reads are chunked.
   */
  pendingEvents: AnyEvent[];
  /** Mirror fallback stays buffered until the current file has been consumed. */
  mirroredUsageEvents?: AnyEvent[];
  mirroredUsageDeferredEvents?: AnyEvent[];
  tokenCountUsageSeen?: boolean;
  pendingMirror?: CodexUsageEvent | null;
  previousTotalTokens?: number | null;
  /** Optional for compatibility with checkpoints created before timing support. */
  lastTokenEventMs?: number | null;
  /** Model and tier for the last timing anchor; omitted by older checkpoints. */
  lastTokenEventModel?: string | null;
  lastTokenEventTier?: string | null;
  /** Tool calls that can still be running across parseLines/checkpoint boundaries. */
  activeTimingToolCalls?: string[];
  /** Unmatched tool boundaries without a usable call id; kept conservative. */
  activeUnkeyedTimingTools?: number;
  turnStartedMs?: number | null;
  turnFirstTokenReported?: boolean;
};

type TimingBoundary = {
  kind: "begin" | "end";
  key: string | null;
};

export type CodexRolloutParser = {
  parseLines(lines: Iterable<string>): NormalizedEventV2[];
  flush(): NormalizedEventV2[];
  checkpoint(): CodexParserState;
};

function getResponseItemTimingBoundary(
  payloadType: string,
  callId: string | null
): TimingBoundary | null {
  const normalized = payloadType.toLowerCase();
  const key = callId === null ? null : `tool:${callId}`;

  if (/(?:^|_)call_output$/u.test(normalized) || /(?:^|_)tool_output$/u.test(normalized)) {
    return { kind: "end", key };
  }
  if (/(?:^|_)call$/u.test(normalized) || /(?:^|_)tool_call$/u.test(normalized)) {
    return { kind: "begin", key };
  }

  return null;
}

function getEventMessageTimingBoundary(
  payloadType: string,
  callId: string | null
): TimingBoundary | null {
  const normalized = payloadType.toLowerCase();
  const boundaryMatch =
    /^(exec_command|web_search|patch_apply|mcp_tool_call|computer_call|tool_call)_(begin|end)$/u.exec(
      normalized
    );
  if (boundaryMatch) {
    const family = boundaryMatch[1] ?? "tool";
    const phase = boundaryMatch[2];
    return {
      kind: phase === "begin" ? "begin" : "end",
      key: callId === null ? null : `tool:${callId}`
    };
  }

  const waitFamily = normalized.includes("approval")
    ? "approval"
    : normalized.includes("user_input")
      ? "user-input"
      : normalized.includes("wait")
        ? "wait"
        : null;
  if (waitFamily === null) {
    return null;
  }

  const key = callId === null ? `wait:${waitFamily}` : `wait:${waitFamily}:${callId}`;
  if (
    /(?:^|_)(?:end|complete|completed|resolved|approved|granted|denied|rejected|received|resumed)$/u.test(
      normalized
    )
  ) {
    return { kind: "end", key };
  }
  if (/(?:^|_)(?:begin|start|started|requested|waiting|pending)$/u.test(normalized)) {
    return { kind: "begin", key };
  }

  // Unknown approval/wait markers still break the current interval. If the
  // rollout does not describe when the wait ends, leave subsequent speed
  // estimates unknown rather than silently counting the wait as decoding.
  return { kind: "begin", key };
}

export function extractCodexEventsFromRollout(input: {
  filePath: string;
  contents: string;
  sessionModels?: Record<string, string>;
  providerConfigs?: Record<string, CodexProviderConfig>;
  turnInputMetadata?: ReadonlyMap<string, CodexTurnInputMetadata>;
  sourceInstanceId?: string;
}): NormalizedEventV2[] {
  const parser = createCodexRolloutParser(input);
  return [...parser.parseLines(input.contents.split(/\r?\n/u)), ...parser.flush()];
}

/**
 * Stateful rollout parser. Session context and in-flight tool calls survive
 * chunked reads, so records appended later keep their cross-line pairing.
 * Events are emitted per call as NormalizedEventV2, in the same order a
 * whole-file extraction produces.
 */
export function createCodexRolloutParser(
  input: {
    filePath: string;
    sessionModels?: Record<string, string>;
    providerConfigs?: Record<string, CodexProviderConfig>;
    turnInputMetadata?: ReadonlyMap<string, CodexTurnInputMetadata>;
    sourceInstanceId?: string;
  },
  state?: CodexParserState
): CodexRolloutParser {
  const pendingToolCalls = new Map<string, PendingCodexToolCall>(state?.pendingToolCalls ?? []);
  const activeTimingToolCalls = new Set([
    ...(state?.activeTimingToolCalls ?? []),
    ...[...pendingToolCalls.keys()].map((callId) => `tool:${callId}`)
  ]);
  let activeUnkeyedTimingTools = Math.max(0, state?.activeUnkeyedTimingTools ?? 0);
  let sessionMeta: SessionMetadata | null = state?.sessionMeta ?? null;
  let childUsageMeta: SessionMetadata | null = state?.childUsageMeta ?? null;
  let lastTokenEventMs = state?.lastTokenEventMs ?? null;
  let lastTokenEventModel = state?.lastTokenEventModel ?? null;
  let lastTokenEventTier = state?.lastTokenEventTier ?? null;
  let turnStartedMs = state?.turnStartedMs ?? null;
  let turnFirstTokenReported = state?.turnFirstTokenReported ?? false;
  let turnModel = state?.turnModel ?? null;
  let turnServiceTier = state?.turnServiceTier ?? null;
  let threadServiceTier = state?.threadServiceTier ?? null;
  let turnId = state?.turnId ?? null;
  let sourceInstanceId =
    state?.sourceInstanceId ??
    input.sourceInstanceId ??
    (isMulticaRolloutPath(input.filePath) ? "codex:multica" : null);
  let nextLineIndex = state?.lineIndex ?? 0;
  const pendingEvents: AnyEvent[] = [...(state?.pendingEvents ?? [])];
  const mirroredUsageEvents: AnyEvent[] = [...(state?.mirroredUsageEvents ?? [])];
  const mirroredUsageDeferredEvents: AnyEvent[] = [...(state?.mirroredUsageDeferredEvents ?? [])];
  let tokenCountUsageSeen = state?.tokenCountUsageSeen ?? false;
  let pendingMirror: CodexUsageEvent | null = state?.pendingMirror ?? null;
  let previousTotalTokens: number | null = state?.previousTotalTokens ?? null;

  // Older checkpoints have a timestamp anchor but cannot say which model/tier
  // it belongs to. Drop that one estimate rather than risk joining unlike work.
  if (state?.lastTokenEventMs != null && state.lastTokenEventModel === undefined) {
    lastTokenEventMs = null;
  }
  if (activeTimingToolCalls.size > 0 || activeUnkeyedTimingTools > 0) {
    // Legacy checkpoints only preserved tool calls that the UI knows how to
    // display. Treat those as timing interruptions too.
    turnFirstTokenReported = true;
    lastTokenEventMs = null;
  }

  function drainPendingEvents(): AnyEvent[] {
    if (pendingEvents.length === 0) {
      return [];
    }

    const drained = [...pendingEvents].sort(compareCodexEvents);
    pendingEvents.length = 0;
    return drained;
  }

  function pendingTimestamp(): string | null {
    let latest: string | null = null;
    for (const event of pendingEvents) {
      if (latest === null || event.timestamp.localeCompare(latest) > 0) {
        latest = event.timestamp;
      }
    }
    return latest;
  }

  // Sort on the legacy AnyEvent shape (readable, stable event_id) before
  // wrapping to V2 so ordering among same-timestamp events is unaffected by
  // the hash-based V2 event_id.
  function wrapEvents(events: AnyEvent[]): NormalizedEventV2[] {
    return events.map((event) =>
      toNormalizedEventV2(event, {
        sourceRecordId: event.event_id,
        ...(sourceInstanceId ? { sourceInstanceId } : {})
      })
    );
  }

  return {
    checkpoint(): CodexParserState {
      return {
        lineIndex: nextLineIndex,
        sourceInstanceId,
        sessionMeta,
        childUsageMeta,
        pendingToolCalls: [...pendingToolCalls],
        pendingEvents: [...pendingEvents],
        mirroredUsageEvents: [...mirroredUsageEvents],
        mirroredUsageDeferredEvents: [...mirroredUsageDeferredEvents],
        tokenCountUsageSeen,
        pendingMirror,
        previousTotalTokens,
        lastTokenEventMs,
        lastTokenEventModel,
        lastTokenEventTier,
        activeTimingToolCalls: [...activeTimingToolCalls],
        activeUnkeyedTimingTools,
        turnStartedMs,
        turnFirstTokenReported,
        turnId,
        turnModel,
        turnServiceTier,
        threadServiceTier
      };
    },
    flush(): NormalizedEventV2[] {
      // token_count remains authoritative for the whole rollout, even when a
      // mirror arrived in an earlier byte-budgeted chunk. Hold later events as
      // well so falling back at EOF preserves chronological ordering.
      const events = [
        ...mirroredUsageDeferredEvents,
        ...(tokenCountUsageSeen ? [] : mirroredUsageEvents),
        ...drainPendingEvents()
      ].sort(compareCodexEvents);
      mirroredUsageEvents.length = 0;
      mirroredUsageDeferredEvents.length = 0;
      return wrapEvents(events);
    },
    parseLines(lines: Iterable<string>): NormalizedEventV2[] {
      const emitted: AnyEvent[] = [];

      const breakTimingAnchor = (timestamp: string | null, invalidateTtft: boolean): void => {
        lastTokenEventMs = null;
        lastTokenEventModel = null;
        lastTokenEventTier = null;
        if (invalidateTtft && !turnFirstTokenReported) {
          turnFirstTokenReported = true;
        }

        if (timestamp === null) {
          return;
        }

        // Same-timestamp records are sorted after parsing (tool events sort
        // before token usage). Clear a usage row already seen at that timestamp
        // so chunk boundaries cannot preserve a contaminated estimate.
        for (const event of [...pendingEvents, ...emitted]) {
          if (event.type === "token.usage.recorded" && event.timestamp === timestamp) {
            event.decode_duration_ms = null;
            if (invalidateTtft) {
              event.first_token_latency_ms = null;
            }
          }
        }
      };

      const applyTimingBoundary = (
        boundary: TimingBoundary | null,
        timestamp: string | null
      ): void => {
        if (boundary === null) {
          return;
        }

        breakTimingAnchor(timestamp, true);
        if (boundary.kind === "begin") {
          if (boundary.key === null) {
            activeUnkeyedTimingTools += 1;
          } else {
            activeTimingToolCalls.add(boundary.key);
          }
        } else if (boundary.key === null) {
          activeUnkeyedTimingTools = Math.max(0, activeUnkeyedTimingTools - 1);
        } else if (boundary.key.startsWith("wait:") && boundary.key.split(":").length === 2) {
          const familyPrefix = `${boundary.key}:`;
          for (const key of activeTimingToolCalls) {
            if (key === boundary.key || key.startsWith(familyPrefix)) {
              activeTimingToolCalls.delete(key);
            }
          }
        } else {
          activeTimingToolCalls.delete(boundary.key);
        }
      };

      const endTimingWaits = (timestamp: string | null): void => {
        const waitKeys = [...activeTimingToolCalls].filter((key) => key.startsWith("wait:"));
        if (waitKeys.length === 0) {
          return;
        }
        breakTimingAnchor(timestamp, true);
        for (const key of waitKeys) {
          activeTimingToolCalls.delete(key);
        }
      };

      const push = (event: AnyEvent): void => {
        const latest = pendingTimestamp();
        if (latest !== null && event.timestamp.localeCompare(latest) > 0) {
          emitted.push(...drainPendingEvents());
        }
        pendingEvents.push(event);
      };

      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }

        const lineIndex = nextLineIndex++;
        const parsed = parseJsonRecord(line);
        if (parsed === null) {
          continue;
        }

        const eventType = normalizeOptionalString(parsed.type);
        const payload = asRecord(parsed.payload);

        if (eventType === "event_msg" && payload !== null &&
            normalizeOptionalString(payload.type) === "thread_settings_applied") {
          const settings = asRecord(payload.thread_settings);
          const nextTier = normalizeCodexThreadServiceTier(settings?.service_tier ?? payload.service_tier);
          if (threadServiceTier !== nextTier) {
            breakTimingAnchor(normalizeOptionalString(parsed.timestamp), false);
          }
          threadServiceTier = nextTier;
          continue;
        }

        if (eventType === "turn_context" && payload !== null) {
          const nextTurnId = normalizeOptionalString(payload.turn_id);
          const nextTurnModel = normalizeModelId(normalizeOptionalString(payload.model));
          const nextTurnServiceTier =
            normalizeOptionalString(payload.service_tier) ?? normalizeOptionalString(payload.speed);
          if (
            turnId !== nextTurnId ||
            turnModel !== nextTurnModel ||
            turnServiceTier !== nextTurnServiceTier
          ) {
            breakTimingAnchor(normalizeOptionalString(parsed.timestamp), false);
          }
          turnId = nextTurnId;
          turnModel = nextTurnModel;
          turnServiceTier = nextTurnServiceTier;
          continue;
        }

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

          const metadata: SessionMetadata = {
            sessionId,
            timestamp,
            workspacePath: normalizeOptionalString(payload.cwd) ?? ".",
            providerId: normalizeOptionalString(payload.model_provider)
          };
          sessionMeta = metadata;
          // A spawned rollout can contain the parent's metadata immediately after
          // its own header. Its cumulative usage counters belong to the child.
          if (childUsageMeta === null && asRecord(asRecord(payload.source)?.subagent)?.thread_spawn) {
            childUsageMeta = metadata;
          }
          push({
            event_id: `codex:session:${sessionId}:started`,
            session_id: sessionId,
            timestamp,
            source_vendor: CODEX_SOURCE_VENDOR,
            source_adapter: CODEX_ROLLOUT_ADAPTER,
            workspace_path: metadata.workspacePath,
            type: "session.started",
            ...(originator ? { originator } : {})
          });
          continue;
        }

        if (eventType === "token_usage_record" && payload !== null) {
          const activeMeta = childUsageMeta ?? sessionMeta;
          const sessionId = activeMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
          if (sessionId !== null) {
            const providerId = activeMeta?.providerId ?? null;
            const turnInputMetadata = turnModel !== null && turnId !== null
              ? input.turnInputMetadata?.get(codexTurnMetadataKey(sessionId, turnId))
              : undefined;
            const databaseTier = turnModel !== null && turnInputMetadata !== undefined &&
              normalizeModelId(turnInputMetadata.model) === turnModel
                ? normalizeOptionalString(turnInputMetadata.serviceTier)
                : null;
            const mirrored = buildMirroredUsageEvent({
              parsed,
              payload,
              sessionId,
              workspacePath: activeMeta?.workspacePath ?? ".",
              model: turnModel ?? normalizeModelId(input.sessionModels?.[sessionId]),
              serviceTier: turnServiceTier ?? databaseTier ?? threadServiceTier,
              providerId,
              providerConfig: providerId ? input.providerConfigs?.[providerId] : undefined
            });
            if (mirrored !== null) {
              pendingMirror = mirrored;
              if (!tokenCountUsageSeen) {
                mirroredUsageEvents.push(mirrored);
              }
            }
          }
          continue;
        }

        if (eventType === "response_item" && payload !== null) {
          // Spawned rollouts append the parent's session_meta after the child's
          // header; everything that follows still belongs to the child thread.
          const activeMeta = childUsageMeta ?? sessionMeta;
          const payloadType = normalizeOptionalString(payload.type);
          const timestamp =
            normalizeOptionalString(parsed.timestamp) ??
            activeMeta?.timestamp ??
            new Date(0).toISOString();
          applyTimingBoundary(
            getResponseItemTimingBoundary(
              payloadType ?? "",
              normalizeOptionalString(payload.call_id)
            ),
            timestamp
          );
          const sessionId = activeMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);

          if (sessionId !== null && payloadType === "custom_tool_call") {
            const callId = normalizeOptionalString(payload.call_id);
            if (callId === null) {
              continue;
            }

            const toolName = normalizeOptionalString(payload.name) ?? "unknown";
            const argumentSummary = serializeArgumentSummary(payload.input);

            pendingToolCalls.set(callId, {
              sessionId,
              workspacePath: activeMeta?.workspacePath ?? ".",
              timestamp,
              toolName,
              argumentSummary
            });
            push({
              event_id: `codex:session:${sessionId}:tool:${callId}:started`,
              session_id: sessionId,
              timestamp,
              source_vendor: CODEX_SOURCE_VENDOR,
              source_adapter: CODEX_ROLLOUT_ADAPTER,
              workspace_path: activeMeta?.workspacePath ?? ".",
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
              workspacePath: activeMeta?.workspacePath ?? ".",
              timestamp,
              toolName: inferFunctionCallToolName(functionName, argumentText),
              argumentSummary: summarizeFunctionCallArguments(functionName, argumentText)
            });
            const pending = pendingToolCalls.get(callId);
            if (pending) {
              push({
                event_id: `codex:session:${sessionId}:function:${callId}:started`,
                session_id: sessionId,
                timestamp,
                source_vendor: CODEX_SOURCE_VENDOR,
                source_adapter: CODEX_ROLLOUT_ADAPTER,
                workspace_path: activeMeta?.workspacePath ?? ".",
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
              push({
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
              push({
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
              push({
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
              push({
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
          const activeMeta = childUsageMeta ?? sessionMeta;
          const payloadType = normalizeOptionalString(payload.type);
          const timestamp =
            normalizeOptionalString(parsed.timestamp) ??
            activeMeta?.timestamp ??
            new Date(0).toISOString();
          applyTimingBoundary(
            getEventMessageTimingBoundary(
              payloadType ?? "",
              normalizeOptionalString(payload.call_id)
            ),
            timestamp
          );
          if (payloadType === "user_message") {
            endTimingWaits(timestamp);
          }
          const sessionId = activeMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
          const eventKey = buildEventKey(parsed, payloadType ?? "event_msg", lineIndex);

          if (sessionId !== null && payloadType === "user_message") {
            const promptText = normalizeOptionalString(payload.message) ?? "";

            push({
              event_id: `codex:session:${sessionId}:prompt:${eventKey}`,
              session_id: sessionId,
              timestamp,
              source_vendor: CODEX_SOURCE_VENDOR,
              source_adapter: CODEX_ROLLOUT_ADAPTER,
              workspace_path: activeMeta?.workspacePath ?? ".",
              type: "prompt.submitted",
              prompt_id: `prompt_${eventKey}`,
              prompt_chars: promptText.length
            });
            continue;
          }

          if (sessionId !== null && payloadType === "agent_message") {
            const responseText = normalizeOptionalString(payload.message) ?? "";
            const providerId = activeMeta?.providerId ?? null;
            const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;

            push({
              event_id: `codex:session:${sessionId}:response:${eventKey}`,
              session_id: sessionId,
              timestamp,
              source_vendor: CODEX_SOURCE_VENDOR,
              source_adapter: CODEX_ROLLOUT_ADAPTER,
              workspace_path: activeMeta?.workspacePath ?? ".",
              type: "assistant.responded",
              message_id: `response_${eventKey}`,
              model: turnModel ?? normalizeModelId(input.sessionModels?.[sessionId]),
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
            push({
              event_id: `codex:session:${sessionId}:web_search:${callId}:tool`,
              session_id: sessionId,
              timestamp,
              source_vendor: CODEX_SOURCE_VENDOR,
              source_adapter: CODEX_ROLLOUT_ADAPTER,
              workspace_path: activeMeta?.workspacePath ?? ".",
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
              workspace_path: activeMeta?.workspacePath ?? ".",
              tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
              tool_name: inferExecCommandToolName(payload.command),
              duration_ms: getExecCommandDurationMs(payload)
            };

            if (exitCode === 0) {
              push({
                ...baseEvent,
                type: "tool.succeeded",
                status: "succeeded"
              });
            } else {
              push({
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
              push({
                event_id: `codex:session:${sessionId}:patch:${callId}:tool`,
                session_id: sessionId,
                timestamp,
                source_vendor: CODEX_SOURCE_VENDOR,
                source_adapter: CODEX_ROLLOUT_ADAPTER,
                workspace_path: activeMeta?.workspacePath ?? ".",
                type: "tool.succeeded",
                tool_call_id: normalizeNativeId(callId) ?? `native:${callId}`,
                tool_name: "apply_patch",
                status: "succeeded",
                duration_ms: 0
              });
            } else {
              push({
                event_id: `codex:session:${sessionId}:patch:${callId}:tool`,
                session_id: sessionId,
                timestamp,
                source_vendor: CODEX_SOURCE_VENDOR,
                source_adapter: CODEX_ROLLOUT_ADAPTER,
                workspace_path: activeMeta?.workspacePath ?? ".",
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

              push({
                event_id: `codex:session:${sessionId}:patch:${callId}:edit`,
                session_id: sessionId,
                timestamp,
                source_vendor: CODEX_SOURCE_VENDOR,
                source_adapter: CODEX_ROLLOUT_ADAPTER,
                workspace_path: activeMeta?.workspacePath ?? ".",
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
              push({
                event_id: `codex:session:${sessionId}:filechange:${changeId}:edit`,
                session_id: sessionId,
                timestamp,
                source_vendor: CODEX_SOURCE_VENDOR,
                source_adapter: CODEX_ROLLOUT_ADAPTER,
                workspace_path: activeMeta?.workspacePath ?? ".",
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
          // Turn boundaries reset decode timing so idle time between turns is
          // never attributed to generated tokens.
          breakTimingAnchor(normalizeOptionalString(parsed.timestamp), false);
          endTimingWaits(normalizeOptionalString(parsed.timestamp));
          turnStartedMs = resolveTurnStartedMs(payload, parsed.timestamp);
          turnFirstTokenReported = activeTimingToolCalls.size > 0 || activeUnkeyedTimingTools > 0;
          // A context that arrived early still belongs to this turn when IDs
          // match. Older/different context is cleared so its tier cannot leak.
          const taskTurnId = normalizeOptionalString(payload.turn_id);
          if (taskTurnId === null || turnId !== taskTurnId) {
            turnId = null;
            turnModel = null;
            turnServiceTier = null;
          }
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

        const activeMeta = childUsageMeta ?? sessionMeta;
        const sessionId = activeMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
        if (sessionId === null) {
          continue;
        }

        const totalTokens =
          normalizeInteger(totalUsage?.total_tokens) ??
          normalizeInteger(lastUsage?.total_tokens);
        if (totalTokens === null) {
          continue;
        }

        const mirror = pendingMirror;
        pendingMirror = null;
        const unchangedTotal = totalUsage !== null && totalTokens === previousTotalTokens;
        previousTotalTokens = totalUsage === null ? null : totalTokens;
        const usageTimestamp =
          normalizeOptionalString(parsed.timestamp) ??
          activeMeta?.timestamp ??
          new Date(0).toISOString();

        const inputTokens = normalizeInteger(lastUsage?.input_tokens) ?? 0;
        const cacheReadTokens = normalizeInteger(lastUsage?.cached_input_tokens) ?? 0;
        // Codex reports cached input as a subset of input_tokens. Preserve the
        // source-reported gross counter so the shared accounting policy can derive
        // displayed input by subtracting cache-read input exactly once.
        // Codex's output_tokens already includes reasoning_output_tokens. Keep
        // the reported output total so reasoning is not counted twice.
        const outputTokens = normalizeInteger(lastUsage?.output_tokens) ?? 0;
        const turnInputMetadata =
          turnModel !== null && turnId !== null
            ? input.turnInputMetadata?.get(
                codexTurnMetadataKey(activeMeta?.sessionId ?? sessionId, turnId)
              )
            : undefined;
        const databaseTier =
          turnModel !== null &&
          turnInputMetadata !== undefined &&
          normalizeModelId(turnInputMetadata.model) === turnModel
            ? normalizeOptionalString(turnInputMetadata.serviceTier)
            : null;
        const usageServiceTier =
          normalizeOptionalString(lastUsage?.service_tier) ??
          normalizeOptionalString(lastUsage?.speed) ??
          normalizeOptionalString(info.service_tier) ??
          normalizeOptionalString(info.speed) ??
          turnServiceTier ??
          databaseTier ??
          threadServiceTier;

        if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
          // A zero-increment report immediately following a response can omit its
          // usage entirely. Require an unchanged cumulative total as evidence.
          const lagMs = mirror === null ? -1 : Date.parse(usageTimestamp) - Date.parse(mirror.timestamp);
          if (lastUsage !== null && unchangedTotal && mirror !== null && lagMs >= 0 && lagMs <= 1000) {
            const mirrorIndex = mirroredUsageEvents.indexOf(mirror);
            if (mirrorIndex !== -1) {
              mirroredUsageEvents.splice(mirrorIndex, 1);
            }
            push(mirror);
          }
          continue;
        }

        tokenCountUsageSeen = true;
        mirroredUsageEvents.length = 0;

        const providerId = activeMeta?.providerId ?? null;
        const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;
        // Rollouts have no stream chunks, so only estimate decode time between
        // consecutive reports when no tool/wait boundary intervened.
        const usageMs = Date.parse(usageTimestamp);
        const usageModel = turnModel ?? normalizeModelId(input.sessionModels?.[sessionId]);
        if (
          lastTokenEventMs !== null &&
          (usageModel !== lastTokenEventModel || usageServiceTier !== lastTokenEventTier)
        ) {
          breakTimingAnchor(usageTimestamp, false);
        }
        const timingBlocked = activeTimingToolCalls.size > 0 || activeUnkeyedTimingTools > 0;
        const decodeDurationMs =
          !timingBlocked &&
          lastTokenEventMs !== null &&
          Number.isFinite(usageMs) &&
          usageMs >= lastTokenEventMs &&
          usageMs - lastTokenEventMs <= MAX_DECODE_GAP_MS
            ? usageMs - lastTokenEventMs
            : null;
        if (Number.isFinite(usageMs) && !timingBlocked) {
          lastTokenEventMs = usageMs;
          lastTokenEventModel = usageModel;
          lastTokenEventTier = usageServiceTier;
        } else {
          lastTokenEventMs = null;
          lastTokenEventModel = null;
          lastTokenEventTier = null;
        }

        // The first usage report in a turn is an upper-bound first-token
        // observation. Later periodic reports do not measure first-token time.
        const firstTokenLatencyMs =
          !turnFirstTokenReported &&
          turnStartedMs !== null &&
          Number.isFinite(usageMs) &&
          usageMs >= turnStartedMs &&
          usageMs - turnStartedMs <= MAX_FIRST_TOKEN_LATENCY_MS
            ? usageMs - turnStartedMs
            : null;
        turnFirstTokenReported = true;

        push({
          event_id: `codex:session:${sessionId}:usage:${totalTokens}`,
          session_id: sessionId,
          timestamp: usageTimestamp,
          source_vendor: CODEX_SOURCE_VENDOR,
          source_adapter: CODEX_ROLLOUT_ADAPTER,
          workspace_path: activeMeta?.workspacePath ?? ".",
          type: "token.usage.recorded",
          message_id: `usage_${totalTokens}`,
          model: turnModel ?? normalizeModelId(input.sessionModels?.[sessionId]),
          ...(usageServiceTier ? { service_tier: usageServiceTier } : {}),
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheReadTokens,
          server_tool_use: "{}",
          usage_source: "codex-rollout",
          provider_id: providerId,
          provider_base_url: providerConfig?.baseUrl ?? null,
          provider_host: providerConfig?.host ?? null,
          first_token_latency_ms: firstTokenLatencyMs,
          decode_duration_ms: decodeDurationMs
        });
      }

      if (!tokenCountUsageSeen && mirroredUsageEvents.length > 0) {
        mirroredUsageDeferredEvents.push(...emitted);
        return [];
      }
      return wrapEvents([...mirroredUsageDeferredEvents.splice(0), ...emitted].sort(compareCodexEvents));
    }
  };
}

function normalizeCodexThreadServiceTier(value: unknown): string | null {
  const tier = normalizeOptionalString(value)?.toLowerCase();
  return tier === "fast" || tier === "priority" || tier === "ultrafast" || tier === "flex"
    ? tier
    : null;
}

export function inferSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const match = /^rollout-.*-([0-9a-f]{8,}-[0-9a-f-]+)\.jsonl$/iu.exec(name);
  return match?.[1] ?? null;
}

/** Mirror-only rollouts carry usage but do not expose a decode timing window. */
function buildMirroredUsageEvent(input: {
  parsed: Record<string, unknown>;
  payload: Record<string, unknown>;
  sessionId: string;
  workspacePath: string;
  model: string | null;
  serviceTier: string | null;
  providerId: string | null;
  providerConfig?: CodexProviderConfig;
}): CodexUsageEvent | null {
  const usage = asRecord(input.payload.usage);
  if (usage === null) {
    return null;
  }

  const inputTokens = normalizeInteger(usage.input_tokens) ?? 0;
  const cacheReadTokens = normalizeInteger(usage.cached_input_tokens) ?? 0;
  // The mirror uses the same Codex usage shape: reasoning is part of output.
  const outputTokens = normalizeInteger(usage.output_tokens) ?? 0;
  if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
    return null;
  }

  const responseId = normalizeOptionalString(input.payload.response_id);
  const ordinal = normalizeInteger(input.payload.ordinal) ?? normalizeInteger(input.parsed.ordinal);
  // Live files can end between the mirror and the token_count written a few
  // milliseconds later. Current mirrors carry the same cumulative thread total
  // as token_count: using its identity lets the ledger dedupe that later append.
  const threadUsage = asRecord(input.payload.thread_token_usage);
  const cumulativeTotalTokens = normalizeInteger(threadUsage?.total_tokens);
  const key = cumulativeTotalTokens !== null
    ? String(cumulativeTotalTokens)
    : responseId ?? (ordinal !== null ? `ordinal-${ordinal}` : null);
  if (key === null) {
    return null;
  }

  const serviceTier = normalizeOptionalString(usage.service_tier) ??
    normalizeOptionalString(usage.speed) ?? input.serviceTier;
  return {
    event_id: cumulativeTotalTokens !== null
      ? `codex:session:${input.sessionId}:usage:${key}`
      : `codex:session:${input.sessionId}:usage:record:${key}`,
    session_id: input.sessionId,
    timestamp: normalizeOptionalString(input.parsed.timestamp) ?? new Date(0).toISOString(),
    source_vendor: CODEX_SOURCE_VENDOR,
    source_adapter: CODEX_ROLLOUT_ADAPTER,
    workspace_path: input.workspacePath,
    type: "token.usage.recorded",
    message_id: cumulativeTotalTokens !== null
      ? `usage_${key}`
      : responseId !== null ? `usage_${responseId}` : `usage_record_${ordinal}`,
    model: input.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: normalizeInteger(usage.cache_write_input_tokens) ?? 0,
    cache_read_input_tokens: cacheReadTokens,
    server_tool_use: "{}",
    usage_source: "codex-rollout",
    ...(serviceTier ? { service_tier: serviceTier } : {}),
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
  if (
    typeof startedAtSeconds === "number" &&
    Number.isFinite(startedAtSeconds) &&
    startedAtSeconds > 0
  ) {
    // Round to whole milliseconds because the event schema requires integers.
    return Math.round(startedAtSeconds * 1000);
  }

  const lineMs = typeof lineTimestamp === "string" ? Date.parse(lineTimestamp) : Number.NaN;
  return Number.isFinite(lineMs) ? lineMs : null;
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
