import {
  NormalizedEventV2Schema,
  type NormalizedEventV2,
  semanticFingerprint
} from "@agent-metrics/event-schema";
import { displayedInputTokens } from "@agent-metrics/metrics-engine";
import type { SqliteDatabaseLike } from "./domain-migrations.js";
import { recomputeClaudeToolAliases } from "./tool-aliases.js";

type StoredEventRow = {
  event_id: string;
  timestamp: string;
  event_type: NormalizedEventV2["type"];
  payload_json: string;
};

type FingerprintRow = { semantic_fingerprint: string };

export type ProjectionResult = {
  eventId: string;
  semanticFingerprint: string;
  projected: boolean;
  idempotent: boolean;
  conflict: boolean;
};

export function projectNormalizedEvents(
  db: SqliteDatabaseLike,
  events: readonly NormalizedEventV2[],
  observedAt = new Date().toISOString()
): ProjectionResult[] {
  let results: ProjectionResult[] = [];
  const run = db.transaction(() => {
    results = projectNormalizedEventsInTransaction(db, events, observedAt);
  });
  run();
  return results;
}

export function projectNormalizedEventsInTransaction(
  db: SqliteDatabaseLike,
  events: readonly NormalizedEventV2[],
  observedAt = new Date().toISOString()
): ProjectionResult[] {
  const results: ProjectionResult[] = [];
  const affectedSessions = new Set<string>();
  for (const event of events) {
    results.push(projectOne(db, event, observedAt));
    if (isToolEvent(event) && event.source_vendor === "claude-code") {
      affectedSessions.add(`${event.source_instance_id}\u0000${event.session_id}`);
    }
  }
  for (const key of affectedSessions) {
    const separator = key.indexOf("\u0000");
    recomputeClaudeToolAliases(
      db,
      key.slice(0, separator),
      key.slice(separator + 1),
      observedAt
    );
  }
  return results;
}

export function projectNormalizedEvent(
  db: SqliteDatabaseLike,
  event: NormalizedEventV2,
  observedAt = new Date().toISOString()
): ProjectionResult {
  return projectNormalizedEvents(db, [event], observedAt)[0];
}

export function recordProjectionDiagnostic(input: {
  db: SqliteDatabaseLike;
  diagnosticCode: string;
  sourceInstanceId: string;
  eventId: string;
  evidenceFingerprint: string;
  summary: string;
  observedAt?: string;
  locator?: string | null;
  resolverVersion?: string | null;
}): void {
  const observedAt = input.observedAt ?? new Date().toISOString();
  input.db
    .prepare(
      `INSERT INTO event_diagnostics (
        diagnostic_code, source_instance_id, event_id, evidence_fingerprint,
        first_seen_at, last_seen_at, occurrence_count, summary, raw_locator,
        resolution_state, resolver_version
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open', ?)
      ON CONFLICT(diagnostic_code, source_instance_id, event_id, evidence_fingerprint)
      DO UPDATE SET last_seen_at = excluded.last_seen_at,
                    occurrence_count = event_diagnostics.occurrence_count + 1,
                    summary = excluded.summary,
                    raw_locator = excluded.raw_locator,
                    resolver_version = excluded.resolver_version`
    )
    .run(
      input.diagnosticCode,
      input.sourceInstanceId,
      input.eventId,
      input.evidenceFingerprint,
      observedAt,
      observedAt,
      boundSummary(input.summary),
      input.locator ?? null,
      input.resolverVersion ?? null
    );
}

