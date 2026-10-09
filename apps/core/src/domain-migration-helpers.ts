import { createHash } from "node:crypto";
import { DomainMigrationError, type Row, type MigrationNow, type SqliteDatabaseLike } from "./domain-types.js";

export const PHASE2_NAME = "001-create-phase2-domain";
export const CODEX_MARKER = "codex-raw-input-tokens-v1";

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

export const LEGACY_EVENT_TABLES = [
  "tool_events",
  "prompt_events",
  "assistant_responses",
  "token_usage_events",
  "code_edits"
] as const;

export const SOURCE_DEFAULTS: Record<string, string> = {
  "claude-code": "claude:default",
  opencode: "opencode:default",
  zcode: "zcode:default",
  kimicode: "kimicode:default",
  dsh: "dsh:default",
  codex: "codex:default",
  cursor: "cursor:default",
  mimo: "mimo:default"
};

/**
 * Exhaustive usage_source registry (spec section 9.5).
 *
 * - `codex-history` intentionally has no usage_source row: it does not emit usage
 *   unless a later fixture adds a registry entry.
 * - `codex-logs` is registered for migration/replay completeness. The current
 *   codex-sync path only reads logs_2.sqlite for session→model enrichment and
 *   does not emit `usage_source: "codex-logs"` events; unknown historical pairs
 *   still land in pending_usage_migrations until an emitter is added.
 */
export const USAGE_REGISTRY: Record<
  string,
  { semantics: "delta" | "gross"; measurement: "increment" | "session-context-snapshot"; adapters: string[] }
> = {
  "claude-transcript": { semantics: "delta", measurement: "increment", adapters: ["claude-transcript"] },
  "opencode-message": { semantics: "gross", measurement: "increment", adapters: ["opencode-db", "zcode-db", "mimo-db"] },
  "opencode-step-finish": { semantics: "gross", measurement: "increment", adapters: ["opencode-db", "zcode-db", "mimo-db"] },
  "kimicode-usage": { semantics: "delta", measurement: "increment", adapters: ["kimicode-wire"] },
  "dsh-usage": { semantics: "delta", measurement: "increment", adapters: ["dsh-jsonl"] },
  "cursor-generation": { semantics: "delta", measurement: "increment", adapters: ["cursor-ide"] },
  "cursor-composer-context": {
    semantics: "delta",
    measurement: "session-context-snapshot",
    adapters: ["cursor-ide"]
  },
  "codex-rollout": { semantics: "gross", measurement: "increment", adapters: ["codex-rollout"] },
  "codex-logs": { semantics: "gross", measurement: "increment", adapters: ["codex-logs"] }
};

export function registerSource(db: SqliteDatabaseLike, sourceInstanceId: string, sourceVendor: string, at: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO source_instances
      (source_instance_id, source_vendor, root_identity, display_name, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run(sourceInstanceId, sourceVendor, at, at);
}

export function registerAdapter(db: SqliteDatabaseLike, sourceInstanceId: string, sourceAdapter: string, at: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO adapter_instances
      (adapter_instance_id, source_instance_id, source_adapter, config_fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
  `).run(adapterInstanceId(sourceInstanceId, sourceAdapter), sourceInstanceId, sourceAdapter, at, at);
}

export function hasMigration(db: SqliteDatabaseLike, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM schema_migrations WHERE name = ?").get(name));
}

export function tableExists(db: SqliteDatabaseLike, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

export function tableNames(db: SqliteDatabaseLike): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

export function columnNames(db: SqliteDatabaseLike, table: string): Set<string> {
  return new Set(
    db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  );
}

export function rowsFrom(db: SqliteDatabaseLike, table: string): Row[] {
  return db.prepare<Row>(`SELECT * FROM ${table}`).all();
}

export function sourceInstanceIdFor(sourceVendor: string): string {
  return SOURCE_DEFAULTS[sourceVendor] ?? `${sourceVendor}:default`;
}

export function adapterInstanceId(sourceInstanceId: string, sourceAdapter: string): string {
  return `${sourceAdapter}@${sourceInstanceId}`;
}

export function sessionWorkspace(db: SqliteDatabaseLike, sourceInstanceId: string, sessionId: string): string {
  const row = db
    .prepare<{ workspace_path: string }>(
      "SELECT workspace_path FROM domain_sessions WHERE source_instance_id = ? AND session_id = ?"
    )
    .get(sourceInstanceId, sessionId);
  return row?.workspace_path ?? ".";
}

export function resolveNow(now: MigrationNow): string {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DomainMigrationError("INVALID_MIGRATION_TIME", "now must be a valid date");
  }
  return date.toISOString();
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function withoutProvenance(event: Row): Row {
  const copy = { ...event };
  delete copy.source_adapter;
  delete copy.adapter_instance_id;
  return copy;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function throwUnknownShape(db: SqliteDatabaseLike, reason: string): never {
  throw new DomainMigrationError(
    "UNKNOWN_PARTIAL_SCHEMA",
    `${reason}; create a backup before retrying migration`,
    { tables: tableNames(db), reason }
  );
}
