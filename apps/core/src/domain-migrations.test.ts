import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { semanticFingerprint, type NormalizedEventV2 } from "@agent-metrics/event-schema";
import { projectNormalizedEvents } from "./domain-projection.js";

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

function restoreUpstream009TierConstraint(db: InstanceType<typeof Database>): void {
  const sql = db.prepare<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE name = 'usage_events' AND type = 'table'"
  ).get()!.sql;
  db.exec(`
    DROP VIEW additive_usage_events;
    ALTER TABLE usage_events RENAME TO usage_events_before_constraint;
  `);
  db.exec(sql.replace("service_tier TEXT", "service_tier TEXT CHECK (service_tier IN ('standard', 'flex', 'fast', 'priority', 'ultrafast'))"));
  db.exec(`
    INSERT INTO usage_events SELECT * FROM usage_events_before_constraint;
    DROP TABLE usage_events_before_constraint;
    DELETE FROM schema_migrations WHERE name = '010-deduplicate-inherited-workbuddy-usage';
  `);
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
      { version: 7, name: "007-backfill-session-started-at", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 8, name: "008-add-usage-service-tier", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 9, name: "009-add-usage-credit", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 10, name: "010-deduplicate-inherited-workbuddy-usage", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 11, name: "011-add-usage-cache-reported", applied_at: "2026-07-17T12:00:00.000Z" },
      { version: 12, name: "012-repair-legacy-zcode-subagent-usage", applied_at: "2026-07-17T12:00:00.000Z" }
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
      DROP VIEW additive_usage_events;
      DROP INDEX idx_usage_events_workbuddy_message;
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

  it("upgrades the local 009 WorkBuddy migration alongside upstream credits without losing usage", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    const originalAppliedAt = "2026-07-17T12:00:00.000Z";
    runDomainMigrations(db, new Date(originalAppliedAt));
    db.exec(`
      DROP VIEW additive_usage_events;
      DELETE FROM schema_migrations WHERE name = '009-add-usage-credit';
      UPDATE schema_migrations SET version = 9, name = '009-deduplicate-inherited-workbuddy-usage'
        WHERE name = '010-deduplicate-inherited-workbuddy-usage';
      ALTER TABLE usage_events DROP COLUMN credit;
      CREATE VIEW additive_usage_events AS SELECT * FROM usage_events;
    `);
    const upgradeAt = new Date("2026-07-18T12:00:00.000Z");

    runDomainMigrations(db, upgradeAt);
    runDomainMigrations(db, upgradeAt);

    expect(db.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version >= 9 ORDER BY version").all())
      .toEqual([
        { version: 9, name: "009-add-usage-credit", applied_at: upgradeAt.toISOString() },
        { version: 10, name: "010-deduplicate-inherited-workbuddy-usage", applied_at: originalAppliedAt },
        { version: 11, name: "011-add-usage-cache-reported", applied_at: originalAppliedAt },
        { version: 12, name: "012-repair-legacy-zcode-subagent-usage", applied_at: originalAppliedAt }
      ]);
    expect(db.prepare("SELECT raw_input_tokens, credit FROM usage_events").get())
      .toEqual({ raw_input_tokens: 120, credit: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'additive_usage_events'").get()?.sql)
      .toContain("canonical.credit IS usage.credit");
    db.close();
  });

  it("upgrades an upstream 009 tier CHECK while preserving credit, extra columns, rowids, indexes, views and triggers", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    runDomainMigrations(db);
    restoreUpstream009TierConstraint(db);
    db.exec(`
      ALTER TABLE usage_events ADD COLUMN provider_evidence TEXT;
      UPDATE usage_events SET rowid = 123, credit = 0.42, service_tier = 'fast', provider_evidence = 'original';
      CREATE INDEX custom_usage_tier_credit ON usage_events (service_tier, credit);
      CREATE VIEW credit_usage AS SELECT event_id, credit, service_tier, provider_evidence FROM usage_events;
      CREATE VIEW credit_usage_summary AS SELECT SUM(credit) AS total_credit FROM credit_usage;
      CREATE TRIGGER preserve_usage_trigger AFTER UPDATE OF service_tier ON usage_events
      BEGIN
        UPDATE usage_events SET provider_evidence = 'tier-updated' WHERE event_id = NEW.event_id;
      END;
    `);
    const before = db.prepare<Record<string, unknown>>("SELECT rowid, * FROM usage_events").get()!;
    const objectsBefore = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'credit_usage%' OR name IN ('custom_usage_tier_credit', 'preserve_usage_trigger') ORDER BY name").all();
    expect(() => db.prepare("UPDATE usage_events SET service_tier = 'provider-burst'").run()).toThrow(/CHECK constraint failed/);

    runDomainMigrations(db);

    expect(db.prepare("SELECT rowid, * FROM usage_events").get()).toEqual(before);
    expect(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'credit_usage%' OR name IN ('custom_usage_tier_credit', 'preserve_usage_trigger') ORDER BY name").all()).toEqual(objectsBefore);
    expect(db.prepare("SELECT * FROM credit_usage_summary").get()).toEqual({ total_credit: 0.42 });
    const columns = Object.keys(before).filter((column) => column !== "rowid");
    const insert = db.prepare(`INSERT INTO usage_events (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const tier of ["default", "provider-burst"]) {
      const row: Record<string, unknown> = { ...before, event_id: `usage-${tier}`, service_tier: tier };
      insert.run(...columns.map((column) => row[column]));
    }
    db.prepare("UPDATE usage_events SET service_tier = 'normal' WHERE event_id = ?").run(before.event_id);
    expect(db.prepare("SELECT provider_evidence FROM usage_events WHERE event_id = ?").get(before.event_id))
      .toEqual({ provider_evidence: "tier-updated" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version >= 9 ORDER BY version").all()).toEqual([
      { version: 9, name: "009-add-usage-credit" },
      { version: 10, name: "010-deduplicate-inherited-workbuddy-usage" },
      { version: 11, name: "011-add-usage-cache-reported" },
      { version: 12, name: "012-repair-legacy-zcode-subagent-usage" }
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    runDomainMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 3 });
    db.close();
  });

  it("preserves writes through a view's INSTEAD OF INSERT trigger when upgrading upstream 009", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    runDomainMigrations(db);
    restoreUpstream009TierConstraint(db);
    const columns = db.prepare<{ name: string }>("PRAGMA table_info(usage_events)").all()
      .map((column) => column.name);
    const writtenColumns = new Set(["event_id", "credit", "service_tier"]);
    db.exec(`
      CREATE VIEW writable_usage AS SELECT * FROM usage_events;
      CREATE TRIGGER writable_usage_insert INSTEAD OF INSERT ON writable_usage
      BEGIN
        INSERT INTO usage_events (${columns.map((column) => `"${column}"`).join(", ")})
        SELECT ${columns.map((column) => `${writtenColumns.has(column) ? "NEW" : "seed"}."${column}"`).join(", ")}
        FROM usage_events AS seed ORDER BY seed.rowid LIMIT 1;
      END;
    `);
    const originalTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'writable_usage_insert'").get();
    db.prepare("INSERT INTO writable_usage (event_id, credit, service_tier) VALUES (?, ?, ?)")
      .run("view-before-upgrade", 0.25, "fast");
    expect(db.prepare("SELECT credit, service_tier FROM usage_events WHERE event_id = 'view-before-upgrade'").get())
      .toEqual({ credit: 0.25, service_tier: "fast" });

    runDomainMigrations(db);

    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'writable_usage_insert'").get()).toEqual(originalTrigger);
    db.prepare("INSERT INTO writable_usage (event_id, credit, service_tier) VALUES (?, ?, ?)")
      .run("view-after-upgrade", 0.75, "provider-burst");
    expect(db.prepare("SELECT credit, service_tier FROM usage_events WHERE event_id = 'view-after-upgrade'").get())
      .toEqual({ credit: 0.75, service_tier: "provider-burst" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 10").get())
      .toEqual({ version: 10, name: "010-deduplicate-inherited-workbuddy-usage" });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
  });

  it("rolls the upstream tier table replacement back when writing migration 010 fails", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    runDomainMigrations(db);
    restoreUpstream009TierConstraint(db);
    db.exec(`CREATE TRIGGER fail_010_migration BEFORE INSERT ON schema_migrations
      WHEN NEW.name = '010-deduplicate-inherited-workbuddy-usage'
      BEGIN SELECT RAISE(ABORT, 'forced 010 migration failure'); END;`);
    const before = db.prepare("SELECT * FROM usage_events").all();
    const originalSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_events'").get();

    expect(() => runDomainMigrations(db)).toThrow(/forced 010 migration failure/);

    expect(db.prepare("SELECT * FROM usage_events").all()).toEqual(before);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_events'").get()).toEqual(originalSql);
    expect(tableNames(db)).not.toContain("usage_events_tier_upgrade");
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10").get()).toEqual({ count: 0 });
    expect(() => db.prepare("UPDATE usage_events SET service_tier = 'default'").run()).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("adds service_tier when upgrading a pre-008 schema and remains idempotent", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    const now = new Date("2026-07-17T12:00:00.000Z");

    runDomainMigrations(db, now);
    db.exec(`
      DROP VIEW additive_usage_events;
      DROP INDEX idx_usage_events_workbuddy_message;
      ALTER TABLE usage_events DROP COLUMN service_tier;
      DELETE FROM schema_migrations WHERE name = '008-add-usage-service-tier';
    `);

    runDomainMigrations(db, new Date("2026-07-18T12:00:00.000Z"));

    const columns = db
      .prepare<{ name: string }>("SELECT name FROM pragma_table_info('usage_events')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("service_tier");
    expect(db.prepare("SELECT raw_input_tokens, service_tier FROM usage_events").get()).toEqual({
      raw_input_tokens: 120,
      service_tier: null
    });
    expect(
      db.prepare("SELECT version, name FROM schema_migrations WHERE name = '008-add-usage-service-tier'").get()
    ).toEqual({ version: 8, name: "008-add-usage-service-tier" });

    const afterUpgrade = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schema_migrations) AS migrations,
        (SELECT COUNT(*) FROM normalized_events) AS events,
        (SELECT COUNT(*) FROM usage_events) AS usage
    `).get();
    runDomainMigrations(db, new Date("2026-07-19T12:00:00.000Z"));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schema_migrations) AS migrations,
        (SELECT COUNT(*) FROM normalized_events) AS events,
        (SELECT COUNT(*) FROM usage_events) AS usage
    `).get()).toEqual(afterUpgrade);
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
        "codebuddy-log",
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

  it("allows only reconciled service-tier enrichment hashes and still requires diagnostics for other observations", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db);
    const runDomainMigrations = await loadRunner();
    runDomainMigrations(db, new Date("2026-07-17T12:00:00.000Z"));
    const { reconcileLegacyMigration } = await import("./domain-reconciliation.js");

    const originalEvent: NormalizedEventV2 = {
      schema_version: 2,
      event_id: "tier-reconciliation-event",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:10.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude-transcript",
      source_instance_id: "claude:default",
      adapter_instance_id: "claude-transcript@claude:default",
      source_record_namespace: "test",
      source_record_id: "tier-reconciliation-record",
      workspace_path: "/workspace",
      type: "token.usage.recorded",
      message_id: "tier-reconciliation-message",
      model: "gpt-6-luna",
      input_tokens: 100,
      input_token_semantics: "delta",
      usage_measurement: "session-context-snapshot",
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: "{}",
      usage_source: "claude-transcript",
      provider_id: "unknown"
    };
    const [originalResult] = projectNormalizedEvents(db as never, [originalEvent]);
    const enrichedEvent: NormalizedEventV2 = {
      ...originalEvent,
      source_adapter: "claude-hook",
      adapter_instance_id: "claude-hook@claude:default",
      service_tier: "fast"
    };
    const [enrichedResult] = projectNormalizedEvents(db as never, [enrichedEvent]);

    expect(enrichedResult.conflict).toBe(false);
    const observationHashes = db
      .prepare<{ semantic_fingerprint: string }>(
        "SELECT semantic_fingerprint FROM event_observations WHERE event_id = ? ORDER BY semantic_fingerprint"
      )
      .all(originalEvent.event_id)
      .map((row) => row.semantic_fingerprint);
    expect(observationHashes).toEqual(
      [originalResult.semanticFingerprint, enrichedResult.semanticFingerprint].sort()
    );
    expect(() => reconcileLegacyMigration(db as never)).not.toThrow();

    db.prepare("UPDATE normalized_events SET semantic_fingerprint = 'tampered' WHERE event_id = ?")
      .run(originalEvent.event_id);
    expect(() => reconcileLegacyMigration(db as never)).toThrow(/RECONCILIATION_FAILED/);
    db.prepare("UPDATE normalized_events SET semantic_fingerprint = ? WHERE event_id = ?")
      .run(enrichedResult.semanticFingerprint, originalEvent.event_id);

    const knownTierConflictFingerprint = semanticFingerprint({ ...enrichedEvent, service_tier: "standard" });
    db.prepare(
      `INSERT INTO event_observations
        (event_id, adapter_instance_id, source_adapter, semantic_fingerprint, observed_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      originalEvent.event_id,
      "other-adapter@claude:default",
      "claude-history",
      knownTierConflictFingerprint,
      "2026-07-17T12:00:00.000Z"
    );
    expect(() => reconcileLegacyMigration(db as never)).toThrow(/RECONCILIATION_FAILED/);

    db.prepare(
      `INSERT INTO event_diagnostics (
         diagnostic_code, source_instance_id, event_id, evidence_fingerprint,
         first_seen_at, last_seen_at, occurrence_count, summary, resolution_state
       ) VALUES ('IDENTITY_CONFLICT', ?, ?, ?, ?, ?, 1, ?, 'open')`
    ).run(
      originalEvent.source_instance_id,
      originalEvent.event_id,
      knownTierConflictFingerprint,
      "2026-07-17T12:00:00.000Z",
      "2026-07-17T12:00:00.000Z",
      "A conflicting observation has an explicit diagnostic."
    );
    expect(() => reconcileLegacyMigration(db as never)).not.toThrow();

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

  it("adds cache coverage to pre-011 databases and upgrades additive_usage_events without rewriting history", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db, { migrationTable: true });
    const runDomainMigrations = await loadRunner();
    runDomainMigrations(db);
    db.exec(`
      DROP VIEW additive_usage_events;
      ALTER TABLE usage_events DROP COLUMN cache_read_reported;
      DELETE FROM schema_migrations WHERE name = '011-add-usage-cache-reported';
      CREATE VIEW additive_usage_events AS SELECT * FROM usage_events;
    `);
    const before = db.prepare(
      "SELECT event_id, semantic_fingerprint, cache_read_input_tokens FROM usage_events ORDER BY event_id"
    ).all();
    expect(before.length).toBeGreaterThan(0);

    runDomainMigrations(db);

    expect(db.prepare(
      "SELECT event_id, semantic_fingerprint, cache_read_input_tokens, cache_read_reported FROM usage_events ORDER BY event_id"
    ).all()).toEqual(before.map((row) => ({ ...row, cache_read_reported: null })));
    expect(
      db.prepare<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'additive_usage_events'").get()?.sql
    ).toContain("canonical.cache_read_reported IS usage.cache_read_reported");
    db.close();
  });

  it("remaps pre-merge local Windows v10/v11 migrations alongside upstream v10 WorkBuddy dedup and tier relaxation", async () => {
    const db = new Database(":memory:");
    createLegacySchema(db, { migrationTable: true });
    const runDomainMigrations = await loadRunner();
    const initialAt = "2026-07-17T12:00:00.000Z";
    runDomainMigrations(db, new Date(initialAt));
    restoreUpstream009TierConstraint(db);
    db.exec(`
      DELETE FROM schema_migrations WHERE version >= 10;
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (10, '010-add-usage-cache-reported', '2026-07-17T12:00:00.000Z'),
        (11, '011-repair-legacy-zcode-subagent-usage', '2026-07-17T12:00:00.000Z');
      CREATE VIEW additive_usage_events AS SELECT * FROM usage_events;
    `);
    const upgradeAt = "2026-07-18T12:00:00.000Z";

    runDomainMigrations(db, new Date(upgradeAt));
    runDomainMigrations(db, new Date(upgradeAt));

    expect(
      db.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version >= 10 ORDER BY version").all()
    ).toEqual([
      { version: 10, name: "010-deduplicate-inherited-workbuddy-usage", applied_at: upgradeAt },
      { version: 11, name: "011-add-usage-cache-reported", applied_at: initialAt },
      { version: 12, name: "012-repair-legacy-zcode-subagent-usage", applied_at: initialAt }
    ]);
    expect(() => db.prepare("UPDATE usage_events SET service_tier = 'provider-burst'").run()).not.toThrow();
    expect(
      db.prepare<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'additive_usage_events'").get()?.sql
    ).toContain("canonical.cache_read_reported IS usage.cache_read_reported");
    db.close();
  });

  it("moves legacy zcode subagent usage out of opencode:default into zcode:default during 012", async () => {
    const db = new Database(":memory:");
    const runDomainMigrations = await loadRunner();
    const initialAt = "2026-07-17T12:00:00.000Z";
    runDomainMigrations(db, new Date(initialAt));

    const zcodePayload = {
      schema_version: 2,
      event_id: "legacy:token_usage_events:opencode:zcode:msg-sub-1",
      session_id: "sess_subagent_agent_1",
      timestamp: "2026-07-17T10:05:00.000Z",
      source_vendor: "opencode",
      source_adapter: "opencode-db",
      source_instance_id: "opencode:default",
      adapter_instance_id: "opencode-db@opencode:default",
      source_record_namespace: "zcode",
      source_record_id: "msg-sub-1",
      workspace_path: "/proj/a",
      type: "token.usage.recorded",
      message_id: "msg-sub-1",
      model: "glm-5",
      input_tokens: 100,
      input_token_semantics: "gross",
      usage_measurement: "increment",
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: "{}",
      usage_source: "opencode-message",
      provider_id: "zhipu"
    };

    db.prepare(
      `INSERT INTO source_instances (source_instance_id, source_vendor, created_at, updated_at)
       VALUES ('opencode:default', 'opencode', ?, ?)`
    ).run(initialAt, initialAt);
    db.prepare(
      `INSERT INTO adapter_instances (adapter_instance_id, source_instance_id, source_adapter, created_at, updated_at)
       VALUES ('opencode-db@opencode:default', 'opencode:default', 'opencode-db', ?, ?)`
    ).run(initialAt, initialAt);
    db.prepare(
      `INSERT INTO domain_sessions (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at)
       VALUES ('opencode:default', 'sess_subagent_agent_1', 'opencode', 'opencode-db', '/proj/a', '2026-07-17T10:05:00.000Z'),
              ('opencode:default', 'ses-regular', 'opencode', 'opencode-db', '/proj/a', '2026-07-17T10:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO normalized_events (
         event_id, schema_version, session_id, source_instance_id, timestamp, type, event_type,
         source_vendor, source_adapter, adapter_instance_id, source_record_namespace, source_record_id,
         workspace_path, semantic_fingerprint, payload_json, created_at
       ) VALUES
         (?, 2, 'sess_subagent_agent_1', 'opencode:default', '2026-07-17T10:05:00.000Z', 'token.usage.recorded', 'token.usage.recorded',
          'opencode', 'opencode-db', 'opencode-db@opencode:default', 'zcode', 'msg-sub-1', '/proj/a', 'old-fp', ?, ?),
         ('legacy:token_usage_events:opencode:opencode:msg-reg-1', 2, 'ses-regular', 'opencode:default', '2026-07-17T10:00:00.000Z', 'token.usage.recorded', 'token.usage.recorded',
          'opencode', 'opencode-db', 'opencode-db@opencode:default', 'opencode', 'msg-reg-1', '/proj/a', 'reg-fp', '{}', ?)`
    ).run(zcodePayload.event_id, JSON.stringify(zcodePayload), initialAt, initialAt);
    db.prepare(
      `INSERT INTO event_observations (event_id, adapter_instance_id, source_adapter, semantic_fingerprint, observed_at)
       VALUES (?, 'opencode-db@opencode:default', 'opencode-db', 'old-fp', ?)`
    ).run(zcodePayload.event_id, initialAt);
    db.prepare(
      `INSERT INTO usage_events (
         event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
         occurred_at, model_id, provider_id, input_token_semantics, usage_measurement,
         raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint
       ) VALUES
         (?, 2, 'opencode:default', 'opencode', 'sess_subagent_agent_1', 'msg-sub-1',
          '2026-07-17T10:05:00.000Z', 'glm-5', 'zhipu', 'gross', 'increment',
          100, 100, 20, 0, 0, '{}', 'opencode-message', 'old-fp'),
         ('legacy:token_usage_events:opencode:opencode:msg-reg-1', 2, 'opencode:default', 'opencode', 'ses-regular', 'msg-reg-1',
          '2026-07-17T10:00:00.000Z', 'qwen-3', 'alibaba', 'gross', 'increment',
          50, 50, 10, 0, 0, '{}', 'opencode-message', 'reg-fp')`
    ).run(zcodePayload.event_id);

    db.exec("DELETE FROM schema_migrations WHERE name = '012-repair-legacy-zcode-subagent-usage'");
    runDomainMigrations(db, new Date("2026-07-18T12:00:00.000Z"));

    expect(
      db.prepare("SELECT source_instance_id, source_vendor FROM usage_events WHERE event_id = ?").get(zcodePayload.event_id)
    ).toEqual({ source_instance_id: "zcode:default", source_vendor: "zcode" });
    expect(
      db.prepare("SELECT source_instance_id, source_vendor FROM usage_events WHERE event_id = ?").get(
        "legacy:token_usage_events:opencode:opencode:msg-reg-1"
      )
    ).toEqual({ source_instance_id: "opencode:default", source_vendor: "opencode" });
    expect(
      db.prepare("SELECT source_instance_id, source_adapter FROM domain_sessions WHERE session_id = 'sess_subagent_agent_1' AND source_instance_id = 'zcode:default'").get()
    ).toEqual({ source_instance_id: "zcode:default", source_adapter: "zcode-db" });
    db.close();
  });
});