function projectOne(
  db: SqliteDatabaseLike,
  rawEvent: NormalizedEventV2,
  observedAt: string
): ProjectionResult {
  const parsed = NormalizedEventV2Schema.parse(rawEvent);
  const fingerprint = semanticFingerprint(parsed);
  const existing = db
    .prepare<FingerprintRow>("SELECT semantic_fingerprint FROM normalized_events WHERE event_id = ?")
    .all(parsed.event_id);
  const conflict = existing.some((row) => row.semantic_fingerprint !== fingerprint);

  if (conflict && parsed.type === "token.usage.recorded" && parsed.source_vendor === "workbuddy") {
    const reconciled =
      reconcileWorkbuddyTiming(db, parsed) ??
      reconcileUsageCredit(db, parsed) ??
      reconcileUsageCache(db, parsed);
    if (reconciled !== null) {
      return { eventId: parsed.event_id, semanticFingerprint: reconciled,
        projected: false, idempotent: true, conflict: false };
    }
  }

  ensureSourceRegistry(db, parsed, observedAt);
  db.prepare(
    `INSERT OR IGNORE INTO normalized_events (
      event_id, semantic_fingerprint, schema_version, session_id,
      source_instance_id, source_vendor, source_adapter, adapter_instance_id,
      source_record_namespace, source_record_id, event_type, timestamp,
      workspace_path, payload_json, type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    parsed.event_id,
    fingerprint,
    parsed.schema_version,
    parsed.session_id,
    parsed.source_instance_id,
    parsed.source_vendor,
    parsed.source_adapter,
    parsed.adapter_instance_id,
    parsed.source_record_namespace,
    parsed.source_record_id,
    parsed.type,
    parsed.timestamp,
    parsed.workspace_path,
    JSON.stringify(parsed),
    parsed.type,
    observedAt
  );

  db.prepare(
    `INSERT OR IGNORE INTO event_observations (
      event_id, adapter_instance_id, source_adapter, semantic_fingerprint, observed_at
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(parsed.event_id, parsed.adapter_instance_id, parsed.source_adapter, fingerprint, observedAt);

  if (conflict) {
    if (parsed.type === "token.usage.recorded") {
      healUsageModelId(db, parsed);
    }
    recordProjectionDiagnostic({
      db,
      diagnosticCode: "IDENTITY_CONFLICT",
      sourceInstanceId: parsed.source_instance_id,
      eventId: parsed.event_id,
      evidenceFingerprint: fingerprint,
      summary: "The same event_id was observed with a different semantic fingerprint.",
      observedAt
    });
    return {
      eventId: parsed.event_id,
      semanticFingerprint: fingerprint,
      projected: false,
      idempotent: false,
      conflict: true
    };
  }

  ensureSession(db, parsed);
  if (isToolEvent(parsed)) {
    recomputeToolCall(db, parsed, observedAt);
  }
  if (parsed.type === "token.usage.recorded") {
    projectUsage(db, parsed, observedAt);
  }

  return {
    eventId: parsed.event_id,
    semanticFingerprint: fingerprint,
    projected: existing.length === 0,
    idempotent: existing.some((row) => row.semantic_fingerprint === fingerprint),
    conflict: false
  };
}

/** Timing evidence may arrive after the transcript. Enrich only an otherwise
 * identical WorkBuddy event; never change usage or overwrite known timing. */
function reconcileWorkbuddyTiming(
  db: SqliteDatabaseLike,
  incoming: Extract<NormalizedEventV2, { type: "token.usage.recorded" }>
): string | null {
  if (incoming.source_adapter !== "workbuddy-jsonl" || incoming.usage_source !== "workbuddy-usage") return null;
  const row = db.prepare<{ payload_json: string; semantic_fingerprint: string }>(
    "SELECT payload_json, semantic_fingerprint FROM normalized_events WHERE event_id = ?"
  ).get(incoming.event_id);
  if (row === undefined) return null;
  const stored = NormalizedEventV2Schema.parse(JSON.parse(row.payload_json));
  if (stored.type !== "token.usage.recorded") return null;
  const withoutTiming = (value: typeof incoming) => ({
    ...value, first_token_latency_ms: null, decode_duration_ms: null
  });
  if (semanticFingerprint(withoutTiming(stored)) !== semanticFingerprint(withoutTiming(incoming))) return null;
  const keys = ["first_token_latency_ms", "decode_duration_ms"] as const;
  for (const key of keys) {
    const previous = stored[key] ?? null;
    const next = incoming[key] ?? null;
    if (previous !== null && next !== null && previous !== next) return null;
  }
  const merged = { ...stored,
    first_token_latency_ms: stored.first_token_latency_ms ?? incoming.first_token_latency_ms ?? null,
    decode_duration_ms: stored.decode_duration_ms ?? incoming.decode_duration_ms ?? null
  };
  const fingerprint = semanticFingerprint(merged);
  if (fingerprint !== row.semantic_fingerprint) {
    db.prepare(`UPDATE normalized_events SET payload_json = ?, semantic_fingerprint = ? WHERE event_id = ?`)
      .run(JSON.stringify(merged), fingerprint, incoming.event_id);
    db.prepare(`UPDATE usage_events SET first_token_latency_ms = ?, decode_duration_ms = ?,
      semantic_fingerprint = ? WHERE event_id = ?`)
      .run(merged.first_token_latency_ms, merged.decode_duration_ms, fingerprint, incoming.event_id);
    db.prepare("UPDATE event_observations SET semantic_fingerprint = ? WHERE event_id = ?")
      .run(fingerprint, incoming.event_id);
  }
  return fingerprint;
}

/**
 * A billing line can reach the source log after the request it belongs to, so
 * the first projection may have stored the row without a credit. Patch the
 * credit onto an otherwise identical row instead of recording a conflict.
 */
function reconcileUsageCredit(
  db: SqliteDatabaseLike,
  incoming: Extract<NormalizedEventV2, { type: "token.usage.recorded" }>
): string | null {
  if (incoming.credit === undefined || incoming.credit === null) return null;
  const row = db.prepare<{ payload_json: string; semantic_fingerprint: string }>(
    "SELECT payload_json, semantic_fingerprint FROM normalized_events WHERE event_id = ?"
  ).get(incoming.event_id);
  if (row === undefined) return null;
  const stored = NormalizedEventV2Schema.parse(JSON.parse(row.payload_json));
  if (stored.type !== "token.usage.recorded") return null;
  if (stored.credit !== undefined && stored.credit !== null) return null;
  if (semanticFingerprint(withoutCredit(stored)) !== semanticFingerprint(withoutCredit(incoming))) {
    return null;
  }
  const merged = { ...stored, credit: incoming.credit };
  const fingerprint = semanticFingerprint(merged);
  if (fingerprint !== row.semantic_fingerprint) {
    db.prepare(`UPDATE normalized_events SET payload_json = ?, semantic_fingerprint = ? WHERE event_id = ?`)
      .run(JSON.stringify(merged), fingerprint, incoming.event_id);
    db.prepare(`UPDATE usage_events SET credit = ?, semantic_fingerprint = ? WHERE event_id = ?`)
      .run(merged.credit, fingerprint, incoming.event_id);
    db.prepare("UPDATE event_observations SET semantic_fingerprint = ? WHERE event_id = ?")
      .run(fingerprint, incoming.event_id);
  }
  return fingerprint;
}

function withoutCredit<T extends { credit?: number | null }>(value: T): Omit<T, "credit"> {
  const { credit: _credit, ...rest } = value;
  return rest;
}

/**
 * The cache split is logged by the provider layer one line after the usage
 * record, so a request first lands with `cache_read_input_tokens` at 0. For a
 * gross-input source that makes the whole prompt look uncached, inflating the
 * uncached figure by an order of magnitude, so the record is patched as soon as
 * the real split arrives.
 */
function reconcileUsageCache(
  db: SqliteDatabaseLike,
  incoming: Extract<NormalizedEventV2, { type: "token.usage.recorded" }>
): string | null {
  if (incoming.cache_read_input_tokens <= 0) return null;
  const row = db.prepare<{ payload_json: string; semantic_fingerprint: string }>(
    "SELECT payload_json, semantic_fingerprint FROM normalized_events WHERE event_id = ?"
  ).get(incoming.event_id);
  if (row === undefined) return null;
  const stored = NormalizedEventV2Schema.parse(JSON.parse(row.payload_json));
  if (stored.type !== "token.usage.recorded") return null;
  if (stored.cache_read_input_tokens > 0) return null;
  if (semanticFingerprint(withoutCache(stored)) !== semanticFingerprint(withoutCache(incoming))) {
    return null;
  }
  const merged = {
    ...stored,
    cache_read_input_tokens: incoming.cache_read_input_tokens,
    cache_creation_input_tokens: incoming.cache_creation_input_tokens
  };
  const fingerprint = semanticFingerprint(merged);
  if (fingerprint === row.semantic_fingerprint) {
    return fingerprint;
  }
  let displayed: number;
  try {
    displayed = displayedInputTokens({
      inputTokenSemantics: merged.input_token_semantics,
      inputTokens: merged.input_tokens,
      outputTokens: merged.output_tokens,
      cacheCreationInputTokens: merged.cache_creation_input_tokens,
      cacheReadInputTokens: merged.cache_read_input_tokens,
      usageMeasurement: merged.usage_measurement
    });
  } catch {
    return null;
  }
  db.prepare(`UPDATE normalized_events SET payload_json = ?, semantic_fingerprint = ? WHERE event_id = ?`)
    .run(JSON.stringify(merged), fingerprint, incoming.event_id);
  db.prepare(
    `UPDATE usage_events SET cache_read_input_tokens = ?, cache_creation_input_tokens = ?,
     displayed_input_tokens = ?, semantic_fingerprint = ? WHERE event_id = ?`
  ).run(
    merged.cache_read_input_tokens,
    merged.cache_creation_input_tokens,
    displayed,
    fingerprint,
    incoming.event_id
  );
  db.prepare("UPDATE event_observations SET semantic_fingerprint = ? WHERE event_id = ?")
    .run(fingerprint, incoming.event_id);
  return fingerprint;
}

function withoutCache<
  T extends { cache_read_input_tokens: number; cache_creation_input_tokens: number }
>(value: T): Omit<T, "cache_read_input_tokens" | "cache_creation_input_tokens"> {
  const { cache_read_input_tokens: _read, cache_creation_input_tokens: _write, ...rest } = value;
  return rest;
}

function ensureSourceRegistry(
  db: SqliteDatabaseLike,
  event: NormalizedEventV2,
  observedAt: string
): void {
  db.prepare(
    `INSERT INTO source_instances (
      source_instance_id, source_vendor, root_identity, display_name, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(source_instance_id) DO UPDATE SET
      source_vendor = excluded.source_vendor,
      updated_at = excluded.updated_at`
  ).run(event.source_instance_id, event.source_vendor, observedAt, observedAt);
  db.prepare(
    `INSERT INTO adapter_instances (
      adapter_instance_id, source_instance_id, source_adapter, config_fingerprint, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(adapter_instance_id) DO UPDATE SET
      source_instance_id = excluded.source_instance_id,
      source_adapter = excluded.source_adapter,
      updated_at = excluded.updated_at`
  ).run(event.adapter_instance_id, event.source_instance_id, event.source_adapter, observedAt, observedAt);
}

function ensureSession(db: SqliteDatabaseLike, event: NormalizedEventV2): void {
  // session.started anchors the windowed session views; it merges with MIN so
  // repeated announcements keep the earliest one. Every other event only seeds
  // started_at when it is still NULL: Claude transcripts (and any source that
  // skips session.started) must not drop out of windowed session counts, while
  // garbage timestamps on late events cannot drag an anchored start backwards.
  const isSessionStart = event.type === "session.started" ? 1 : 0;
  const startedAt = event.timestamp;
  const endedAt = event.type === "session.ended" ? event.timestamp : null;
  const exitCode = event.type === "session.ended" ? event.exit_code ?? null : null;

  db.prepare(
    `INSERT INTO domain_sessions (
      source_instance_id, session_id, source_vendor, workspace_path,
      started_at, ended_at, exit_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_instance_id, session_id) DO UPDATE SET
      source_vendor = excluded.source_vendor,
      workspace_path = excluded.workspace_path,
      started_at = CASE
        WHEN ? = 1 THEN CASE
          WHEN domain_sessions.started_at IS NULL OR excluded.started_at < domain_sessions.started_at
            THEN excluded.started_at
          ELSE domain_sessions.started_at
        END
        ELSE COALESCE(domain_sessions.started_at, excluded.started_at)
      END,
      ended_at = CASE
        WHEN excluded.ended_at IS NULL THEN domain_sessions.ended_at
        WHEN domain_sessions.ended_at IS NULL OR excluded.ended_at > domain_sessions.ended_at
          THEN excluded.ended_at
        ELSE domain_sessions.ended_at
      END,
      exit_code = COALESCE(excluded.exit_code, domain_sessions.exit_code)`
  ).run(
    event.source_instance_id,
    event.session_id,
    event.source_vendor,
    event.workspace_path,
    startedAt,
    endedAt,
    exitCode,
    isSessionStart
  );
}

function recomputeToolCall(
  db: SqliteDatabaseLike,
  event: Extract<NormalizedEventV2, { type: "tool.called" | "tool.succeeded" | "tool.failed" }>,
  observedAt: string
): void {
  const rows = db
    .prepare<StoredEventRow>(
      `SELECT event_id, timestamp, event_type, payload_json
       FROM normalized_events
       WHERE source_instance_id = ? AND session_id = ?
         AND event_type IN ('tool.called', 'tool.succeeded', 'tool.failed')`
    )
    .all(event.source_instance_id, event.session_id)
    .filter((row) => {
      const candidate = parseToolEvent(row.payload_json);
      return candidate?.tool_call_id === event.tool_call_id;
    })
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.event_id.localeCompare(right.event_id));

  const starts = rows
    .map((row) => parseToolEvent(row.payload_json))
    .filter((candidate): candidate is ToolEventPayload => candidate?.type === "tool.called");
  const terminals = rows
    .map((row) => parseToolEvent(row.payload_json))
    .filter((candidate): candidate is ToolEventPayload => candidate?.type === "tool.succeeded" || candidate?.type === "tool.failed");
  const start = starts[0];
  // Prefer a name-matched succeeded terminal over failed. Historical codex
  // misclassifications may leave both after an adapter fix re-emits success;
  // a real tool_call_id should not end as failed if any terminal reported success.
  const nameMatchedTerminals = terminals.filter(
    (candidate) => !start || candidate.tool_name === start.tool_name
  );
  const terminal =
    nameMatchedTerminals.find((candidate) => candidate.status === "succeeded") ??
    nameMatchedTerminals[nameMatchedTerminals.length - 1] ??
    terminals.find((candidate) => candidate.status === "succeeded") ??
    terminals[terminals.length - 1];

  if (terminals.some((candidate) => start && candidate.tool_name !== start.tool_name)) {
    recordProjectionDiagnostic({
      db,
      diagnosticCode: "IDENTITY_CONFLICT",
      sourceInstanceId: event.source_instance_id,
      eventId: event.event_id,
      evidenceFingerprint: semanticFingerprint(event),
      summary: "A terminal tool event has a different tool name from its canonical start.",
      observedAt
    });
  }

  const startedAt = findEventTimestamp(rows, start);
  const finishedAt = findEventTimestamp(rows, terminal);
  // Prefer the terminal event's source-reported duration_ms (spec section 9.4).
  // Fall back to the startedAt/finishedAt delta only when the terminal event
  // did not carry a valid non-negative duration_ms.
  const terminalDuration = terminal?.duration_ms;
  const timestampDuration = startedAt && finishedAt
    ? durationBetween(startedAt, finishedAt)
    : null;
  const duration = typeof terminalDuration === "number" && terminalDuration >= 0
    ? terminalDuration
    : timestampDuration;
  if (
    (typeof terminalDuration !== "number" || terminalDuration < 0) &&
    startedAt &&
    finishedAt &&
    timestampDuration === null
  ) {
    recordProjectionDiagnostic({
      db,
      diagnosticCode: "IDENTITY_CONFLICT",
      sourceInstanceId: event.source_instance_id,
      eventId: event.event_id,
      evidenceFingerprint: semanticFingerprint(event),
      summary: "Tool terminal timestamp precedes its canonical start.",
      observedAt
    });
  }

  const toolName = start?.tool_name ?? terminal?.tool_name ?? event.tool_name;
  const status = terminal?.status ?? "started";
  db.prepare(
    `INSERT INTO tool_calls (
      source_instance_id, session_id, tool_call_id, tool_name, started_at,
      finished_at, status, duration_ms, diagnostic_flags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_instance_id, session_id, tool_call_id) DO UPDATE SET
      tool_name = excluded.tool_name,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      status = excluded.status,
      duration_ms = excluded.duration_ms,
      diagnostic_flags = excluded.diagnostic_flags`
  ).run(
    event.source_instance_id,
    event.session_id,
    event.tool_call_id,
    toolName,
    startedAt,
    finishedAt,
    status,
    duration,
    null
  );
}

function healUsageModelId(
  db: SqliteDatabaseLike,
  event: Extract<NormalizedEventV2, { type: "token.usage.recorded" }>
): void {
  if (typeof event.model !== "string" || event.model.length === 0) {
    return;
  }
  db.prepare(
    "UPDATE usage_events SET model_id = ? WHERE event_id = ? AND model_id IS NULL"
  ).run(event.model, event.event_id);
}

function projectUsage(
  db: SqliteDatabaseLike,
  event: Extract<NormalizedEventV2, { type: "token.usage.recorded" }>,
  observedAt: string
): void {
  let displayedInput: number;
  try {
    displayedInput = displayedInputTokens({
      inputTokenSemantics: event.input_token_semantics,
      inputTokens: event.input_tokens,
      outputTokens: event.output_tokens,
      cacheCreationInputTokens: event.cache_creation_input_tokens,
      cacheReadInputTokens: event.cache_read_input_tokens,
      usageMeasurement: event.usage_measurement
    });
  } catch {
    recordProjectionDiagnostic({
      db,
      diagnosticCode: "INVALID_USAGE",
      sourceInstanceId: event.source_instance_id,
      eventId: event.event_id,
      evidenceFingerprint: semanticFingerprint(event),
      summary: "Usage failed canonical token accounting validation.",
      observedAt
    });
    return;
  }

  db.prepare(
    `INSERT OR IGNORE INTO usage_events (
      event_id, schema_version, source_instance_id, source_vendor, session_id,
      message_id, occurred_at, model_id, provider_id, provider_base_url,
      provider_host, input_token_semantics, usage_measurement, raw_input_tokens,
      displayed_input_tokens, output_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, server_tool_use, usage_source, service_tier,
      first_token_latency_ms, decode_duration_ms, credit, semantic_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.event_id,
    event.schema_version,
    event.source_instance_id,
    event.source_vendor,
    event.session_id,
    event.message_id,
    event.timestamp,
    event.model ?? null,
    event.provider_id,
    event.provider_base_url ?? null,
    event.provider_host ?? null,
    event.input_token_semantics,
    event.usage_measurement,
    event.input_tokens,
    displayedInput,
    event.output_tokens,
    event.cache_creation_input_tokens,
    event.cache_read_input_tokens,
    event.server_tool_use,
    event.usage_source,
    event.service_tier ?? null,
    event.first_token_latency_ms ?? null,
    event.decode_duration_ms ?? null,
    event.credit ?? null,
    semanticFingerprint(event)
  );
}

type ToolEventPayload = {
  type: "tool.called" | "tool.succeeded" | "tool.failed";
  tool_call_id: string;
  tool_name: string;
  status: "started" | "succeeded" | "failed";
  // Terminal events carry the source-reported execution duration (spec section 9.4).
  // Preferred over the startedAt/finishedAt timestamp delta when present.
  duration_ms?: number;
};

function parseToolEvent(value: string): ToolEventPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<ToolEventPayload>;
    if (
      (parsed.type === "tool.called" || parsed.type === "tool.succeeded" || parsed.type === "tool.failed") &&
      typeof parsed.tool_call_id === "string" &&
      typeof parsed.tool_name === "string" &&
      (parsed.status === "started" || parsed.status === "succeeded" || parsed.status === "failed")
    ) {
      return parsed as ToolEventPayload;
    }
  } catch {
    return null;
  }

  return null;
}

function findEventTimestamp(rows: StoredEventRow[], candidate: ToolEventPayload | undefined): string | null {
  if (!candidate) return null;
  return rows.find((row) => {
    const parsed = parseToolEvent(row.payload_json);
    return parsed?.type === candidate.type && parsed.tool_call_id === candidate.tool_call_id && parsed.status === candidate.status;
  })?.timestamp ?? null;
}

function durationBetween(startedAt: string, finishedAt: string): number | null {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
}

function isToolEvent(
  event: NormalizedEventV2
): event is Extract<NormalizedEventV2, { type: "tool.called" | "tool.succeeded" | "tool.failed" }> {
  return event.type === "tool.called" || event.type === "tool.succeeded" || event.type === "tool.failed";
}

function boundSummary(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}
