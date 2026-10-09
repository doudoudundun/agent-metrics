import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeLegacySchema } from "./legacy-schema.js";
import { runDomainMigrations } from "./domain-migrations.js";

type PlanRow = { id: number; parent: number; detail: string };

function explainDetails(db: InstanceType<typeof Database>, sql: string, ...params: unknown[]): string[] {
  return db
    .prepare<PlanRow>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

function planUsesNamedIndex(details: string[], indexName: string): boolean {
  return details.some((detail) => detail.includes(indexName));
}

function seedDomainTables(db: InstanceType<typeof Database>): void {
  const sourceInstanceId = "claude:default";
  const sessionId = "session-1";
  const startedAt = "2026-07-17T10:00:00.000Z";
  // Spread events across many distinct timestamps so SQLite's ANALYZE statistics
  // see real cardinality. A single repeated timestamp makes the optimizer prefer
  // a full SCAN over an index seek, which would defeat the query-plan assertion.
  const baseMs = Date.parse("2026-07-17T00:00:00.000Z");

  db.prepare(
    `INSERT INTO domain_sessions (
      source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at
    ) VALUES (?, ?, 'claude-code', 'claude-hook', '/workspace', ?)`
  ).run(sourceInstanceId, sessionId, startedAt);

  for (let index = 0; index < 200; index += 1) {
    const eventId = `event-${index}`;
    const timestamp = new Date(baseMs + index * 60_000).toISOString();
    db.prepare(
      `INSERT INTO normalized_events (
        event_id, schema_version, session_id, source_instance_id, timestamp, event_type,
        source_vendor, source_record_namespace, workspace_path, semantic_fingerprint, payload_json
      ) VALUES (?, 2, ?, ?, ?, 'tool.called', 'claude-code', 'claude', '/workspace', ?, '{}')`
    ).run(eventId, sessionId, sourceInstanceId, timestamp, `fp-${index}`);
    db.prepare(
      `INSERT INTO usage_events (
        event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
        occurred_at, provider_id, input_token_semantics, usage_measurement,
        raw_input_tokens, displayed_input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, usage_source,
        semantic_fingerprint
      ) VALUES (?, 2, ?, 'claude-code', ?, ?, ?, 'anthropic', 'delta', 'increment', 1, 1, 1, 0, 0, '{}', 'claude-transcript', ?)`
    ).run(eventId, sourceInstanceId, sessionId, `msg-${index}`, timestamp, `usage-${index}`);
    db.prepare(
      `INSERT INTO tool_calls (
        source_instance_id, session_id, tool_call_id, tool_name, started_at, status
      ) VALUES (?, ?, ?, 'Read', ?, 'succeeded')`
    ).run(sourceInstanceId, sessionId, `tool-${index}`, timestamp);
  }

  db.exec("ANALYZE;");
}

function seedLegacyTables(db: InstanceType<typeof Database>): void {
  const baseMs = Date.parse("2026-07-17T00:00:00.000Z");
  for (let index = 0; index < 200; index += 1) {
    const sessionId = `legacy-session-${index}`;
    const createdAt = new Date(baseMs + index * 60_000).toISOString();
    db.prepare(
      `INSERT INTO sessions (
        session_id, started_at, workspace_path, source_vendor, source_adapter
      ) VALUES (?, ?, '/workspace', 'claude-code', 'claude-hook')`
    ).run(sessionId, createdAt);
    db.prepare(
      `INSERT INTO tool_events (
        event_id, session_id, tool_name, status, duration_ms, source_vendor, source_adapter, created_at
      ) VALUES (?, ?, 'Read', 'succeeded', 10, 'claude-code', 'claude-hook', ?)`
    ).run(`tool-${index}`, sessionId, createdAt);
    db.prepare(
      `INSERT INTO token_usage_events (
        event_id, session_id, message_id, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, usage_source,
        source_vendor, source_adapter, created_at
      ) VALUES (?, ?, ?, 'sonnet', 1, 1, 0, 0, '{}', 'claude-transcript', 'claude-code', 'claude-transcript', ?)`
    ).run(`usage-${index}`, sessionId, `msg-${index}`, createdAt);
  }

  db.exec("ANALYZE;");
}

describe("domain query plans", () => {
  it("upgrades an already-applied v4 activity index without changing event counts", () => {
    const db = new Database(":memory:");
    runDomainMigrations(db);
    seedDomainTables(db);
    db.exec(`
      DELETE FROM schema_migrations WHERE version = 5;
      DROP INDEX idx_tool_calls_activity_at;
      CREATE INDEX idx_tool_calls_activity_at ON tool_calls (COALESCE(started_at, finished_at));
    `);
    runDomainMigrations(db);
    expect(db.prepare<{ name: string }>("PRAGMA index_info('idx_tool_calls_activity_at')").all().map((row) => row.name)).toEqual(
      expect.arrayContaining(["source_instance_id", "session_id", "status", "tool_name", "duration_ms"])
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_calls").get()).toEqual({ count: 200 });
    expect(db.prepare("SELECT event_count FROM projection_watermarks WHERE projection_name = 'global-event-count'").get()).toEqual({ event_count: 200 });
    db.close();
  });

  it("uses time indexes for all-source dashboard and widget windows", () => {
    const db = new Database(":memory:");
    initializeLegacySchema(db);
    runDomainMigrations(db);
    seedDomainTables(db);
    seedLegacyTables(db);
    const start = "2026-07-17T00:30:00.000Z";
    const end = "2026-07-17T00:35:00.000Z";
    for (const [sql, indexName] of [
      ["SELECT model, input_tokens FROM token_usage_events WHERE created_at >= ? AND created_at <= ?", "idx_token_usage_events_created_at"],
      ["SELECT displayed_input_tokens FROM usage_events WHERE occurred_at >= ? AND occurred_at < ? AND usage_measurement = 'increment'", "idx_usage_events_occurred_at"],
      ["SELECT tool_name FROM tool_calls WHERE COALESCE(started_at, finished_at) >= ? AND COALESCE(started_at, finished_at) <= ?", "idx_tool_calls_activity_at"],
      ["SELECT payload_json FROM normalized_events WHERE event_type = 'code.edit.recorded' AND timestamp >= ? AND timestamp < ?", "idx_normalized_events_type_timestamp"]
    ]) {
      expect(planUsesNamedIndex(explainDetails(db, sql, start, end), indexName)).toBe(true);
    }
    db.close();
  });

  it("uses named domain indexes for bounded session and timeline queries", () => {
    const db = new Database(":memory:");
    runDomainMigrations(db);
    seedDomainTables(db);

    // Bounded windows cover a small slice of the seeded rows so the optimizer's
    // ANALYZE statistics favor an index seek over a full SCAN. A window that
    // covers every row makes SCAN cheaper and is not representative of the
    // bounded reads the production queries perform.
    const windowStart = "2026-07-17T00:30:00.000Z";
    const windowEnd = "2026-07-17T00:35:00.000Z";

    const sessionWindow = explainDetails(
      db,
      `SELECT COUNT(*) AS count
       FROM domain_sessions
       WHERE source_instance_id = ? AND started_at >= ? AND started_at < ?`,
      "claude:default",
      windowStart,
      windowEnd
    );
    expect(planUsesNamedIndex(sessionWindow, "idx_domain_sessions_source_started_at")).toBe(true);

    const timeline = explainDetails(
      db,
      `SELECT event_id, timestamp
       FROM normalized_events
       WHERE source_instance_id = ? AND session_id = ?
       ORDER BY timestamp ASC, event_id ASC
       LIMIT ?`,
      "claude:default",
      "session-1",
      50
    );
    expect(planUsesNamedIndex(timeline, "idx_normalized_events_source_timestamp")).toBe(true);

    const usageWindow = explainDetails(
      db,
      `SELECT displayed_input_tokens
       FROM usage_events
       WHERE source_instance_id = ? AND occurred_at >= ? AND occurred_at < ?
         AND usage_measurement = 'increment'`,
      "claude:default",
      windowStart,
      windowEnd
    );
    expect(planUsesNamedIndex(usageWindow, "idx_usage_events_source_occurred_at")).toBe(true);

    const toolWindow = explainDetails(
      db,
      `SELECT status
       FROM tool_calls
       WHERE source_instance_id = ? AND session_id = ?
         AND started_at >= ?
         AND started_at < ?`,
      "claude:default",
      "session-1",
      windowStart,
      windowEnd
    );
    expect(planUsesNamedIndex(toolWindow, "idx_tool_calls_source_session_started")).toBe(true);

    // Spec section 10.5 requires the (event_id, semantic_fingerprint) index for
    // semantic-fingerprint lookups (conflict detection). event_id alone is served by
    // the PRIMARY KEY autoindex, so the assertion exercises the fingerprint column.
    const fingerprintLookup = explainDetails(
      db,
      "SELECT event_id FROM normalized_events WHERE semantic_fingerprint = ?",
      "fp-1"
    );
    expect(planUsesNamedIndex(fingerprintLookup, "idx_normalized_events_event_fingerprint")).toBe(true);

    db.close();
  });

  it("uses legacy aggregate indexes for overview-style scans", () => {
    const db = new Database(":memory:");
    initializeLegacySchema(db);
    seedLegacyTables(db);

    const windowStart = "2026-07-17T00:30:00.000Z";
    const windowEnd = "2026-07-17T00:35:00.000Z";

    const sessions = explainDetails(
      db,
      "SELECT session_id FROM sessions WHERE source_vendor = ? AND started_at >= ? AND started_at <= ?",
      "claude-code",
      windowStart,
      windowEnd
    );
    expect(planUsesNamedIndex(sessions, "idx_sessions_source_started_at")).toBe(true);

    const tokenUsage = explainDetails(
      db,
      `SELECT model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
              source_vendor, usage_source
       FROM token_usage_events
       WHERE source_vendor = ? AND created_at >= ? AND created_at <= ?`,
      "claude-code",
      windowStart,
      windowEnd
    );
    expect(planUsesNamedIndex(tokenUsage, "idx_token_usage_events_source_created_at")).toBe(true);

    const toolEvents = explainDetails(
      db,
      "SELECT tool_name, status FROM tool_events WHERE source_vendor = ? AND created_at >= ? AND created_at <= ?",
      "claude-code",
      windowStart,
      windowEnd
    );
    expect(planUsesNamedIndex(toolEvents, "idx_tool_events_source_created_at")).toBe(true);

    db.close();
  });
});
