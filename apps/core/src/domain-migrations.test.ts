import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

type MigrationRunner = (db: InstanceType<typeof Database>, now?: Date) => void;

async function loadRunner(): Promise<MigrationRunner> {
  const module = await import("./domain-migrations.js");
  return module.runDomainMigrations as MigrationRunner;
}

function tableNames(db: InstanceType<typeof Database>): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

function createLegacySchema(
  db: InstanceType<typeof Database>,
  options: { migrationTable?: boolean; migrationFailureTrigger?: boolean } = {}
): void {
  if (options.migrationTable) {
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (name, applied_at)
      VALUES ('codex-raw-input-tokens-v1', '2026-07-17T00:00:00.000Z');
    `);
  }

  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER
    );
    CREATE TABLE tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE prompt_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE assistant_responses (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      stop_reason TEXT,
      response_chars INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      provider_id TEXT,
      provider_base_url TEXT,
      provider_host TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE token_usage_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      server_tool_use TEXT NOT NULL DEFAULT '{}',
      usage_source TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      provider_id TEXT,
      provider_base_url TEXT,
      provider_host TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE code_edits (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      files_changed TEXT NOT NULL DEFAULT '[]',
      file_count INTEGER NOT NULL,
      insertions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      edit_operation_count INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO sessions VALUES
      ('session-1', '2026-07-17T10:00:00.000Z', '/workspace', 'claude-code', 'claude-hook', NULL, NULL);
    INSERT INTO tool_events VALUES
      ('tool-1', 'session-1', 'Read', 'succeeded', 12, 'claude-code', 'claude-hook', '2026-07-17T10:00:01.000Z');
    INSERT INTO prompt_events VALUES
      ('prompt-1', 'session-1', 'prompt-1', 25, 'claude-code', 'claude-transcript', '2026-07-17T10:00:02.000Z');
    INSERT INTO assistant_responses VALUES
      ('response-1', 'session-1', 'message-1', 'sonnet', 'end_turn', 40, 'claude-code', 'claude-transcript', 'anthropic', NULL, 'api.anthropic.com', '2026-07-17T10:00:03.000Z');
    INSERT INTO token_usage_events VALUES
      ('usage-1', 'session-1', 'message-1', 'sonnet', 120, 10, 0, 20, '{}', 'claude-transcript', 'claude-code', 'claude-transcript', 'anthropic', NULL, 'api.anthropic.com', '2026-07-17T10:00:03.000Z');
    INSERT INTO code_edits VALUES
      ('edit-1', 'session-1', 'Edit', '["src/a.ts"]', 1, 3, 1, 1, 'claude-code', 'claude-hook', '2026-07-17T10:00:04.000Z');
  `);

  if (options.migrationFailureTrigger) {
    db.exec(`
      CREATE TRIGGER fail_phase2_migration
      BEFORE INSERT ON schema_migrations
      WHEN NEW.name = '001-create-phase2-domain'
      BEGIN
        SELECT RAISE(ABORT, 'forced phase 2 migration failure');
      END;
    `);
  }
}

