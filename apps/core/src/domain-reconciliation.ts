import {
  LEGACY_EVENT_TABLES,
  USAGE_REGISTRY,
  nonNegativeInteger,
  stringValue,
  tableExists
} from "./domain-migration-helpers.js";
import { DomainMigrationError, type SqliteDatabaseLike } from "./domain-types.js";

type CountRow = { count: number };
type UsageFoldRow = {
  event_id: string;
  displayed_input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  usage_measurement: string;
  model_id: string | null;
  source_vendor: string;
  provider_id: string;
  source_instance_id: string;
  session_id: string;
};

/**
 * Spec section 10.1 step 7: run reconciliation before writing the Phase 2
 * migration marker. Throws DomainMigrationError so the surrounding transaction
 * rolls back on failure.
 */
export function reconcileLegacyMigration(db: SqliteDatabaseLike): void {
  if (!tableExists(db, "sessions")) {
    return;
  }

  const historicalTotal = countHistoricalRows(db);
  const legacyNormalized = scalarCount(
    db,
    "SELECT COUNT(*) AS count FROM normalized_events WHERE event_id LIKE 'legacy:%'"
  );

  if (legacyNormalized !== historicalTotal) {
    throw new DomainMigrationError(
      "RECONCILIATION_FAILED",
      "historical rows are not counted exactly once as normalized legacy events",
      { historicalTotal, legacyNormalized }
    );
  }

  reconcileUsageDisposition(db);
  reconcileToolCalls(db);
  reconcileTokenFolds(db);
  reconcileIdentityConflicts(db);
}

function countHistoricalRows(db: SqliteDatabaseLike): number {
  let total = scalarCount(db, "SELECT COUNT(*) AS count FROM sessions");
  for (const table of LEGACY_EVENT_TABLES) {
    if (tableExists(db, table)) {
      total += scalarCount(db, `SELECT COUNT(*) AS count FROM ${table}`);
    }
  }
  return total;
}

function reconcileUsageDisposition(db: SqliteDatabaseLike): void {
  if (!tableExists(db, "token_usage_events")) {
    return;
  }

  const usageRows = db
    .prepare<{ event_id: string }>("SELECT event_id FROM token_usage_events")
    .all();

  for (const row of usageRows) {
    const eventId = `legacy:token_usage_events:${stringValue(row.event_id, "usage")}`;
    const inUsage = scalarCount(
      db,
      "SELECT COUNT(*) AS count FROM usage_events WHERE event_id = ?",
      eventId
    );
    const inPending = scalarCount(
      db,
      "SELECT COUNT(*) AS count FROM pending_usage_migrations WHERE event_id = ?",
      eventId
    );
    const invalid = scalarCount(
      db,
      `SELECT COUNT(*) AS count FROM event_diagnostics
       WHERE diagnostic_code = 'INVALID_USAGE' AND event_id = ?`,
      eventId
    );

    const buckets = [inUsage > 0, inPending > 0, invalid > 0].filter(Boolean).length;
    if (buckets !== 1) {
      throw new DomainMigrationError(
        "RECONCILIATION_FAILED",
        "usage row must be counted exactly once as normalized, pending, or invalid",
        { eventId, inUsage, inPending, invalid }
      );
    }
  }
}

function reconcileToolCalls(db: SqliteDatabaseLike): void {
  if (!tableExists(db, "tool_events")) {
    return;
  }

  const historicalTools = scalarCount(db, "SELECT COUNT(*) AS count FROM tool_events");
  const projectedTools = scalarCount(
    db,
    "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_call_id LIKE 'legacy:%'"
  );

  if (projectedTools !== historicalTools) {
    throw new DomainMigrationError(
      "RECONCILIATION_FAILED",
      "projected tool calls do not equal legacy tool lifecycle rows",
      { historicalTools, projectedTools }
    );
  }
}

