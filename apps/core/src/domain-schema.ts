import type { SqliteDatabaseLike } from "./domain-types.js";

export function createCanonicalSchema(db: SqliteDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_instances (
      source_instance_id TEXT PRIMARY KEY,
      source_vendor TEXT NOT NULL,
      root_identity TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS adapter_instances (
      adapter_instance_id TEXT PRIMARY KEY,
      source_instance_id TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      config_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_instance_id) REFERENCES source_instances(source_instance_id),
      UNIQUE (source_instance_id, source_adapter, config_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS normalized_events (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      session_id TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT,
      event_type TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT,
      adapter_instance_id TEXT,
      source_record_namespace TEXT NOT NULL,
      source_record_id TEXT,
      workspace_path TEXT NOT NULL,
      semantic_fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS event_observations (
      event_id TEXT NOT NULL,
      adapter_instance_id TEXT NOT NULL,
      source_adapter TEXT,
      observed_at TEXT NOT NULL,
      source_record_namespace TEXT,
      source_record_id TEXT,
      semantic_fingerprint TEXT NOT NULL,
      PRIMARY KEY (event_id, adapter_instance_id)
    );

    CREATE TABLE IF NOT EXISTS event_diagnostics (
      diagnostic_code TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
      summary TEXT NOT NULL,
      raw_locator TEXT,
      resolution_state TEXT NOT NULL DEFAULT 'open',
      resolver_version TEXT,
      PRIMARY KEY (diagnostic_code, source_instance_id, event_id, evidence_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS domain_sessions (
      source_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT,
      workspace_path TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      PRIMARY KEY (source_instance_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      source_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
      duration_ms INTEGER,
      diagnostic_flags TEXT,
      PRIMARY KEY (source_instance_id, session_id, tool_call_id)
    );

    CREATE TABLE IF NOT EXISTS tool_call_aliases (
      source_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      observed_tool_call_id TEXT NOT NULL,
      canonical_tool_call_id TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      evidence_event_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_instance_id, session_id, observed_tool_call_id, canonical_tool_call_id)
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      source_instance_id TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      model_id TEXT,
      provider_id TEXT NOT NULL,
      provider_base_url TEXT,
      provider_host TEXT,
      input_token_semantics TEXT NOT NULL CHECK (input_token_semantics IN ('delta', 'gross')),
      usage_measurement TEXT NOT NULL CHECK (usage_measurement IN ('increment', 'session-context-snapshot')),
      raw_input_tokens INTEGER NOT NULL CHECK (raw_input_tokens >= 0),
      displayed_input_tokens INTEGER NOT NULL CHECK (displayed_input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cache_creation_input_tokens INTEGER NOT NULL CHECK (cache_creation_input_tokens >= 0),
      cache_read_input_tokens INTEGER NOT NULL CHECK (cache_read_input_tokens >= 0),
      server_tool_use TEXT NOT NULL,
      usage_source TEXT NOT NULL,
      first_token_latency_ms INTEGER,
      decode_duration_ms INTEGER,
      semantic_fingerprint TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_usage_migrations (
      event_id TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      usage_source TEXT NOT NULL,
      raw_input_tokens INTEGER NOT NULL CHECK (raw_input_tokens >= 0),
      payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolution_state TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (event_id, source_adapter, usage_source)
    );

    CREATE TABLE IF NOT EXISTS projection_watermarks (
      projection_name TEXT PRIMARY KEY,
      source_instance_id TEXT,
      last_event_id TEXT,
      last_timestamp TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_domain_sessions_source_started_at
      ON domain_sessions (source_instance_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_normalized_events_source_timestamp
      ON normalized_events (source_instance_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_normalized_events_event_fingerprint
      ON normalized_events (event_id, semantic_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_event_observations_adapter_event
      ON event_observations (adapter_instance_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_event_observations_source_adapter_event
      ON event_observations (source_adapter, event_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_source_session_started
      ON tool_calls (source_instance_id, session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_source_occurred_at
      ON usage_events (source_instance_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_source_session_occurred_at
      ON usage_events (source_instance_id, session_id, occurred_at);
    -- Widget snapshot reads tool_calls across all sources by started_at only; the
    -- (source_instance_id, session_id, started_at) index cannot serve that predicate
    -- without its leading columns, so a single-column covering index backs the
    -- high-frequency aggregate (spec section 10.5 "at minimum" allows additional indexes).
    CREATE INDEX IF NOT EXISTS idx_tool_calls_started_at
      ON tool_calls (started_at);

    CREATE TABLE IF NOT EXISTS cursor_account_usage (
      source_instance_id TEXT PRIMARY KEY,
      email TEXT,
      plan_name TEXT,
      plan_tier TEXT,
      subscription_status TEXT,
      hostname TEXT,
      machine_id TEXT,
      billing_cycle_start TEXT NOT NULL,
      billing_cycle_end TEXT NOT NULL,
      total_spend_cents INTEGER NOT NULL CHECK (total_spend_cents >= 0),
      included_spend_cents INTEGER NOT NULL CHECK (included_spend_cents >= 0),
      bonus_spend_cents INTEGER NOT NULL CHECK (bonus_spend_cents >= 0),
      limit_cents INTEGER NOT NULL CHECK (limit_cents >= 0),
      remaining_cents INTEGER CHECK (remaining_cents IS NULL OR remaining_cents >= 0),
      auto_percent_used REAL NOT NULL,
      api_percent_used REAL NOT NULL,
      total_percent_used REAL NOT NULL,
      display_message TEXT,
      synced_at TEXT NOT NULL,
      model_aggregations_json TEXT NOT NULL DEFAULT '[]',
      model_usage_total_cost_cents REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS official_key_usage (
      vendor TEXT NOT NULL,
      limit_key TEXT NOT NULL,
      window_key TEXT NOT NULL,
      source TEXT NOT NULL,
      limit_id TEXT,
      limit_name TEXT,
      primary_used_percent REAL,
      primary_window_minutes INTEGER,
      primary_resets_at TEXT,
      secondary_used_percent REAL,
      secondary_window_minutes INTEGER,
      secondary_resets_at TEXT,
      credits_has_credits INTEGER,
      credits_unlimited INTEGER,
      observed_at TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      PRIMARY KEY (vendor, limit_key, window_key)
    );
  `);
  createSyncRunSchema(db);
}

export function createSessionQueryIndexes(db: SqliteDatabaseLike): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_normalized_events_source_session_type_timestamp_adapter
      ON normalized_events (source_instance_id, session_id, event_type, timestamp, source_adapter);
    CREATE INDEX IF NOT EXISTS idx_normalized_events_timestamp_source_session
      ON normalized_events (timestamp, source_instance_id, session_id);
  `);
}

export function createAggregateQueryIndexes(db: SqliteDatabaseLike): void {
  // Time comes first because All sources has no source predicate. Preserve the
  // source-first indexes for queries restricted to a single vendor.
  for (const table of ["sessions", "tool_events", "prompt_events", "assistant_responses", "token_usage_events", "code_edits"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    const time = table === "sessions" ? "started_at" : "created_at";
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${time} ON ${table} (${time}, source_vendor)`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_events_occurred_at ON usage_events (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_normalized_events_type_timestamp
      ON normalized_events (event_type, timestamp);
  `);
  ensureToolAggregateQueryIndex(db);
}

export function ensureToolAggregateQueryIndex(db: SqliteDatabaseLike): void {
  const columns = new Set(db.prepare<{ name: string | null }>(
    "PRAGMA index_info('idx_tool_calls_activity_at')"
  ).all().map((row) => row.name));
  if (["source_instance_id", "session_id", "status", "tool_name", "duration_ms"].every((column) => columns.has(column))) {
    return;
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_tool_calls_activity_at;
    CREATE INDEX idx_tool_calls_activity_at
      ON tool_calls (COALESCE(started_at, finished_at), source_instance_id, session_id, status, tool_name, duration_ms);
  `);
}

export function createSyncRunSchema(db: SqliteDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      run_id TEXT PRIMARY KEY,
      adapter_instance_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'syncing', 'succeeded', 'failed', 'aborted')),
      accepted_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      discovered_records INTEGER NOT NULL DEFAULT 0 CHECK (discovered_records >= 0),
      committed_unique_events INTEGER NOT NULL DEFAULT 0 CHECK (committed_unique_events >= 0),
      projected_unique_events INTEGER NOT NULL DEFAULT 0 CHECK (projected_unique_events >= 0),
      projection_watermark INTEGER CHECK (projection_watermark IS NULL OR projection_watermark >= 0),
      error_code TEXT,
      error_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_completed_at ON sync_runs (completed_at);
  `);
}