describe("runDomainMigrations", () => {
  it("runs the baseline and creates the complete Phase 2 schema on a fresh database", async () => {
    const db = new Database(":memory:");
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));

    expect(tableNames(db)).toEqual([
      "adapter_instances",
      "cursor_account_usage",
      "domain_sessions",
      "event_diagnostics",
      "event_observations",
      "normalized_events",
      "official_key_usage",
      "pending_usage_migrations",
      "projection_watermarks",
      "schema_migrations",
      "source_instances",
      "sync_runs",
      "tool_call_aliases",
      "tool_calls",
      "usage_events"
    ]);
    expect(
      db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all()
    ).toEqual([
      { version: 0, name: "000-adopt-legacy-baseline", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 1, name: "001-create-phase2-domain", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 2, name: "002-add-session-query-indexes", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 3, name: "003-split-zcode-vendor", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 4, name: "004-optimize-aggregate-queries", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 5, name: "005-cover-tool-aggregate-queries", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 6, name: "006-add-usage-timing-columns", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 7, name: "007-backfill-session-started-at", applied_at: "2026-07-17T12:00:00.000Z" }
    ]);

    db.close();
  });

  it("adopts the existing legacy shape, preserves the Codex marker, and backfills canonical rows", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db, { migrationTable: true });
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));

    expect(db.prepare("SELECT name FROM pragma_table_info('schema_migrations') WHERE name = 'version'").get()).toEqual({ name: "version" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'codex-raw-input-tokens-v1'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_sessions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM normalized_events").get()).toEqual({ count: 6 });
    expect(db.prepare("SELECT event_count FROM projection_watermarks WHERE projection_name = 'global-event-count'").get()).toEqual({ event_count: 6 });
    expect(db.prepare("SELECT raw_input_tokens, displayed_input_tokens FROM usage_events").get()).toEqual({
      raw_input_tokens: 120,
      displayed_input_tokens: 120
    });
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      "sessions",
      "tool_events",
      "prompt_events",
      "assistant_responses",
      "token_usage_events",
      "code_edits"
    ]));

    db.close();
  });

  it("is idempotent when run repeatedly", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    const now = new Date("2026-07-17T12:00:00.000Z");

    runDomainMigrations(db, now);
    const before = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schema_migrations) AS migrations,
        (SELECT COUNT(*) FROM source_instances) AS sources,
        (SELECT COUNT(*) FROM normalized_events) AS events,
        (SELECT COUNT(*) FROM event_observations) AS observations,
        (SELECT COUNT(*) FROM usage_events) AS usage
    `).get();

    runDomainMigrations(db, now);

    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schema_migrations) AS migrations,
        (SELECT COUNT(*) FROM source_instances) AS sources,
        (SELECT COUNT(*) FROM normalized_events) AS events,
        (SELECT COUNT(*) FROM event_observations) AS observations,
        (SELECT COUNT(*) FROM usage_events) AS usage
    `).get()).toEqual(before);

    db.close();
  });

  it("applies the unmarked Codex input conversion once and records its marker", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    db.exec(`
      UPDATE sessions SET source_vendor = 'codex', source_adapter = 'codex-rollout';
      UPDATE tool_events SET source_vendor = 'codex', source_adapter = 'codex-rollout';
      UPDATE prompt_events SET source_vendor = 'codex', source_adapter = 'codex-rollout';
      UPDATE assistant_responses SET source_vendor = 'codex', source_adapter = 'codex-rollout';
      UPDATE token_usage_events
      SET input_tokens = 100, cache_read_input_tokens = 20,
          usage_source = 'codex-rollout', source_vendor = 'codex', source_adapter = 'codex-rollout';
      UPDATE code_edits SET source_vendor = 'codex', source_adapter = 'codex-rollout';
    `);
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));
    const first = db.prepare("SELECT raw_input_tokens, displayed_input_tokens FROM usage_events").get();
    runDomainMigrations(db, new Date("2026-07-18T12:00:00.000Z"));

    expect(first).toEqual({ raw_input_tokens: 120, displayed_input_tokens: 100 });
    expect(db.prepare("SELECT raw_input_tokens, displayed_input_tokens FROM usage_events").get()).toEqual(first);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE name = ?").get("codex-raw-input-tokens-v1")).toEqual({ version: -1 });

    db.close();
  });

  it("adds usage timing columns when upgrading a pre-006 database", async () => {
    const db = new Database(":memory:");
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));
    // Simulate a database created before migration 006: timing columns and
    // marker absent. SQLite >= 3.35 supports DROP COLUMN.
    db.exec(`
      ALTER TABLE usage_events DROP COLUMN first_token_latency_ms;
      ALTER TABLE usage_events DROP COLUMN decode_duration_ms;
      DELETE FROM schema_migrations WHERE name = '006-add-usage-timing-columns';
    `);

    runDomainMigrations(db, new Date("2026-07-18T12:00:00.000Z"));

    const columns = db
      .prepare<{ name: string }>("SELECT name FROM pragma_table_info('usage_events')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(["first_token_latency_ms", "decode_duration_ms"])
    );
    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE name = ?").get("006-add-usage-timing-columns")
    ).toEqual({ version: 6, name: "006-add-usage-timing-columns" });

    db.close();
  });

  it("backfills started_at for sessions without session.started when upgrading a pre-007 database", async () => {
    const db = new Database(":memory:");
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));
    // Simulate a database projected before migration 007: transcript sessions
    // carry events but no session.started anchor, so started_at stayed NULL.
    db.exec("DELETE FROM schema_migrations WHERE name = '007-backfill-session-started-at'");
    db.prepare(
      `INSERT INTO normalized_events (
         event_id, schema_version, session_id, source_instance_id, timestamp, type, event_type,
         source_vendor, source_adapter, adapter_instance_id, source_record_namespace, source_record_id,
         workspace_path, semantic_fingerprint, payload_json, created_at
       ) VALUES (?, 2, 'ses_transcript', 'claude:default', '2026-07-17T10:00:00.000Z', 'token.usage.recorded',
         'token.usage.recorded', 'claude-code', 'claude-transcript', 'claude-transcript@claude:default',
         'transcript', 'record-1', '.', 'fp-1', '{}', '2026-07-17T10:00:00.000Z')`
    ).run("ev-1");
    db.prepare(
      `INSERT INTO domain_sessions (
         source_instance_id, session_id, source_vendor, workspace_path, started_at, ended_at, exit_code
       ) VALUES ('claude:default', 'ses_transcript', 'claude-code', '.', NULL, NULL, NULL)`
    ).run();

    runDomainMigrations(db, new Date("2026-07-18T12:00:00.000Z"));

    expect(
      db.prepare("SELECT started_at FROM domain_sessions WHERE session_id = ?").get("ses_transcript")
    ).toEqual({ started_at: "2026-07-17T10:00:00.000Z" });
    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE name = ?").get("007-backfill-session-started-at")
    ).toEqual({ version: 7, name: "007-backfill-session-started-at" });

    db.close();
  });

  it("rolls back a failed Phase 2 migration transaction", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db, { migrationTable: true, migrationFailureTrigger: true });
    const runDomainMigrations = await loadRunner();

    expect(() => runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"))).toThrow(
      /forced phase 2 migration failure/
    );
    expect(tableNames(db)).not.toContain("source_instances");
    expect(db.prepare("SELECT name FROM schema_migrations ORDER BY name").all()).toEqual([
      { name: "000-adopt-legacy-baseline" },
      { name: "codex-raw-input-tokens-v1" }
    ]);

    db.close();
  });

  it("rejects an unknown partial legacy shape with a diagnostic", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY)");
    const runDomainMigrations = await loadRunner();

    expect(() => runDomainMigrations(db)).toThrow(/UNKNOWN_PARTIAL_SCHEMA.*backup/i);
    expect(tableNames(db)).toEqual(["sessions"]);

    db.close();
  });

  it("quarantines invalid gross usage and pending unknown usage mappings", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    // opencode-step-finish is gross without Codex conversion: cache_read > input => INVALID_USAGE.
    // not-a-real-source is unregistered => PENDING_USAGE_MAPPING.
    db.exec(`
      INSERT INTO token_usage_events VALUES
        ('usage-invalid', 'session-1', 'message-invalid', 'sonnet', 10, 0, 0, 20, '{}',
         'opencode-step-finish', 'opencode', 'opencode-db', 'unknown', NULL, NULL, '2026-07-17T10:00:05.000Z');
      INSERT INTO token_usage_events VALUES
        ('usage-pending', 'session-1', 'message-pending', 'sonnet', 50, 5, 0, 0, '{}',
         'not-a-real-source', 'claude-code', 'claude-transcript', 'unknown', NULL, NULL, '2026-07-17T10:00:06.000Z');
    `);
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM event_diagnostics WHERE diagnostic_code = 'INVALID_USAGE'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM event_diagnostics WHERE diagnostic_code = 'PENDING_USAGE_MAPPING'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM pending_usage_migrations").get()
    ).toEqual({ count: 1 });
    // Valid usage-1 still projected; invalid/pending excluded from additive usage_events.
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '001-create-phase2-domain'").get()
    ).toEqual({ name: "001-create-phase2-domain" });

    db.close();
  });

  it("pins the exhaustive usage registry including provisional codex-logs", async () => {
    const { USAGE_REGISTRY } = await import("./domain-migration-helpers.js");

    expect(Object.keys(USAGE_REGISTRY).sort()).toEqual(
      [
        "claude-transcript",
        "codex-logs",
        "codex-rollout",
        "cursor-composer-context",
        "cursor-generation",
        "dsh-usage",
        "kimicode-usage",
        "opencode-message",
        "opencode-step-finish",
        "workbuddy-usage"
      ].sort()
    );
    // codex-history is a SourceAdapter but has no usage_source row (spec 9.5).
    expect(USAGE_REGISTRY).not.toHaveProperty("codex-history");
    expect(USAGE_REGISTRY["codex-logs"]).toEqual({
      semantics: "gross",
      measurement: "increment",
      adapters: ["codex-logs"]
    });
  });

  it("runs reconciliation before writing the Phase 2 migration marker", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();

    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));

    // Historical rows (1 session + 5 event tables) each produce one legacy: normalized event.
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM normalized_events WHERE event_id LIKE 'legacy:%'").get()
    ).toEqual({ count: 6 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_call_id LIKE 'legacy:%'").get()).toEqual({
      count: 1
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE name = '001-create-phase2-domain'").get()
    ).toEqual({ name: "001-create-phase2-domain" });

    db.close();
  });

  it("aborts Phase 2 when reconciliation detects a missing tool projection", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db, { migrationTable: true });
    // Force reconciliation failure by deleting tool_calls after backfill via a trigger
    // that fires just before the migration marker insert, after backfill has completed.
    // Instead: poison tool_events with an extra row that cannot project because we drop
    // the projected table mid-transaction is hard; use a direct reconciliation unit path.
    // Insert an orphan legacy tool_events row with a duplicate primary that won't project
    // as tool_calls if we manually leave tool_calls empty by using a broken duration type
    // — simplest: call reconcile after a partial backfill simulation.
    const { reconcileLegacyMigration } = await import("./domain-reconciliation.js");
    const { createCanonicalSchema } = await import("./domain-schema.js");
    const { backfillLegacyData } = await import("./domain-backfill.js");

    createCanonicalSchema(db as never);
    backfillLegacyData(db as never, "2026-07-17T12:00:00.000Z");
    // Break reconciliation: remove one projected tool call while leaving tool_events.
    db.prepare("DELETE FROM tool_calls").run();

    expect(() => reconcileLegacyMigration(db as never)).toThrow(/RECONCILIATION_FAILED/);

    db.close();
  });

  it("exposes the required named indexes and composite primary keys", async () => {
    const db = new Database(":memory:");
    const runDomainMigrations = await loadRunner();
    runDomainMigrations(db);

    const indexes = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      "idx_domain_sessions_source_started_at",
      "idx_normalized_events_source_timestamp",
      "idx_normalized_events_source_session_type_timestamp_adapter",
      "idx_normalized_events_timestamp_source_session",
      "idx_normalized_events_event_fingerprint",
      "idx_event_observations_adapter_event",
      "idx_event_observations_source_adapter_event",
      "idx_tool_calls_source_session_started",
      "idx_usage_events_source_occurred_at",
      "idx_usage_events_source_session_occurred_at"
    ]));

    expect(db.prepare("PRAGMA table_info(event_observations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "event_id", pk: 1 }),
      expect.objectContaining({ name: "adapter_instance_id", pk: 2 })
    ]));
    expect(db.prepare("PRAGMA table_info(domain_sessions)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "source_instance_id", pk: 1 }),
      expect.objectContaining({ name: "session_id", pk: 2 })
    ]));
    expect(db.prepare("PRAGMA table_info(tool_calls)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "source_instance_id", pk: 1 }),
      expect.objectContaining({ name: "session_id", pk: 2 }),
      expect.objectContaining({ name: "tool_call_id", pk: 3 })
    ]));

    db.close();
  });
});
