
import {
  CODEX_MARKER,
  PHASE2_NAME,
  columnNames,
  hasMigration,
  resolveNow,
  tableExists,
  tableNames,
  throwUnknownShape
} from "./domain-migration-helpers.js";
import { backfillLegacyData } from "./domain-backfill.js";
import { reconcileLegacyMigration } from "./domain-reconciliation.js";
import {
  createCanonicalSchema,
  createAggregateQueryIndexes,
  ensureToolAggregateQueryIndex,
  createSessionQueryIndexes,
  createSyncRunSchema
} from "./domain-schema.js";
import {
  DomainMigrationError,
  type MigrationNow,
  type SqliteDatabaseLike
} from "./domain-types.js";

export { DomainMigrationError } from "./domain-types.js";
export type { SqliteDatabaseLike, SqliteStatementLike } from "./domain-types.js";

const BASELINE_VERSION = 0;
const BASELINE_NAME = "000-adopt-legacy-baseline";
const PHASE2_VERSION = 1;
const SESSION_QUERY_INDEX_VERSION = 2;
const SESSION_QUERY_INDEX_NAME = "002-add-session-query-indexes";
const ZCODE_VENDOR_SPLIT_VERSION = 3;
const ZCODE_VENDOR_SPLIT_NAME = "003-split-zcode-vendor";
const AGGREGATE_QUERY_VERSION = 4;
const AGGREGATE_QUERY_NAME = "004-optimize-aggregate-queries";
const TOOL_AGGREGATE_INDEX_VERSION = 5;
const TOOL_AGGREGATE_INDEX_NAME = "005-cover-tool-aggregate-queries";
const USAGE_TIMING_VERSION = 6;
const USAGE_TIMING_NAME = "006-add-usage-timing-columns";
const SESSION_START_BACKFILL_VERSION = 7;
const SESSION_START_BACKFILL_NAME = "007-backfill-session-started-at";
const USAGE_SERVICE_TIER_VERSION = 8;
const USAGE_SERVICE_TIER_NAME = "008-add-usage-service-tier";
const LATEST_VERSION = USAGE_SERVICE_TIER_VERSION;

const LEGACY_TABLES = [
  "sessions",
  "tool_events",
  "prompt_events",
  "assistant_responses",
  "token_usage_events",
  "code_edits"
] as const;

const OPTIONAL_LEGACY_TABLES = ["ingestion_state", "session_contexts"] as const;

const CANONICAL_TABLES = [
  "source_instances",
  "adapter_instances",
  "normalized_events",
  "event_observations",
  "event_diagnostics",
  "domain_sessions",
  "tool_calls",
  "tool_call_aliases",
  "usage_events",
  "pending_usage_migrations",
  "projection_watermarks",
  "sync_runs"
] as const;

const OPTIONAL_CANONICAL_TABLES = ["cursor_account_usage", "official_key_usage"] as const;


