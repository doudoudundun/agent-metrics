import { createHash } from "node:crypto";
import type { CursorAccountUsageSnapshot } from "@agent-metrics/adapters-cursor";
import type { CursorModelAggregation } from "@agent-metrics/contracts";
import type { SqliteDatabaseLike } from "./domain-types.js";

const CURSOR_OFFICIAL_TIME_ZONE = "Asia/Shanghai";
const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: CURSOR_OFFICIAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export type CursorAccountUsageRow = {
  sourceInstanceId: string;
  email: string | null;
  planName: string | null;
  planTier: string | null;
  subscriptionStatus: string | null;
  hostname: string | null;
  machineId: string | null;
  billingCycleStart: string;
  billingCycleEnd: string;
  totalSpendCents: number;
  includedSpendCents: number;
  bonusSpendCents: number;
  limitCents: number;
  remainingCents: number | null;
  autoPercentUsed: number;
  apiPercentUsed: number;
  totalPercentUsed: number;
  displayMessage: string | null;
  syncedAt: string;
  modelAggregations: CursorModelAggregation[];
  modelUsageTotalCostCents: number;
};

function ensureModelAggregationsColumn(db: SqliteDatabaseLike): void {
  const columns = db
    .prepare<{ name: string }>("PRAGMA table_info(cursor_account_usage)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("model_aggregations_json")) {
    db.exec(`ALTER TABLE cursor_account_usage ADD COLUMN model_aggregations_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!columns.includes("model_usage_total_cost_cents")) {
    db.exec(
      `ALTER TABLE cursor_account_usage ADD COLUMN model_usage_total_cost_cents REAL NOT NULL DEFAULT 0`
    );
  }
}

function parseModelAggregations(raw: string | null | undefined): CursorModelAggregation[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return null;
        }
        const row = entry as Record<string, unknown>;
        const model = typeof row.model === "string" ? row.model : null;
        if (!model) {
          return null;
        }
        return {
          model,
          inputTokens: Number(row.inputTokens) || 0,
          outputTokens: Number(row.outputTokens) || 0,
          cacheReadTokens: Number(row.cacheReadTokens) || 0,
          cacheWriteTokens: Number(row.cacheWriteTokens) || 0,
          totalCents: Number(row.totalCents) || 0,
          tier: typeof row.tier === "number" && Number.isFinite(row.tier) ? Math.trunc(row.tier) : null
        } satisfies CursorModelAggregation;
      })
      .filter((entry): entry is CursorModelAggregation => entry !== null);
  } catch {
    return [];
  }
}

export function ensureCursorAccountUsageSchema(db: SqliteDatabaseLike): void {
  db.exec(`
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
  `);
  ensureModelAggregationsColumn(db);
}

export function persistCursorAccountUsage(db: SqliteDatabaseLike, snapshot: CursorAccountUsageSnapshot): void {
  ensureCursorAccountUsageSchema(db);
  const usage = snapshot.currentPeriod.planUsage;
  const models = snapshot.modelUsage?.models ?? [];
  const modelUsageTotalCostCents = snapshot.modelUsage?.totalCostCents ?? 0;

  db.prepare(
    `INSERT INTO cursor_account_usage (
      source_instance_id, email, plan_name, plan_tier, subscription_status,
      hostname, machine_id, billing_cycle_start, billing_cycle_end,
      total_spend_cents, included_spend_cents, bonus_spend_cents, limit_cents,
      remaining_cents, auto_percent_used, api_percent_used, total_percent_used,
      display_message, synced_at, model_aggregations_json, model_usage_total_cost_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_instance_id) DO UPDATE SET
      email = excluded.email,
      plan_name = excluded.plan_name,
      plan_tier = excluded.plan_tier,
      subscription_status = excluded.subscription_status,
      hostname = excluded.hostname,
      machine_id = excluded.machine_id,
      billing_cycle_start = excluded.billing_cycle_start,
      billing_cycle_end = excluded.billing_cycle_end,
      total_spend_cents = excluded.total_spend_cents,
      included_spend_cents = excluded.included_spend_cents,
      bonus_spend_cents = excluded.bonus_spend_cents,
      limit_cents = excluded.limit_cents,
      remaining_cents = excluded.remaining_cents,
      auto_percent_used = excluded.auto_percent_used,
      api_percent_used = excluded.api_percent_used,
      total_percent_used = excluded.total_percent_used,
      display_message = excluded.display_message,
      synced_at = excluded.synced_at,
      model_aggregations_json = excluded.model_aggregations_json,
      model_usage_total_cost_cents = excluded.model_usage_total_cost_cents`
  ).run(
    snapshot.sourceInstanceId,
    snapshot.email,
    snapshot.planInfo.planName,
    snapshot.planTier,
    snapshot.subscriptionStatus,
    snapshot.hostname,
    snapshot.machineId,
    snapshot.currentPeriod.billingCycleStart,
    snapshot.currentPeriod.billingCycleEnd,
    usage.totalSpendCents,
    usage.includedSpendCents,
    usage.bonusSpendCents,
    usage.limitCents,
    usage.remainingCents,
    usage.autoPercentUsed,
    usage.apiPercentUsed,
    usage.totalPercentUsed,
    snapshot.currentPeriod.displayMessage,
    snapshot.syncedAt,
    JSON.stringify(models),
    modelUsageTotalCostCents
  );
  persistCursorOfficialDayTokens(db, snapshot);
}

export function selectCursorAccountUsage(
  db: SqliteDatabaseLike,
  sourceInstanceId = "cursor:default"
): CursorAccountUsageRow | null {
  ensureCursorAccountUsageSchema(db);
  const row = db
    .prepare<{
      sourceInstanceId: string;
      email: string | null;
      planName: string | null;
      planTier: string | null;
      subscriptionStatus: string | null;
      hostname: string | null;
      machineId: string | null;
      billingCycleStart: string;
      billingCycleEnd: string;
      totalSpendCents: number;
      includedSpendCents: number;
      bonusSpendCents: number;
      limitCents: number;
      remainingCents: number | null;
      autoPercentUsed: number;
      apiPercentUsed: number;
      totalPercentUsed: number;
      displayMessage: string | null;
      syncedAt: string;
      modelAggregationsJson: string | null;
      modelUsageTotalCostCents: number | null;
    }>(
      `SELECT
        source_instance_id AS sourceInstanceId,
        email,
        plan_name AS planName,
        plan_tier AS planTier,
        subscription_status AS subscriptionStatus,
        hostname,
        machine_id AS machineId,
        billing_cycle_start AS billingCycleStart,
        billing_cycle_end AS billingCycleEnd,
        total_spend_cents AS totalSpendCents,
        included_spend_cents AS includedSpendCents,
        bonus_spend_cents AS bonusSpendCents,
        limit_cents AS limitCents,
        remaining_cents AS remainingCents,
        auto_percent_used AS autoPercentUsed,
        api_percent_used AS apiPercentUsed,
        total_percent_used AS totalPercentUsed,
        display_message AS displayMessage,
        synced_at AS syncedAt,
        model_aggregations_json AS modelAggregationsJson,
        model_usage_total_cost_cents AS modelUsageTotalCostCents
      FROM cursor_account_usage
      WHERE source_instance_id = ?`
    )
    .get(sourceInstanceId);

  if (!row) {
    return null;
  }

  return {
    sourceInstanceId: row.sourceInstanceId,
    email: row.email,
    planName: row.planName,
    planTier: row.planTier,
    subscriptionStatus: row.subscriptionStatus,
    hostname: row.hostname,
    machineId: row.machineId,
    billingCycleStart: row.billingCycleStart,
    billingCycleEnd: row.billingCycleEnd,
    totalSpendCents: row.totalSpendCents,
    includedSpendCents: row.includedSpendCents,
    bonusSpendCents: row.bonusSpendCents,
    limitCents: row.limitCents,
    remainingCents: row.remainingCents,
    autoPercentUsed: row.autoPercentUsed,
    apiPercentUsed: row.apiPercentUsed,
    totalPercentUsed: row.totalPercentUsed,
    displayMessage: row.displayMessage,
    syncedAt: row.syncedAt,
    modelAggregations: parseModelAggregations(row.modelAggregationsJson),
    modelUsageTotalCostCents: row.modelUsageTotalCostCents ?? 0
  };
}

export function toCursorAccountUsageResponse(row: CursorAccountUsageRow) {
  return {
    sourceInstanceId: row.sourceInstanceId,
    email: row.email,
    planName: row.planName,
    planTier: row.planTier,
    subscriptionStatus: row.subscriptionStatus,
    hostname: row.hostname,
    machineId: row.machineId,
    billingCycleStart: row.billingCycleStart,
    billingCycleEnd: row.billingCycleEnd,
    totalSpendCents: row.totalSpendCents,
    includedSpendCents: row.includedSpendCents,
    bonusSpendCents: row.bonusSpendCents,
    limitCents: row.limitCents,
    remainingCents: row.remainingCents,
    autoPercentUsed: row.autoPercentUsed,
    apiPercentUsed: row.apiPercentUsed,
    totalPercentUsed: row.totalPercentUsed,
    displayMessage: row.displayMessage,
    syncedAt: row.syncedAt,
    modelAggregations: row.modelAggregations,
    modelUsageTotalCostCents: row.modelUsageTotalCostCents
  };
}

type OfficialShadowRow = {
  usage_source?: string | null;
  usageSource?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
};

/**
 * Dashboard totals read token_usage_events / usage_events. Official day rows
 * are that source for Cursor. Local cursor-generation rows on the same
 * Shanghai day are dropped at read time so the two are not added together.
 */
export function dropCursorGenerationShadowedByOfficial<T extends OfficialShadowRow>(rows: T[]): T[] {
  const officialDays = new Set<string>();
  for (const row of rows) {
    const source = row.usage_source ?? row.usageSource;
    const created = row.created_at ?? row.createdAt;
    if (source === "cursor-official" && created) {
      officialDays.add(shanghaiDayKey(created));
    }
  }
  if (officialDays.size === 0) {
    return rows;
  }

  return rows.filter((row) => {
    const source = row.usage_source ?? row.usageSource;
    const created = row.created_at ?? row.createdAt;
    if (source !== "cursor-generation" || !created) {
      return true;
    }
    return !officialDays.has(shanghaiDayKey(created));
  });
}

/**
 * Upsert today's official Cursor model totals into legacy token_usage_events
 * (dashboard overview, source ranking, trend) and canonical usage_events
 * (widget). Only this day's official prefix is replaced.
 */
export function persistCursorOfficialDayTokens(
  db: SqliteDatabaseLike,
  snapshot: CursorAccountUsageSnapshot
): void {
  const dayKey = snapshot.todayDayKey;
  const createdAt = snapshot.todayCreatedAt;
  const models = snapshot.todayModelUsage?.models ?? [];
  const sessionId = `cursor-official:${dayKey}`;
  const sourceInstanceId = snapshot.sourceInstanceId || "cursor:default";
  const prefix = `cursor-official:${dayKey}:%`;

  const write = () => {
    if (sqliteTableExists(db, "token_usage_events")) {
      db.prepare(`DELETE FROM token_usage_events WHERE event_id LIKE ?`).run(prefix);
      const insertLegacy = db.prepare(
        `INSERT INTO token_usage_events (
          event_id, session_id, message_id, model, input_tokens, output_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, server_tool_use,
          usage_source, source_vendor, source_adapter, provider_id, provider_base_url,
          provider_host, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'cursor-official', 'cursor', 'cursor-ide', 'cursor', NULL, NULL, ?)`
      );
      models.forEach((model, index) => {
        if (modelTokenTotal(model) === 0) {
          return;
        }
        const eventId = officialEventId(dayKey, model.model, index);
        insertLegacy.run(
          eventId,
          sessionId,
          eventId,
          model.model,
          model.inputTokens,
          model.outputTokens,
          model.cacheWriteTokens,
          model.cacheReadTokens,
          createdAt
        );
      });
    }

    if (sqliteTableExists(db, "usage_events")) {
      db.prepare(`DELETE FROM usage_events WHERE event_id LIKE ?`).run(prefix);
      const insertCanonical = db.prepare(
        `INSERT INTO usage_events (
          event_id, schema_version, source_instance_id, source_vendor, session_id,
          message_id, occurred_at, model_id, provider_id, provider_base_url, provider_host,
          input_token_semantics, usage_measurement, raw_input_tokens, displayed_input_tokens,
          output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use,
          usage_source, semantic_fingerprint
        ) VALUES (?, 2, ?, 'cursor', ?, ?, ?, ?, 'cursor', NULL, NULL, 'delta', 'increment', ?, ?, ?, ?, ?, '{}', 'cursor-official', ?)`
      );
      models.forEach((model, index) => {
        if (modelTokenTotal(model) === 0) {
          return;
        }
        const eventId = officialEventId(dayKey, model.model, index);
        insertCanonical.run(
          eventId,
          sourceInstanceId,
          sessionId,
          eventId,
          createdAt,
          model.model,
          model.inputTokens,
          model.inputTokens,
          model.outputTokens,
          model.cacheWriteTokens,
          model.cacheReadTokens,
          createHash("sha256").update(eventId).digest("hex")
        );
      });
    }
  };

  db.transaction(write)();
}

export function purgeCursorOfficialUsageEvents(db: SqliteDatabaseLike): void {
  for (const table of ["token_usage_events", "usage_events"] as const) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE event_id LIKE 'cursor-official:%'`).run();
    } catch {
      // Isolated unit tests may not create these tables.
    }
  }
}

function sqliteTableExists(db: SqliteDatabaseLike, tableName: string): boolean {
  return (
    db
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName) !== undefined
  );
}

function modelTokenTotal(model: CursorModelAggregation): number {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheWriteTokens;
}

function officialEventId(dayKey: string, model: string, index: number): string {
  const slug = model.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `cursor-official:${dayKey}:${index}:${slug.length > 0 ? slug : "model"}`;
}

function shanghaiDayKey(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return SHANGHAI_DAY_FORMATTER.format(parsed);
}