function reconcileTokenFolds(db: SqliteDatabaseLike): void {
  const rows = db
    .prepare<UsageFoldRow>(
      `SELECT event_id, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
              cache_read_input_tokens, usage_measurement, model_id, source_vendor, provider_id,
              source_instance_id, session_id
       FROM usage_events`
    )
    .all();

  const additive = rows.filter((row) => row.usage_measurement !== "session-context-snapshot");
  let overviewTotal = 0;
  const byModel = new Map<string, number>();
  const byVendor = new Map<string, number>();
  const byProvider = new Map<string, number>();
  const bySession = new Map<string, number>();

  for (const row of additive) {
    const total = totalTokensForRow(row);
    overviewTotal += total;

    const model = row.model_id ?? "unknown";
    byModel.set(model, (byModel.get(model) ?? 0) + total);
    byVendor.set(row.source_vendor, (byVendor.get(row.source_vendor) ?? 0) + total);
    byProvider.set(row.provider_id, (byProvider.get(row.provider_id) ?? 0) + total);
    const sessionKey = `${row.source_instance_id}\0${row.session_id}`;
    bySession.set(sessionKey, (bySession.get(sessionKey) ?? 0) + total);
  }

  const sumMap = (map: Map<string, number>) =>
    [...map.values()].reduce((sum, value) => sum + value, 0);

  if (
    sumMap(byModel) !== overviewTotal ||
    sumMap(byVendor) !== overviewTotal ||
    sumMap(byProvider) !== overviewTotal ||
    sumMap(bySession) !== overviewTotal
  ) {
    throw new DomainMigrationError(
      "RECONCILIATION_FAILED",
      "model/source-vendor/provider/session totals do not satisfy section 9.6",
      {
        overviewTotal,
        modelTotal: sumMap(byModel),
        vendorTotal: sumMap(byVendor),
        providerTotal: sumMap(byProvider),
        sessionTotal: sumMap(bySession)
      }
    );
  }

  if (!tableExists(db, "token_usage_events")) {
    return;
  }

  let independentTotal = 0;
  for (const row of additive) {
    const nativeId = row.event_id.replace(/^legacy:token_usage_events:/u, "");
    const legacy = db
      .prepare<{
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        usage_source: string;
        source_vendor: string;
        source_adapter: string;
      }>(
        `SELECT input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
                usage_source, source_vendor, source_adapter
         FROM token_usage_events WHERE event_id = ?`
      )
      .get(nativeId);

    if (!legacy) {
      throw new DomainMigrationError(
        "RECONCILIATION_FAILED",
        "usage_events row has no matching legacy token_usage_events source",
        { eventId: row.event_id }
      );
    }

    const mapping = USAGE_REGISTRY[legacy.usage_source];
    if (!mapping || !mapping.adapters.includes(legacy.source_adapter)) {
      throw new DomainMigrationError(
        "RECONCILIATION_FAILED",
        "accepted usage_events row has no registry mapping",
        { eventId: row.event_id, usageSource: legacy.usage_source }
      );
    }

    if (mapping.measurement === "session-context-snapshot") {
      continue;
    }

    const cacheRead = nonNegativeInteger(legacy.cache_read_input_tokens);
    if (legacy.source_vendor === "codex") {
      // Marked/unmarked Codex conversion is applied during backfill in this same
      // transaction (and the marker is written before reconciliation). Use the
      // stored usage_events counters as the independent fold source of truth.
      independentTotal += totalTokensForRow(row);
      continue;
    }

    const storedInput = nonNegativeInteger(legacy.input_tokens);
    const displayed =
      mapping.semantics === "gross" ? storedInput - cacheRead : storedInput;
    if (displayed < 0) {
      throw new DomainMigrationError(
        "RECONCILIATION_FAILED",
        "independent token fold encountered invalid gross usage",
        { eventId: row.event_id }
      );
    }

    independentTotal +=
      displayed +
      nonNegativeInteger(legacy.output_tokens) +
      cacheRead +
      nonNegativeInteger(legacy.cache_creation_input_tokens);
  }

  if (independentTotal !== overviewTotal) {
    throw new DomainMigrationError(
      "RECONCILIATION_FAILED",
      "normalized raw token-counter sums do not equal the independent fold",
      { overviewTotal, independentTotal }
    );
  }
}

function totalTokensForRow(row: {
  displayed_input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}): number {
  return (
    nonNegativeInteger(row.displayed_input_tokens) +
    nonNegativeInteger(row.output_tokens) +
    nonNegativeInteger(row.cache_read_input_tokens) +
    nonNegativeInteger(row.cache_creation_input_tokens)
  );
}

function reconcileIdentityConflicts(db: SqliteDatabaseLike): void {
  const conflicts = db
    .prepare<{ event_id: string; fingerprints: number }>(
      `SELECT event_id, COUNT(DISTINCT semantic_fingerprint) AS fingerprints
       FROM event_observations
       GROUP BY event_id
       HAVING COUNT(DISTINCT semantic_fingerprint) > 1`
    )
    .all();

  for (const conflict of conflicts) {
    const diagnostics = scalarCount(
      db,
      `SELECT COUNT(*) AS count FROM event_diagnostics
       WHERE diagnostic_code = 'IDENTITY_CONFLICT' AND event_id = ?`,
      conflict.event_id
    );
    if (diagnostics === 0) {
      throw new DomainMigrationError(
        "RECONCILIATION_FAILED",
        "event_id has multiple semantic fingerprints without IDENTITY_CONFLICT diagnostic",
        { eventId: conflict.event_id, fingerprints: conflict.fingerprints }
      );
    }
  }
}

function scalarCount(db: SqliteDatabaseLike, sql: string, ...params: unknown[]): number {
  const row = db.prepare<CountRow>(sql).get(...params);
  return Number(row?.count ?? 0);
}