export function runDomainMigrations(db: SqliteDatabaseLike, now: MigrationNow = new Date()): void {
  const appliedAt = resolveNow(now);
  runBaselineMigration(db, appliedAt);

  if (!hasMigration(db, PHASE2_NAME)) {
    db.transaction(() => {
      createCanonicalSchema(db);
      backfillLegacyData(db, appliedAt);
      // Spec section 10.1 step 7: reconcile before writing the migration marker.
      reconcileLegacyMigration(db);
      insertMigration(db, PHASE2_VERSION, PHASE2_NAME, appliedAt);
    })();
  } else {
    createSyncRunSchema(db);
    createCanonicalSchema(db);
  }

  runSessionQueryIndexMigration(db, appliedAt);
  runZcodeVendorSplitMigration(db, appliedAt);
  if (!hasMigration(db, AGGREGATE_QUERY_NAME)) {
    db.transaction(() => {
      createAggregateQueryIndexes(db);
      db.exec("ALTER TABLE projection_watermarks ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0");
      db.prepare(`INSERT INTO projection_watermarks (projection_name, event_count, updated_at)
        SELECT 'global-event-count', COUNT(*), ? FROM normalized_events`).run(appliedAt);
      db.exec(`
        CREATE TRIGGER normalized_events_count_insert AFTER INSERT ON normalized_events BEGIN
          UPDATE projection_watermarks SET event_count = event_count + 1
          WHERE projection_name = 'global-event-count';
        END;
        CREATE TRIGGER normalized_events_count_delete AFTER DELETE ON normalized_events BEGIN
          UPDATE projection_watermarks SET event_count = event_count - 1
          WHERE projection_name = 'global-event-count';
        END;
      `);
      insertMigration(db, AGGREGATE_QUERY_VERSION, AGGREGATE_QUERY_NAME, appliedAt);
    })();
  }
  if (!hasMigration(db, TOOL_AGGREGATE_INDEX_NAME)) {
    db.transaction(() => {
      ensureToolAggregateQueryIndex(db);
      insertMigration(db, TOOL_AGGREGATE_INDEX_VERSION, TOOL_AGGREGATE_INDEX_NAME, appliedAt);
    })();
  }
  if (!hasMigration(db, USAGE_TIMING_NAME)) {
    db.transaction(() => {
      // Fresh databases already get both columns from createCanonicalSchema;
      // only ALTER when upgrading an existing usage_events table.
      const columns = columnNames(db, "usage_events");
      if (!columns.has("first_token_latency_ms")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN first_token_latency_ms INTEGER");
      }
      if (!columns.has("decode_duration_ms")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN decode_duration_ms INTEGER");
      }
      insertMigration(db, USAGE_TIMING_VERSION, USAGE_TIMING_NAME, appliedAt);
    })();
  }
  if (!hasMigration(db, SESSION_START_BACKFILL_NAME)) {
    db.transaction(() => {
      // Sessions observed before 007 only kept started_at when a session.started
      // event existed; sources without that event (Claude transcripts) left it
      // NULL and dropped out of windowed counts. Seed from the earliest observed
      // event instead — mirrors the projection fallback added alongside.
      db.prepare(
        `UPDATE domain_sessions SET started_at = (
           SELECT MIN(events.timestamp) FROM normalized_events events
           WHERE events.source_instance_id = domain_sessions.source_instance_id
             AND events.session_id = domain_sessions.session_id
         )
         WHERE started_at IS NULL
           AND EXISTS (
             SELECT 1 FROM normalized_events events
             WHERE events.source_instance_id = domain_sessions.source_instance_id
               AND events.session_id = domain_sessions.session_id
           )`
      ).run();
      insertMigration(db, SESSION_START_BACKFILL_VERSION, SESSION_START_BACKFILL_NAME, appliedAt);
    })();
  }
  if (!hasMigration(db, USAGE_SERVICE_TIER_NAME)) {
    db.transaction(() => {
      // Fresh databases already carry the column from createCanonicalSchema; only
      // upgrade existing tables. Historical rows stay NULL (standard pricing)
      // because the tier was never captured at ingest time.
      const columns = columnNames(db, "usage_events");
      if (!columns.has("service_tier")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN service_tier TEXT");
      }
      insertMigration(db, USAGE_SERVICE_TIER_VERSION, USAGE_SERVICE_TIER_NAME, appliedAt);
    })();
  }
}

function runSessionQueryIndexMigration(db: SqliteDatabaseLike, appliedAt: string): void {
  if (hasMigration(db, SESSION_QUERY_INDEX_NAME)) {
    return;
  }

  db.transaction(() => {
    createSessionQueryIndexes(db);
    insertMigration(db, SESSION_QUERY_INDEX_VERSION, SESSION_QUERY_INDEX_NAME, appliedAt);
  })();
}

function runZcodeVendorSplitMigration(db: SqliteDatabaseLike, appliedAt: string): void {
  if (hasMigration(db, ZCODE_VENDOR_SPLIT_NAME)) {
    return;
  }

  db.transaction(() => {
    if (tableExists(db, "source_instances")) {
      db.prepare(
        "UPDATE source_instances SET source_vendor = 'zcode', updated_at = ? WHERE source_instance_id = 'zcode:default' AND source_vendor = 'opencode'"
      ).run(appliedAt);
    }
    if (tableExists(db, "domain_sessions")) {
      db.exec(
        "UPDATE domain_sessions SET source_vendor = 'zcode' WHERE source_adapter = 'zcode-db' AND source_vendor = 'opencode'"
      );
    }
    if (tableExists(db, "normalized_events")) {
      db.exec(
        "UPDATE normalized_events SET source_vendor = 'zcode' WHERE source_adapter = 'zcode-db' AND source_vendor = 'opencode'"
      );
    }
    if (tableExists(db, "usage_events")) {
      db.exec(
        "UPDATE usage_events SET source_vendor = 'zcode' WHERE source_instance_id = 'zcode:default' AND source_vendor = 'opencode'"
      );
    }
    for (const tableName of LEGACY_TABLES) {
      if (tableExists(db, tableName)) {
        db.exec(
          `UPDATE ${tableName} SET source_vendor = 'zcode' WHERE source_adapter = 'zcode-db' AND source_vendor = 'opencode'`
        );
      }
    }
    if (tableExists(db, "session_contexts")) {
      db.exec(
        "UPDATE session_contexts SET source_vendor = 'zcode' WHERE source_adapter = 'zcode-db' AND source_vendor = 'opencode'"
      );
    }
    insertMigration(db, ZCODE_VENDOR_SPLIT_VERSION, ZCODE_VENDOR_SPLIT_NAME, appliedAt);
  })();
}

function runBaselineMigration(db: SqliteDatabaseLike, appliedAt: string): void {
  db.transaction(() => {
    ensureSchemaMigrations(db);
    validateMigrationVersions(db);
    validateDatabaseShape(db);

    if (!hasMigration(db, BASELINE_NAME)) {
      insertMigration(db, BASELINE_VERSION, BASELINE_NAME, appliedAt);
    }
  })();
}

