import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  dropCursorGenerationShadowedByOfficial,
  persistCursorAccountUsage,
  purgeCursorOfficialUsageEvents,
  selectCursorAccountUsage,
  toCursorAccountUsageResponse
} from "./cursor-account-usage.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

describe("cursor account usage storage", () => {
  it("persists and reads the latest official snapshot", () => {
    const db = new Database(":memory:") as unknown as SqliteDatabaseLike;

    persistCursorAccountUsage(db, {
      sourceInstanceId: "cursor:default",
      email: "dev@example.com",
      planTier: "pro",
      subscriptionStatus: "active",
      machineId: "machine-123",
      hostname: "dev-box",
      syncedAt: "2026-07-21T09:00:00.000Z",
      currentPeriod: {
        billingCycleStart: "2026-06-27T09:17:27.000Z",
        billingCycleEnd: "2026-07-27T09:17:27.000Z",
        displayMessage: "You've used 48% of your included total usage",
        planUsage: {
          totalSpendCents: 16784,
          includedSpendCents: 2000,
          bonusSpendCents: 14784,
          limitCents: 2000,
          remainingCents: 0,
          autoPercentUsed: 42.7,
          apiPercentUsed: 88.0,
          totalPercentUsed: 48.6
        }
      },
      planInfo: {
        planName: "Pro",
        includedAmountCents: 2000,
        price: "$20/mo",
        billingCycleEnd: "2026-07-27T09:17:27.000Z"
      },
      modelUsage: {
        models: [
          {
            model: "cursor-grok-4.5-high-fast",
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 1000,
            cacheWriteTokens: 0,
            totalCents: 12.5,
            tier: 2
          }
        ],
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCacheWriteTokens: 0,
        totalCacheReadTokens: 1000,
        totalCostCents: 12.5
      },
      todayModelUsage: {
        models: [
          {
            model: "cursor-grok-4.5-high-fast",
            inputTokens: 50,
            outputTokens: 10,
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
            totalCents: 6,
            tier: 2
          }
        ],
        totalInputTokens: 50,
        totalOutputTokens: 10,
        totalCacheWriteTokens: 0,
        totalCacheReadTokens: 500,
        totalCostCents: 6
      },
      todayDayKey: "2026-07-21",
      todayCreatedAt: "2026-07-21T04:00:00.000Z"
    });

    const row = selectCursorAccountUsage(db, "cursor:default");
    expect(row).not.toBeNull();
    expect(row?.totalPercentUsed).toBe(48.6);
    expect(row?.planName).toBe("Pro");
    expect(row?.modelAggregations).toHaveLength(1);
    expect(toCursorAccountUsageResponse(row!)).toMatchObject({
      sourceInstanceId: "cursor:default",
      email: "dev@example.com",
      totalPercentUsed: 48.6,
      apiPercentUsed: 88,
      modelUsageTotalCostCents: 12.5
    });
  });

  it("writes today's official model tokens without deleting local generation", () => {
    const db = new Database(":memory:") as unknown as SqliteDatabaseLike;
    db.exec(`
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
      CREATE TABLE usage_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        source_instance_id TEXT NOT NULL,
        source_vendor TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        model_id TEXT,
        provider_id TEXT NOT NULL,
        provider_base_url TEXT,
        provider_host TEXT,
        input_token_semantics TEXT NOT NULL,
        usage_measurement TEXT NOT NULL,
        raw_input_tokens INTEGER NOT NULL,
        displayed_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        server_tool_use TEXT NOT NULL,
        usage_source TEXT NOT NULL,
        semantic_fingerprint TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO token_usage_events (
        event_id, session_id, message_id, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, usage_source,
        source_vendor, source_adapter, created_at
      ) VALUES ('cursor-generation:local', 'session-1', 'message-1', 3, 1, 0, 0, 'cursor-generation', 'cursor', 'cursor-ide', '2026-07-21T04:00:00.000Z')`
    ).run();

    persistCursorAccountUsage(db, officialSnapshot());

    const legacy = db
      .prepare<{ eventId: string; inputTokens: number; usageSource: string }>(
        `SELECT event_id AS eventId, input_tokens AS inputTokens, usage_source AS usageSource
         FROM token_usage_events ORDER BY event_id`
      )
      .all();
    expect(legacy).toEqual([
      {
        eventId: "cursor-generation:local",
        inputTokens: 3,
        usageSource: "cursor-generation"
      },
      {
        eventId: "cursor-official:2026-07-21:0:cursor-grok-4.5-high-fast",
        inputTokens: 50,
        usageSource: "cursor-official"
      }
    ]);
    expect(
      db
        .prepare<{ displayedInputTokens: number; usageSource: string }>(
          `SELECT displayed_input_tokens AS displayedInputTokens, usage_source AS usageSource FROM usage_events`
        )
        .all()
    ).toEqual([{ displayedInputTokens: 50, usageSource: "cursor-official" }]);

    purgeCursorOfficialUsageEvents(db);
    expect(
      db.prepare<{ eventId: string }>(`SELECT event_id AS eventId FROM token_usage_events`).all()
    ).toEqual([{ eventId: "cursor-generation:local" }]);
  });

  it("keeps local generation on days the official snapshot does not cover", () => {
    const rows = dropCursorGenerationShadowedByOfficial([
      {
        usage_source: "cursor-official",
        created_at: "2026-07-21T04:00:00.000Z",
        input_tokens: 50
      },
      {
        usage_source: "cursor-generation",
        created_at: "2026-07-21T06:00:00.000Z",
        input_tokens: 3
      },
      {
        usage_source: "cursor-generation",
        created_at: "2026-07-20T06:00:00.000Z",
        input_tokens: 9
      }
    ]);

    expect(rows.map((row) => row.input_tokens)).toEqual([50, 9]);
  });
});

function officialSnapshot() {
  return {
    sourceInstanceId: "cursor:default",
    email: "dev@example.com",
    planTier: "pro",
    subscriptionStatus: "active",
    machineId: "machine-123",
    hostname: "dev-box",
    syncedAt: "2026-07-21T09:00:00.000Z",
    currentPeriod: {
      billingCycleStart: "2026-06-27T09:17:27.000Z",
      billingCycleEnd: "2026-07-27T09:17:27.000Z",
      displayMessage: "You've used 48% of your included total usage",
      planUsage: {
        totalSpendCents: 16784,
        includedSpendCents: 2000,
        bonusSpendCents: 14784,
        limitCents: 2000,
        remainingCents: 0,
        autoPercentUsed: 42.7,
        apiPercentUsed: 88.0,
        totalPercentUsed: 48.6
      }
    },
    planInfo: {
      planName: "Pro",
      includedAmountCents: 2000,
      price: "$20/mo",
      billingCycleEnd: "2026-07-27T09:17:27.000Z"
    },
    modelUsage: {
      models: [
        {
          model: "cursor-grok-4.5-high-fast",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          totalCents: 12.5,
          tier: 2
        }
      ],
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 1000,
      totalCostCents: 12.5
    },
    todayModelUsage: {
      models: [
        {
          model: "cursor-grok-4.5-high-fast",
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 500,
          cacheWriteTokens: 0,
          totalCents: 6,
          tier: 2
        }
      ],
      totalInputTokens: 50,
      totalOutputTokens: 10,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 500,
      totalCostCents: 6
    },
    todayDayKey: "2026-07-21",
    todayCreatedAt: "2026-07-21T04:00:00.000Z"
  };
}
