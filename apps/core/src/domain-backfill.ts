import {
  CODEX_MARKER,
  LEGACY_EVENT_TABLES,
  PHASE2_NAME,
  USAGE_REGISTRY,
  adapterInstanceId,
  hasMigration,
  integerValue,
  nonNegativeInteger,
  nullableString,
  parseJsonArray,
  registerAdapter,
  registerSource,
  rowsFrom,
  sessionWorkspace,
  sha256,
  sourceInstanceIdFor,
  stableStringify,
  stringValue,
  tableExists,
  withoutProvenance
} from "./domain-migration-helpers.js";
import type { Row, SqliteDatabaseLike } from "./domain-types.js";

function insertLegacyMarker(db: SqliteDatabaseLike, appliedAt: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (-1, ?, ?)"
  ).run(CODEX_MARKER, appliedAt);
}

export function backfillLegacyData(db: SqliteDatabaseLike, appliedAt: string): void {
  if (!tableExists(db, "sessions")) {
    return;
  }

  const sessionRows = rowsFrom(db, "sessions");
  for (const row of sessionRows) {
    const sessionId = stringValue(row.session_id, "legacy-session");
    const sourceVendor = stringValue(row.source_vendor, "claude-code");
    const sourceAdapter = stringValue(row.source_adapter, "claude-hook");
    const sourceInstanceId = sourceInstanceIdFor(sourceVendor);
    const workspacePath = stringValue(row.workspace_path, ".");
    registerSource(db, sourceInstanceId, sourceVendor, appliedAt);
    registerAdapter(db, sourceInstanceId, sourceAdapter, appliedAt);
    db.prepare(`
      INSERT OR IGNORE INTO domain_sessions
        (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at, ended_at, exit_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceInstanceId,
      sessionId,
      sourceVendor,
      sourceAdapter,
      workspacePath,
      stringValue(row.started_at, appliedAt),
      nullableString(row.ended_at),
      integerValue(row.exit_code)
    );
    insertEvent(db, {
      schema_version: 2,
      event_id: `legacy:sessions:${sessionId}`,
      session_id: sessionId,
      timestamp: stringValue(row.started_at, appliedAt),
      source_vendor: sourceVendor,
      source_adapter: sourceAdapter,
      source_instance_id: sourceInstanceId,
      adapter_instance_id: adapterInstanceId(sourceInstanceId, sourceAdapter),
      source_record_namespace: "sessions",
      source_record_id: sessionId,
      workspace_path: workspacePath,
      type: "session.started"
    }, appliedAt);
  }

  for (const table of LEGACY_EVENT_TABLES) {
    if (!tableExists(db, table)) {
      continue;
    }
    for (const row of rowsFrom(db, table)) {
      backfillLegacyEvent(db, table, row, appliedAt);
    }
  }

  const hasCodexRows = rowsFrom(db, "token_usage_events").some(
    (row) => stringValue(row.source_vendor, "") === "codex"
  );
  if (hasCodexRows && !hasMigration(db, CODEX_MARKER)) {
    insertLegacyMarker(db, appliedAt);
  }
}

function backfillLegacyEvent(db: SqliteDatabaseLike, table: string, row: Row, appliedAt: string): void {
  const sourceVendor = stringValue(row.source_vendor, "claude-code");
  const sourceAdapter = stringValue(
    row.source_adapter,
    table === "token_usage_events" || table === "assistant_responses" || table === "prompt_events"
      ? "claude-transcript"
      : "claude-hook"
  );
  const sourceInstanceId = sourceInstanceIdFor(sourceVendor);
  const nativeId = stringValue(row.event_id, `${table}-legacy`);
  const sessionId = stringValue(row.session_id, "legacy-session");
  const workspacePath = sessionWorkspace(db, sourceInstanceId, sessionId);
  registerSource(db, sourceInstanceId, sourceVendor, appliedAt);
  registerAdapter(db, sourceInstanceId, sourceAdapter, appliedAt);

  const eventId = `legacy:${table}:${nativeId}`;
  const timestamp = stringValue(row.created_at, appliedAt);
  let event: Row;

  switch (table) {
    case "tool_events": {
      const status = stringValue(row.status, "failed");
      const terminalStatus = status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : "started";
      event = {
        schema_version: 2,
        event_id: eventId,
        session_id: sessionId,
        timestamp,
        source_vendor: sourceVendor,
        source_adapter: sourceAdapter,
        source_instance_id: sourceInstanceId,
        adapter_instance_id: adapterInstanceId(sourceInstanceId, sourceAdapter),
        source_record_namespace: table,
        source_record_id: nativeId,
        workspace_path: workspacePath,
        type: terminalStatus === "started" ? "tool.called" : `tool.${terminalStatus}`,
        tool_call_id: `legacy:${nativeId}`,
        tool_name: stringValue(row.tool_name, "unknown"),
        status: terminalStatus,
        duration_ms: integerValue(row.duration_ms)
      };
      insertEvent(db, event, appliedAt);
      upsertLegacyToolCall(db, event, appliedAt);
      return;
    }
    case "prompt_events":
      event = {
        schema_version: 2,
        event_id: eventId,
        session_id: sessionId,
        timestamp,
        source_vendor: sourceVendor,
        source_adapter: sourceAdapter,
        source_instance_id: sourceInstanceId,
        adapter_instance_id: adapterInstanceId(sourceInstanceId, sourceAdapter),
        source_record_namespace: table,
        source_record_id: nativeId,
        workspace_path: workspacePath,
        type: "prompt.submitted",
        prompt_id: stringValue(row.prompt_id, nativeId),
        prompt_chars: nonNegativeInteger(row.prompt_chars)
      };
      insertEvent(db, event, appliedAt);
      return;
    case "assistant_responses":
      event = {
        schema_version: 2,
        event_id: eventId,
        session_id: sessionId,
        timestamp,
        source_vendor: sourceVendor,
        source_adapter: sourceAdapter,
        source_instance_id: sourceInstanceId,
        adapter_instance_id: adapterInstanceId(sourceInstanceId, sourceAdapter),
        source_record_namespace: table,
        source_record_id: nativeId,
        workspace_path: workspacePath,
        type: "assistant.responded",
        message_id: stringValue(row.message_id, nativeId),
        model: nullableString(row.model),
        stop_reason: nullableString(row.stop_reason),
        response_chars: nonNegativeInteger(row.response_chars),
        provider_id: stringValue(row.provider_id, "unknown"),
        provider_base_url: nullableString(row.provider_base_url),
        provider_host: nullableString(row.provider_host)
      };
      insertEvent(db, event, appliedAt);
      return;
    case "token_usage_events":
      event = {
        schema_version: 2,
        event_id: eventId,
        session_id: sessionId,
        timestamp,
        source_vendor: sourceVendor,
        source_adapter: sourceAdapter,
        source_instance_id: sourceInstanceId,
        adapter_instance_id: adapterInstanceId(sourceInstanceId, sourceAdapter),
        source_record_namespace: table,
        source_record_id: nativeId,
        workspace_path: workspacePath,
        type: "token.usage.recorded",
        message_id: stringValue(row.message_id, nativeId),
        model: nullableString(row.model),
        input_tokens: nonNegativeInteger(row.input_tokens),
        output_tokens: nonNegativeInteger(row.output_tokens),
        cache_creation_input_tokens: nonNegativeInteger(row.cache_creation_input_tokens),
        cache_read_input_tokens: nonNegativeInteger(row.cache_read_input_tokens),
        server_tool_use: stringValue(row.server_tool_use, "{}"),
        usage_source: stringValue(row.usage_source, "unknown"),
        provider_id: stringValue(row.provider_id, "unknown"),
        provider_base_url: nullableString(row.provider_base_url),
        provider_host: nullableString(row.provider_host)
      };
      insertEvent(db, event, appliedAt);
      upsertLegacyUsage(db, event, appliedAt);
      return;
    case "code_edits":
      event = {
        schema_version: 2,
        event_id: eventId,
        session_id: sessionId,
        timestamp,
        source_vendor: sourceVendor,
        source_adapter: sourceAdapter,
        source_instance_id: sourceInstanceId,
        adapter_instance_id: adapterInstanceId(sourceInstanceId, sourceAdapter),
        source_record_namespace: table,
        source_record_id: nativeId,
        workspace_path: workspacePath,
        type: "code.edit.applied",
        tool_name: stringValue(row.tool_name, "unknown"),
        files_changed: parseJsonArray(row.files_changed),
        file_count: nonNegativeInteger(row.file_count),
        insertions: nonNegativeInteger(row.insertions),
        deletions: nonNegativeInteger(row.deletions),
        edit_operation_count: nonNegativeInteger(row.edit_operation_count)
      };
      insertEvent(db, event, appliedAt);
      return;
    default:
      return;
  }
}

function insertEvent(db: SqliteDatabaseLike, event: Row, observedAt: string): void {
  const sourceInstanceId = stringValue(event.source_instance_id, "unknown:default");
  const adapterId = stringValue(event.adapter_instance_id, "unknown@unknown:default");
  const eventId = stringValue(event.event_id, "legacy:event");
  const fingerprint = sha256(stableStringify(withoutProvenance(event)));
  const payload = stableStringify(event);
  const existing = db
    .prepare<{ semantic_fingerprint: string }>(
      "SELECT semantic_fingerprint FROM normalized_events WHERE event_id = ?"
    )
    .get(eventId);

  if (existing && existing.semantic_fingerprint !== fingerprint) {
    recordDiagnostic(db, {
      code: "IDENTITY_CONFLICT",
      sourceInstanceId,
      eventId,
      evidenceFingerprint: fingerprint,
      summary: "legacy event has conflicting semantic fingerprints",
      observedAt
    });
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO normalized_events
        (event_id, schema_version, session_id, source_instance_id, timestamp, type, event_type,
         source_vendor, source_adapter, adapter_instance_id, source_record_namespace, source_record_id, workspace_path,
         semantic_fingerprint, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      2,
      stringValue(event.session_id, "legacy-session"),
      sourceInstanceId,
      stringValue(event.timestamp, observedAt),
      stringValue(event.type, "ingest_error"),
      stringValue(event.type, "ingest_error"),
      stringValue(event.source_vendor, "unknown"),
      nullableString(event.source_adapter),
      nullableString(event.adapter_instance_id),
      stringValue(event.source_record_namespace, "legacy"),
      nullableString(event.source_record_id),
      stringValue(event.workspace_path, "."),
      fingerprint,
      payload,
      observedAt
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO event_observations
      (event_id, adapter_instance_id, source_adapter, semantic_fingerprint, observed_at, source_record_namespace, source_record_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    adapterId,
    stringValue(event.source_adapter, "unknown"),
    fingerprint,
    observedAt,
    stringValue(event.source_record_namespace, "legacy"),
    nullableString(event.source_record_id)
  );
}

function upsertLegacyToolCall(db: SqliteDatabaseLike, event: Row, observedAt: string): void {
  const sourceInstanceId = stringValue(event.source_instance_id, "unknown:default");
  const sessionId = stringValue(event.session_id, "legacy-session");
  const toolCallId = stringValue(event.tool_call_id, `legacy:${event.event_id}`);
  const status = stringValue(event.status, "failed");
  db.prepare(`
    INSERT OR IGNORE INTO tool_calls
      (source_instance_id, session_id, tool_call_id, tool_name, started_at, finished_at, status, duration_ms, diagnostic_flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    sourceInstanceId,
    sessionId,
    toolCallId,
    stringValue(event.tool_name, "unknown"),
    status === "started" ? stringValue(event.timestamp, observedAt) : null,
    status === "started" ? null : stringValue(event.timestamp, observedAt),
    status === "started" ? "started" : status,
    integerValue(event.duration_ms)
  );
}

function upsertLegacyUsage(db: SqliteDatabaseLike, event: Row, observedAt: string): void {
  const sourceAdapter = stringValue(event.source_adapter, "unknown");
  const usageSource = stringValue(event.usage_source, "unknown");
  const mapping = USAGE_REGISTRY[usageSource];
  const inputTokens = nonNegativeInteger(event.input_tokens);
  const cacheRead = nonNegativeInteger(event.cache_read_input_tokens);
  const sourceInstanceId = stringValue(event.source_instance_id, "unknown:default");
  const sessionId = stringValue(event.session_id, "legacy-session");
  const payload = stableStringify(event);

  if (!mapping || !mapping.adapters.includes(sourceAdapter)) {
    db.prepare(`
      INSERT OR IGNORE INTO pending_usage_migrations
        (event_id, source_instance_id, session_id, source_adapter, usage_source, raw_input_tokens,
         payload_json, first_seen_at, last_seen_at, resolution_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      stringValue(event.event_id, "legacy:usage"),
      sourceInstanceId,
      sessionId,
      sourceAdapter,
      usageSource,
      inputTokens,
      payload,
      observedAt,
      observedAt
    );
    recordDiagnostic(db, {
      code: "PENDING_USAGE_MAPPING",
      sourceInstanceId,
      eventId: stringValue(event.event_id, "legacy:usage"),
      evidenceFingerprint: sha256(payload),
      summary: `no usage registry mapping for ${sourceAdapter}/${usageSource}`,
      observedAt
    });
    return;
  }

  let storedInput = inputTokens;
  if (stringValue(event.source_vendor, "") === "codex" && !hasMigration(db, CODEX_MARKER)) {
    storedInput += cacheRead;
  }
  const displayedInput = mapping.semantics === "gross" ? storedInput - cacheRead : storedInput;
  if (displayedInput < 0) {
    recordDiagnostic(db, {
      code: "INVALID_USAGE",
      sourceInstanceId,
      eventId: stringValue(event.event_id, "legacy:usage"),
      evidenceFingerprint: sha256(payload),
      summary: "gross input tokens are smaller than cache-read tokens",
      observedAt
    });
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO usage_events
      (event_id, schema_version, source_instance_id, source_vendor, session_id, message_id, occurred_at,
       model_id, provider_id, provider_base_url, provider_host, input_token_semantics, usage_measurement,
       raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
       cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint)
    VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stringValue(event.event_id, "legacy:usage"),
    sourceInstanceId,
    stringValue(event.source_vendor, "unknown"),
    sessionId,
    stringValue(event.message_id, stringValue(event.event_id, "legacy:usage")),
    stringValue(event.timestamp, observedAt),
    nullableString(event.model),
    stringValue(event.provider_id, "unknown"),
    nullableString(event.provider_base_url),
    nullableString(event.provider_host),
    mapping.semantics,
    mapping.measurement,
    storedInput,
    displayedInput,
    nonNegativeInteger(event.output_tokens),
    nonNegativeInteger(event.cache_creation_input_tokens),
    cacheRead,
    stringValue(event.server_tool_use, "{}"),
    usageSource,
    sha256(payload)
  );
}

function recordDiagnostic(
  db: SqliteDatabaseLike,
  input: {
    code: string;
    sourceInstanceId: string;
    eventId: string;
    evidenceFingerprint: string;
    summary: string;
    observedAt: string;
  }
): void {
  db.prepare(`
    INSERT INTO event_diagnostics
      (diagnostic_code, source_instance_id, event_id, evidence_fingerprint,
       first_seen_at, last_seen_at, occurrence_count, summary, raw_locator, resolution_state, resolver_version)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, 'open', ?)
    ON CONFLICT (diagnostic_code, source_instance_id, event_id, evidence_fingerprint)
    DO UPDATE SET last_seen_at = excluded.last_seen_at, occurrence_count = event_diagnostics.occurrence_count + 1
  `).run(
    input.code,
    input.sourceInstanceId,
    input.eventId,
    input.evidenceFingerprint,
    input.observedAt,
    input.observedAt,
    input.summary,
    PHASE2_NAME
  );
}
