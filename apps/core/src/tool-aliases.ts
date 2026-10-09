import { canonicalizeJson, sha256Hex, type NormalizedEventV2 } from "@agent-metrics/event-schema";
import type { SqliteDatabaseLike } from "./domain-migrations.js";

type StoredToolRow = {
  event_id: string;
  timestamp: string;
  payload_json: string;
};

type ToolEvent = Extract<
  NormalizedEventV2,
  { type: "tool.called" | "tool.succeeded" | "tool.failed" }
>;

type TerminalToolEvent = Extract<
  NormalizedEventV2,
  { type: "tool.succeeded" | "tool.failed" }
>;

function isTerminalToolEvent(event: ToolEvent): event is TerminalToolEvent {
  return event.type === "tool.succeeded" || event.type === "tool.failed";
}

type ToolNode = {
  observedId: string;
  sourceAdapter: "claude-hook" | "claude-transcript";
  toolName: string;
  timestamps: string[];
  eventIds: string[];
};

const ALIAS_RULE_VERSION = "claude-tool-alias-v1";
const MAX_ALIAS_DISTANCE_MS = 5_000;

export function recomputeClaudeToolAliases(
  db: SqliteDatabaseLike,
  sourceInstanceId: string,
  sessionId: string,
  observedAt: string
): void {
  const rows = db
    .prepare<StoredToolRow>(
      `SELECT event_id, timestamp, payload_json
       FROM normalized_events
       WHERE source_instance_id = ? AND session_id = ?
         AND event_type IN ('tool.called', 'tool.succeeded', 'tool.failed')`
    )
    .all(sourceInstanceId, sessionId);
  const nodes = collectNodes(rows);

  db.prepare(
    "DELETE FROM tool_call_aliases WHERE source_instance_id = ? AND session_id = ?"
  ).run(sourceInstanceId, sessionId);

  const hookNodes = [...nodes.values()].filter((node) => node.sourceAdapter === "claude-hook");
  const transcriptNodes = [...nodes.values()].filter((node) => node.sourceAdapter === "claude-transcript");
  const edges = new Map<string, ToolNode[]>();
  const reverseEdges = new Map<string, ToolNode[]>();

  for (const hook of hookNodes) {
    const candidates = transcriptNodes.filter(
      (transcript) =>
        hook.toolName === transcript.toolName &&
        hook.observedId !== transcript.observedId &&
        nodesAreClose(hook, transcript)
    );
    edges.set(nodeKey(hook), candidates);
    for (const candidate of candidates) {
      const key = nodeKey(candidate);
      const current = reverseEdges.get(key) ?? [];
      current.push(hook);
      reverseEdges.set(key, current);
    }
  }

  for (const hook of hookNodes) {
    const candidates = edges.get(nodeKey(hook)) ?? [];
    const unique = candidates.length === 1 && (reverseEdges.get(nodeKey(candidates[0])) ?? []).length === 1;
    if (unique) {
      const transcript = candidates[0];
      db.prepare(
        `INSERT INTO tool_call_aliases (
          source_instance_id, session_id, observed_tool_call_id, canonical_tool_call_id,
          rule_version, evidence_event_ids, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sourceInstanceId,
        sessionId,
        hook.observedId,
        transcript.observedId,
        ALIAS_RULE_VERSION,
        JSON.stringify([...new Set([...hook.eventIds, ...transcript.eventIds])].sort()),
        observedAt
      );
      continue;
    }

    if (hook.observedId.startsWith("derived:")) {
      recordAliasDiagnostic(db, {
        sourceInstanceId,
        sessionId,
        eventId: hook.eventIds[0],
        observedId: hook.observedId,
        candidateIds: candidates.map((candidate) => candidate.observedId),
        observedAt
      });
    }
  }

  rebuildClaudeToolCalls(db, sourceInstanceId, sessionId, observedAt);
}

function collectNodes(rows: StoredToolRow[]): Map<string, ToolNode> {
  const nodes = new Map<string, ToolNode>();
  for (const row of rows) {
    const event = parseToolEvent(row.payload_json);
    if (event === null || (event.source_adapter !== "claude-hook" && event.source_adapter !== "claude-transcript")) {
      continue;
    }

    const key = `${event.source_adapter}\u0000${event.tool_call_id}`;
    const current = nodes.get(key) ?? {
      observedId: event.tool_call_id,
      sourceAdapter: event.source_adapter,
      toolName: event.tool_name,
      timestamps: [],
      eventIds: []
    };
    current.timestamps.push(row.timestamp);
    current.eventIds.push(row.event_id);
    nodes.set(key, current);
  }

  return nodes;
}

function rebuildClaudeToolCalls(
  db: SqliteDatabaseLike,
  sourceInstanceId: string,
  sessionId: string,
  observedAt: string
): void {
  const rows = db
    .prepare<StoredToolRow>(
      `SELECT event_id, timestamp, payload_json
       FROM normalized_events
       WHERE source_instance_id = ? AND session_id = ?
         AND event_type IN ('tool.called', 'tool.succeeded', 'tool.failed')`
    )
    .all(sourceInstanceId, sessionId);
  const aliases = new Map(
    db
      .prepare<{ observed_tool_call_id: string; canonical_tool_call_id: string }>(
        `SELECT observed_tool_call_id, canonical_tool_call_id
         FROM tool_call_aliases
         WHERE source_instance_id = ? AND session_id = ?`
      )
      .all(sourceInstanceId, sessionId)
      .map((row) => [row.observed_tool_call_id, row.canonical_tool_call_id] as const)
  );

  const groups = new Map<string, Array<{ event: ToolEvent; eventId: string; timestamp: string }>>();
  for (const row of rows) {
    const event = parseToolEvent(row.payload_json);
    if (event === null) continue;
    const canonicalId = aliases.get(event.tool_call_id) ?? event.tool_call_id;
    const current = groups.get(canonicalId) ?? [];
    current.push({ event, eventId: row.event_id, timestamp: row.timestamp });
    groups.set(canonicalId, current);
  }

  db.prepare("DELETE FROM tool_calls WHERE source_instance_id = ? AND session_id = ?").run(
    sourceInstanceId,
    sessionId
  );

  for (const [toolCallId, candidates] of groups) {
    candidates.sort(compareCandidates);
    const starts = candidates.filter((candidate) => candidate.event.type === "tool.called");
    const terminals = candidates.filter(
      (candidate) => candidate.event.type === "tool.succeeded" || candidate.event.type === "tool.failed"
    );
    const start = starts[0];
    // Prefer name-matched success over failure (same rule as domain-projection).
    const nameMatchedTerminals = terminals.filter(
      (candidate) => !start || candidate.event.tool_name === start.event.tool_name
    );
    const terminal =
      nameMatchedTerminals.find((candidate) => candidate.event.status === "succeeded") ??
      nameMatchedTerminals[nameMatchedTerminals.length - 1] ??
      terminals.find((candidate) => candidate.event.status === "succeeded") ??
      terminals[terminals.length - 1];

    for (const candidate of terminals) {
      if (start && candidate.event.tool_name !== start.event.tool_name) {
        recordLifecycleDiagnostic(db, {
          sourceInstanceId,
          sessionId,
          eventId: candidate.eventId,
          toolCallId,
          observedAt,
          summary: "Claude terminal tool name does not match its canonical start."
        });
      }
    }

    const startedAt = start?.timestamp ?? null;
    const finishedAt = terminal?.timestamp ?? null;
    // Prefer the terminal event's source-reported duration_ms (spec section 9.4).
    // Fall back to the startedAt/finishedAt delta only when the terminal event
    // did not carry a valid non-negative duration_ms.
    const terminalEvent = terminal?.event;
    const terminalDuration =
      terminalEvent && isTerminalToolEvent(terminalEvent) ? terminalEvent.duration_ms : undefined;
    const timestampDuration = startedAt && finishedAt ? durationBetween(startedAt, finishedAt) : null;
    const durationMs = typeof terminalDuration === "number" && terminalDuration >= 0
      ? terminalDuration
      : timestampDuration;
    db.prepare(
      `INSERT INTO tool_calls (
        source_instance_id, session_id, tool_call_id, tool_name, started_at,
        finished_at, status, duration_ms, diagnostic_flags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sourceInstanceId,
      sessionId,
      toolCallId,
      start?.event.tool_name ?? terminal?.event.tool_name ?? "unknown",
      startedAt,
      finishedAt,
      terminal?.event.status ?? "started",
      durationMs,
      null
    );
  }
}

function parseToolEvent(value: string): ToolEvent | null {
  try {
    const event = JSON.parse(value) as Partial<ToolEvent>;
    if (
      (event.type === "tool.called" || event.type === "tool.succeeded" || event.type === "tool.failed") &&
      typeof event.tool_call_id === "string" &&
      typeof event.tool_name === "string" &&
      (event.status === "started" || event.status === "succeeded" || event.status === "failed") &&
      (event.source_adapter === "claude-hook" || event.source_adapter === "claude-transcript")
    ) {
      return event as ToolEvent;
    }
  } catch {
    return null;
  }

  return null;
}

function compareCandidates(
  left: { eventId: string; timestamp: string },
  right: { eventId: string; timestamp: string }
): number {
  return left.timestamp.localeCompare(right.timestamp) || left.eventId.localeCompare(right.eventId);
}

function nodesAreClose(left: ToolNode, right: ToolNode): boolean {
  return left.timestamps.some((leftTimestamp) =>
    right.timestamps.some((rightTimestamp) => {
      const difference = Math.abs(Date.parse(leftTimestamp) - Date.parse(rightTimestamp));
      return Number.isFinite(difference) && difference <= MAX_ALIAS_DISTANCE_MS;
    })
  );
}

function nodeKey(node: ToolNode): string {
  return `${node.sourceAdapter}\u0000${node.observedId}`;
}

function durationBetween(startedAt: string, finishedAt: string): number | null {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
}

function recordAliasDiagnostic(
  db: SqliteDatabaseLike,
  input: {
    sourceInstanceId: string;
    sessionId: string;
    eventId: string;
    observedId: string;
    candidateIds: string[];
    observedAt: string;
  }
): void {
  const evidenceFingerprint = sha256Hex(
    canonicalizeJson({
      sessionId: input.sessionId,
      observedId: input.observedId,
      candidateIds: input.candidateIds.sort()
    })
  );
  writeDiagnostic(db, {
    diagnosticCode: "AMBIGUOUS_TOOL_ALIAS",
    sourceInstanceId: input.sourceInstanceId,
    eventId: input.eventId,
    evidenceFingerprint,
    observedAt: input.observedAt,
    summary: "Claude tool observations have zero or multiple transcript alias candidates."
  });
}

function recordLifecycleDiagnostic(
  db: SqliteDatabaseLike,
  input: {
    sourceInstanceId: string;
    sessionId: string;
    eventId: string;
    toolCallId: string;
    observedAt: string;
    summary: string;
  }
): void {
  writeDiagnostic(db, {
    diagnosticCode: "IDENTITY_CONFLICT",
    sourceInstanceId: input.sourceInstanceId,
    eventId: input.eventId,
    evidenceFingerprint: sha256Hex(
      canonicalizeJson({ sessionId: input.sessionId, toolCallId: input.toolCallId, summary: input.summary })
    ),
    observedAt: input.observedAt,
    summary: input.summary
  });
}

function writeDiagnostic(
  db: SqliteDatabaseLike,
  input: {
    diagnosticCode: string;
    sourceInstanceId: string;
    eventId: string;
    evidenceFingerprint: string;
    observedAt: string;
    summary: string;
  }
): void {
  db.prepare(
    `INSERT INTO event_diagnostics (
      diagnostic_code, source_instance_id, event_id, evidence_fingerprint,
      first_seen_at, last_seen_at, occurrence_count, summary, raw_locator,
      resolution_state, resolver_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, 'open', ?)
    ON CONFLICT(diagnostic_code, source_instance_id, event_id, evidence_fingerprint)
    DO UPDATE SET last_seen_at = excluded.last_seen_at,
                  occurrence_count = event_diagnostics.occurrence_count + 1,
                  summary = excluded.summary,
                  resolver_version = excluded.resolver_version`
  ).run(
    input.diagnosticCode,
    input.sourceInstanceId,
    input.eventId,
    input.evidenceFingerprint,
    input.observedAt,
    input.observedAt,
    input.summary,
    ALIAS_RULE_VERSION
  );
}