function ensureSchemaMigrations(db: SqliteDatabaseLike): void {
  if (!tableExists(db, "schema_migrations")) {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL UNIQUE,
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    return;
  }

  const columns = columnNames(db, "schema_migrations");
  if (!columns.has("name") || !columns.has("applied_at")) {
    throwUnknownShape(db, "schema_migrations must contain name and applied_at");
  }

  if (!columns.has("version")) {
    db.exec("ALTER TABLE schema_migrations ADD COLUMN version INTEGER");
  }

  const finalColumns = columnNames(db, "schema_migrations");
  if (!finalColumns.has("version")) {
    throwUnknownShape(db, "schema_migrations version column could not be added");
  }
}

function validateMigrationVersions(db: SqliteDatabaseLike): void {
  const rows = db
    .prepare<{ version: number | null; name: string }>(
      "SELECT version, name FROM schema_migrations WHERE version IS NOT NULL"
    )
    .all();

  for (const row of rows) {
    if (row.version !== null && row.version > LATEST_VERSION) {
      throw new DomainMigrationError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `database contains migration version ${row.version}; back up the database and use a compatible release`,
        { version: row.version, name: row.name }
      );
    }
  }
}

function validateDatabaseShape(db: SqliteDatabaseLike): void {
  const tables = new Set(tableNames(db));
  const legacyPresent = LEGACY_TABLES.filter((table) => tables.has(table));
  const canonicalPresent = CANONICAL_TABLES.filter((table) => tables.has(table));
  const migrationRows = db
    .prepare<{ name: string }>("SELECT name FROM schema_migrations")
    .all();
  const migrationNames = new Set(migrationRows.map((row) => row.name));

  if (legacyPresent.length > 0 && legacyPresent.length !== LEGACY_TABLES.length) {
    throwUnknownShape(db, `legacy tables are incomplete: ${legacyPresent.join(", ")}`);
  }

  const allowed = new Set<string>([
    "schema_migrations",
    ...LEGACY_TABLES,
    ...OPTIONAL_LEGACY_TABLES,
    ...CANONICAL_TABLES,
    ...OPTIONAL_CANONICAL_TABLES
  ]);
  const unexpected = [...tables].filter((table) => !allowed.has(table));
  if (unexpected.length > 0) {
    throwUnknownShape(db, `unexpected tables are present: ${unexpected.join(", ")}`);
  }

  if (canonicalPresent.length > 0 && canonicalPresent.length !== CANONICAL_TABLES.length) {
    throwUnknownShape(db, `canonical tables are incomplete: ${canonicalPresent.join(", ")}`);
  }

  if (canonicalPresent.length > 0) {
    for (const [table, required] of Object.entries(CANONICAL_COLUMNS)) {
      if (!tables.has(table)) {
        continue;
      }
      const actual = columnNames(db, table);
      const missing = required.filter((column) => !actual.has(column));
      if (missing.length > 0) {
        throwUnknownShape(db, `${table} is missing columns: ${missing.join(", ")}`);
      }
    }
  }

  if (canonicalPresent.length > 0 && !migrationNames.has(PHASE2_NAME)) {
    throwUnknownShape(db, "canonical tables exist without the Phase 2 migration marker");
  }
}

const CANONICAL_COLUMNS: Record<string, string[]> = {
  source_instances: ["source_instance_id", "source_vendor", "created_at", "updated_at"],
  adapter_instances: ["adapter_instance_id", "source_instance_id", "source_adapter", "created_at", "updated_at"],
  normalized_events: ["event_id", "schema_version", "session_id", "source_instance_id", "timestamp", "type", "source_adapter", "adapter_instance_id", "semantic_fingerprint"],
  event_observations: ["event_id", "adapter_instance_id", "source_adapter", "semantic_fingerprint", "observed_at"],
  event_diagnostics: ["diagnostic_code", "source_instance_id", "event_id", "evidence_fingerprint"],
  domain_sessions: ["source_instance_id", "session_id", "started_at"],
  tool_calls: ["source_instance_id", "session_id", "tool_call_id", "status"],
  tool_call_aliases: ["source_instance_id", "session_id", "observed_tool_call_id", "canonical_tool_call_id"],
  usage_events: ["event_id", "schema_version", "source_instance_id", "session_id", "input_token_semantics", "usage_measurement", "displayed_input_tokens", "usage_source"],
  pending_usage_migrations: ["event_id", "source_instance_id", "source_adapter", "usage_source"],
  projection_watermarks: ["projection_name", "updated_at"],
  sync_runs: ["run_id", "adapter_instance_id", "status", "accepted_at"],
  cursor_account_usage: [
    "source_instance_id",
    "billing_cycle_start",
    "billing_cycle_end",
    "total_spend_cents",
    "synced_at"
  ]
};




function insertMigration(db: SqliteDatabaseLike, version: number, name: string, appliedAt: string): void {
  db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
    version,
    name,
    appliedAt
  );
}
