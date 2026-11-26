import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createWorkbuddyParseState, normalizeWorkbuddyRecord } from "@agent-metrics/adapters-workbuddy";
import { selectOverviewRows, selectTokenUsageRows, selectTokensByModel } from "./aggregate-queries.js";
import {
  selectCanonicalSessionDetail,
  selectCanonicalSessions,
  selectWidgetSnapshot
} from "./canonical-queries.js";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";
import type { MetricsDatabase } from "./core-types.js";
import {
  selectProviderBreakdown,
  selectSessions,
  selectSourceBreakdown,
  selectTokenTrend
} from "./session-queries.js";
import { projectNormalizedEvents } from "./domain-projection.js";

type UsageSeed = {
  eventId: string;
  sessionId: string;
  messageId: string;
  occurredAt: string;
  modelId: string | null;
  sourceVendor: string;
  sourceInstanceId: string;
  usageSource: string;
  usageMeasurement: "increment" | "session-context-snapshot";
  inputTokenSemantics: "delta" | "gross";
  rawInputTokens: number;
  displayedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  providerId: string;
  providerBaseUrl: string | null;
  providerHost: string | null;
  serviceTier: string | null;
  firstTokenLatencyMs: number | null;
  decodeDurationMs: number | null;
};

type UsageSeedInput = Partial<UsageSeed> & Pick<UsageSeed, "eventId" | "sessionId" | "messageId">;

function createDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  runDomainMigrations(db as unknown as SqliteDatabaseLike, "2026-10-26T00:00:00.000Z");
  return db;
}

function usageSeed(input: UsageSeedInput): UsageSeed {
  return {
    eventId: input.eventId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    occurredAt: input.occurredAt ?? "2026-10-26T10:00:00.000Z",
    modelId: input.modelId !== undefined ? input.modelId : "deepseek-v4.1-flash",
    sourceVendor: input.sourceVendor ?? "workbuddy",
    sourceInstanceId: input.sourceInstanceId ?? "workbuddy:default",
    usageSource: input.usageSource ?? "workbuddy-usage",
    usageMeasurement: input.usageMeasurement ?? "increment",
    inputTokenSemantics: input.inputTokenSemantics ?? "gross",
    rawInputTokens: input.rawInputTokens ?? 100,
    // WorkBuddy reports gross input, while displayed_input_tokens excludes the cache read.
    displayedInputTokens: input.displayedInputTokens ?? 80,
    outputTokens: input.outputTokens ?? 20,
    cacheReadTokens: input.cacheReadTokens ?? 20,
    cacheCreationTokens: input.cacheCreationTokens ?? 0,
    providerId: input.providerId ?? "deepseek",
    providerBaseUrl: input.providerBaseUrl !== undefined ? input.providerBaseUrl : "https://api.example.test/v1",
    providerHost: input.providerHost !== undefined ? input.providerHost : "api.example.test",
    serviceTier: input.serviceTier ?? null,
    firstTokenLatencyMs: input.firstTokenLatencyMs !== undefined ? input.firstTokenLatencyMs : 100,
    decodeDurationMs: input.decodeDurationMs !== undefined ? input.decodeDurationMs : 1_000
  };
}

function seedUsage(db: InstanceType<typeof Database>, seeds: UsageSeed[]): void {
  const insertUsage = db.prepare(`
    INSERT INTO usage_events (
      event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
      occurred_at, model_id, service_tier, provider_id, provider_base_url, provider_host,
      input_token_semantics, usage_measurement, raw_input_tokens, displayed_input_tokens,
      output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use,
      usage_source, first_token_latency_ms, decode_duration_ms, semantic_fingerprint
    ) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
  `);
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO domain_sessions (
      source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at
    ) VALUES (?, ?, ?, ?, '.', ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO normalized_events (
      event_id, schema_version, session_id, source_instance_id, timestamp, type, event_type,
      source_vendor, source_adapter, adapter_instance_id, source_record_namespace,
      source_record_id, workspace_path, semantic_fingerprint, payload_json, created_at
    ) VALUES (?, 2, ?, ?, ?, 'token.usage.recorded', 'token.usage.recorded', ?, ?, ?,
      'workbuddy-jsonl', ?, '.', ?, ?, ?)
  `);

  for (const seed of seeds) {
    const sourceAdapter = seed.sourceVendor === "workbuddy" ? "workbuddy-jsonl" : "claude-transcript";
    insertSession.run(
      seed.sourceInstanceId,
      seed.sessionId,
      seed.sourceVendor,
      sourceAdapter,
      seed.occurredAt
    );
    insertUsage.run(
      seed.eventId,
      seed.sourceInstanceId,
      seed.sourceVendor,
      seed.sessionId,
      seed.messageId,
      seed.occurredAt,
      seed.modelId,
      seed.serviceTier,
      seed.providerId,
      seed.providerBaseUrl,
      seed.providerHost,
      seed.inputTokenSemantics,
      seed.usageMeasurement,
      seed.rawInputTokens,
      seed.displayedInputTokens,
      seed.outputTokens,
      seed.cacheCreationTokens,
      seed.cacheReadTokens,
      seed.usageSource,
      seed.firstTokenLatencyMs,
      seed.decodeDurationMs,
      `fp-${seed.eventId}`
    );
    insertEvent.run(
      seed.eventId,
      seed.sessionId,
      seed.sourceInstanceId,
      seed.occurredAt,
      seed.sourceVendor,
      sourceAdapter,
      `${sourceAdapter}@${seed.sourceInstanceId}`,
      seed.eventId,
      `fp-${seed.eventId}`,
      JSON.stringify({
        message_id: seed.messageId,
        model: seed.modelId,
        provider_id: seed.providerId,
        provider_host: seed.providerHost,
        input_tokens: seed.rawInputTokens,
        displayed_input_tokens: seed.displayedInputTokens,
        output_tokens: seed.outputTokens,
        cache_creation_input_tokens: seed.cacheCreationTokens,
        cache_read_input_tokens: seed.cacheReadTokens,
        usage_source: seed.usageSource
      }),
      "2026-10-26T00:00:00.000Z"
    );
  }
}

const inheritedUsage = [
  usageSeed({
    eventId: "usage-a-original",
    sessionId: "session-original",
    messageId: "provider-message-inherited"
  }),
  // A fork repeats the provider message. Different timing fields must not turn it into new usage.
  usageSeed({
    eventId: "usage-b-fork-copy",
    sessionId: "session-fork",
    messageId: "provider-message-inherited",
    firstTokenLatencyMs: 9_999,
    decodeDurationMs: null
  }),
  // A new request inside the fork is counted even though it belongs to the copied conversation.
  usageSeed({
    eventId: "usage-c-fork-new",
    sessionId: "session-fork",
    messageId: "provider-message-new",
    occurredAt: "2026-10-26T10:01:00.000Z",
    rawInputTokens: 30,
    displayedInputTokens: 30,
    outputTokens: 10,
    cacheReadTokens: 0,
    firstTokenLatencyMs: 200,
    decodeDurationMs: 500
  })
];

function normalizeWorkbuddyReply(sessionId: string, timestamp: number, stepAnchorAt: number) {
  const state = createWorkbuddyParseState();
  state.currentStepSeq = 1;
  state.stepAnchorAt = stepAnchorAt;
  return normalizeWorkbuddyRecord(
    {
      id: `assistant-record-${sessionId}`,
      timestamp,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Shared provider response" }],
      cwd: "/workspaces/project",
      providerData: {
        model: "deepseek-v4.1-flash",
        messageId: "provider-message-shared",
        stepSeq: 1,
        usage: {
          requests: 1,
          inputTokens: 1_000,
          outputTokens: 50,
          totalTokens: 1_050,
          inputTokensDetails: [{ cached_tokens: 100 }]
        },
        rawUsage: {
          prompt_tokens: 1_000,
          completion_tokens: 50,
          prompt_cache_hit_tokens: 100,
          prompt_cache_write_tokens: 0
        }
      }
    },
    sessionId,
    "/workspaces/project",
    state
  );
}

describe("WorkBuddy inherited conversation usage", () => {
  it("normalizes, projects, and idempotently replays the same provider message from two sessions", () => {
    const db = createDb();
    try {
      const timestamp = Date.parse("2026-10-26T10:00:00.000Z");
      const parentEvents = normalizeWorkbuddyReply("normalization-parent", timestamp, timestamp - 700);
      const forkEvents = normalizeWorkbuddyReply("normalization-fork", timestamp, timestamp - 1_200);
      const events = [...parentEvents, ...forkEvents];

      expect(parentEvents.map((event) => event.type)).toEqual(["assistant.responded", "token.usage.recorded"]);
      expect(forkEvents.map((event) => event.type)).toEqual(["assistant.responded", "token.usage.recorded"]);
      const parentUsage = parentEvents.find((event) => event.type === "token.usage.recorded");
      const forkUsage = forkEvents.find((event) => event.type === "token.usage.recorded");
      expect(parentUsage?.type === "token.usage.recorded" ? parentUsage.decode_duration_ms : null).toBe(700);
      expect(forkUsage?.type === "token.usage.recorded" ? forkUsage.decode_duration_ms : null).toBe(1_200);

      projectNormalizedEvents(db as unknown as SqliteDatabaseLike, events);
      const replayResults = projectNormalizedEvents(db as unknown as SqliteDatabaseLike, events);

      expect(replayResults.every((result) => result.idempotent && !result.conflict)).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE usage_source = 'workbuddy-usage'").get()).toEqual({
        count: 2
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events WHERE usage_source = 'workbuddy-usage'").get()).toEqual({
        count: 1
      });
      const rows = selectTokenUsageRows(db as unknown as MetricsDatabase);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("normalization-parent");
      expect(rows.reduce((sum, row) => sum + row.input_tokens + row.output_tokens + row.cache_read_input_tokens, 0)).toBe(
        1_050
      );
    } finally {
      db.close();
    }
  });

  it("deduplicates copied history across aggregate, trend, widget, provider, source, and session totals", () => {
    const db = createDb();
    try {
      seedUsage(db, inheritedUsage);
      const metricsDb = db as unknown as MetricsDatabase;
      const usage = selectTokenUsageRows(metricsDb);
      const overview = selectOverviewRows(metricsDb);

      expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM normalized_events").get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 2 });
      expect(usage.map((row) => row.source_instance_id + ":" + row.session_id)).toEqual([
        "workbuddy:default:session-original",
        "workbuddy:default:session-fork"
      ]);
      expect(usage.reduce((sum, row) => sum + row.input_tokens + row.output_tokens + row.cache_read_input_tokens, 0)).toBe(160);
      const inheritedWindow = selectTokenUsageRows(metricsDb, {
        mode: "custom",
        range: null,
        timezone: "UTC",
        windowStart: "2026-10-26T09:59:00.000Z",
        windowEnd: "2026-10-26T10:00:30.000Z"
      });
      expect(inheritedWindow).toHaveLength(1);
      expect(inheritedWindow[0].session_id).toBe("session-original");
      expect(selectTokensByModel(metricsDb, undefined, "all", usage).reduce((sum, row) => sum + row.totalTokens, 0)).toBe(160);
      expect(overview.tokenUsage).toHaveLength(2);
      expect(selectTokenTrend(metricsDb).reduce((sum, row) => sum + row.totalTokens, 0)).toBe(160);
      expect(selectSourceBreakdown(metricsDb, undefined, "all", usage).reduce((sum, row) => sum + row.totalTokens, 0)).toBe(160);
      expect(selectProviderBreakdown(metricsDb, undefined, "all", usage).reduce((sum, row) => sum + row.totalTokens, 0)).toBe(160);

      const sessions = selectSessions(metricsDb).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      expect(sessions.map(({ sessionId, totalTokens }) => [sessionId, totalTokens])).toEqual([
        ["session-fork", 40],
        ["session-original", 120]
      ]);
      expect(sessions.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(160);

      const widget = selectWidgetSnapshot(db as unknown as SqliteDatabaseLike, new Date("2026-10-26T10:02:00.000Z"), {
        offsetMinutes: 0
      });
      expect(widget.metrics).toMatchObject({
        totalTokens: 160,
        inputTokens: 110,
        outputTokens: 30,
        cacheReadTokens: 20
      });

      const canonicalScope = {
        mode: "lifetime" as const,
        range: "day" as const,
        timezone: "UTC",
        windowStart: null,
        windowEnd: null,
        updatedAt: "2026-10-26T10:02:00.000Z"
      };
      const canonicalSessions = selectCanonicalSessions(db as unknown as SqliteDatabaseLike, {
        scope: canonicalScope,
        sourceVendor: "all",
        limit: 10,
        cursor: null,
        createCursor: (cursor) => JSON.stringify(cursor)
      }).rows;
      expect(canonicalSessions.map(({ sessionId, totalTokens }) => [sessionId, totalTokens]).sort()).toEqual([
        ["session-fork", 40],
        ["session-original", 120]
      ]);
      expect(canonicalSessions.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(160);

      const firstSessionPage = selectCanonicalSessions(db as unknown as SqliteDatabaseLike, {
        scope: canonicalScope,
        sourceVendor: "all",
        limit: 1,
        cursor: null,
        createCursor: (cursor) => JSON.stringify(cursor)
      });
      const secondSessionPage = selectCanonicalSessions(db as unknown as SqliteDatabaseLike, {
        scope: canonicalScope,
        sourceVendor: "all",
        limit: 1,
        cursor: firstSessionPage.nextCursor ? JSON.parse(firstSessionPage.nextCursor) : null,
        createCursor: (cursor) => JSON.stringify(cursor)
      });
      expect(firstSessionPage.rows).toHaveLength(1);
      expect(secondSessionPage.rows).toHaveLength(1);
      expect(
        [...firstSessionPage.rows, ...secondSessionPage.rows].reduce((sum, row) => sum + row.totalTokens, 0)
      ).toBe(160);

      for (const [sessionId, expectedEventId] of [
        ["session-original", "usage-a-original"],
        ["session-fork", "usage-b-fork-copy"]
      ]) {
        const detail = selectCanonicalSessionDetail(db as unknown as SqliteDatabaseLike, {
          sourceInstanceId: "workbuddy:default",
          sessionId,
          scope: canonicalScope,
          limit: 10,
          cursor: null,
          createCursor: (cursor) => JSON.stringify(cursor)
        });
        expect(detail?.timeline.rows.map((row) => row.eventId)).toContain(expectedEventId);
      }
    } finally {
      db.close();
    }
  });

  it("only merges exact WorkBuddy provider-message usage and leaves snapshots outside additive totals", () => {
    const db = createDb();
    try {
      const pairs = [
        { key: "same", variant: {} },
        { key: "time", variant: { occurredAt: "2026-10-26T10:02:00.000Z" } },
        { key: "model", variant: { modelId: "deepseek-r1" } },
        { key: "provider", variant: { providerId: "other-provider" } },
        { key: "provider-host", variant: { providerHost: "alternate.example.test" } },
        { key: "provider-url", variant: { providerBaseUrl: "https://alternate.example.test/v1" } },
        { key: "tokens", variant: { outputTokens: 21 } },
        { key: "raw-input-tokens", variant: { rawInputTokens: 101 } },
        { key: "displayed-input-tokens", variant: { displayedInputTokens: 81 } },
        { key: "cache-read-tokens", variant: { cacheReadTokens: 21 } },
        { key: "cache-creation-tokens", variant: { cacheCreationTokens: 1 } },
        { key: "service-tier", variant: { serviceTier: "fast" } },
        { key: "usage-source", variant: { usageSource: "workbuddy-other" } },
        { key: "input-semantics", variant: { inputTokenSemantics: "delta" as const } },
        { key: "source-instance", variant: { sourceInstanceId: "workbuddy:other-profile" } },
        { key: "other-vendor", base: { sourceVendor: "claude-code", usageSource: "workbuddy-usage" } }
      ];
      const seeds: UsageSeed[] = [];
      for (const { key, variant, base } of pairs) {
        const baseline = usageSeed({
          eventId: `usage-${key}-a`,
          sessionId: `${key}-parent`,
          messageId: `message-${key}`,
          ...base
        });
        const duplicate = usageSeed({
          ...baseline,
          eventId: `usage-${key}-b`,
          sessionId: `${key}-fork`,
          ...variant
        });
        seeds.push(baseline, duplicate);
      }

      const snapshotBase = usageSeed({
        eventId: "usage-snapshot-a",
        sessionId: "snapshot-parent",
        messageId: "snapshot-message",
        usageMeasurement: "session-context-snapshot"
      });
      seeds.push(
        snapshotBase,
        usageSeed({ ...snapshotBase, eventId: "usage-snapshot-b", sessionId: "snapshot-fork" })
      );
      seedUsage(db, seeds);

      // The ordinary matching pair is canonicalized to its lexically first event id.
      expect(
        db.prepare("SELECT event_id FROM additive_usage_events WHERE message_id = 'message-same' ORDER BY event_id").all()
      ).toEqual([{ event_id: "usage-same-a" }]);
      // Each changed identity/usage dimension, profile, and vendor retains both usage rows.
      for (const key of pairs.slice(1).map(({ key }) => key)) {
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events WHERE message_id = ?").get(`message-${key}`)
        ).toEqual({ count: 2 });
      }
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events WHERE message_id = 'snapshot-message'").get()
      ).toEqual({ count: 2 });
      expect(selectTokenUsageRows(db as unknown as MetricsDatabase).every((row) => row.source_instance_id !== "workbuddy:default" || row.usage_measurement === "increment")).toBe(true);

      const plan = db
        .prepare<{ detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT event_id FROM additive_usage_events
           WHERE source_vendor = 'workbuddy'
             AND usage_source = 'workbuddy-usage'
             AND usage_measurement = 'increment'
             AND message_id = 'message-same'`
        )
        .all()
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("idx_usage_events_workbuddy_message");
    } finally {
      db.close();
    }
  });

  it("retains matching provider messages when their vendor-billed credits differ", () => {
    const db = createDb();
    try {
      seedUsage(db, [
        usageSeed({ eventId: "credit-a", sessionId: "credit-parent", messageId: "credit-message" }),
        usageSeed({ eventId: "credit-b", sessionId: "credit-fork", messageId: "credit-message" })
      ]);
      db.prepare("UPDATE usage_events SET credit = 0.42 WHERE event_id = 'credit-a'").run();
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 2 });
      db.prepare("UPDATE usage_events SET credit = 0.42 WHERE event_id = 'credit-b'").run();
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 1 });
      db.prepare("UPDATE usage_events SET credit = 0.99 WHERE event_id = 'credit-b'").run();
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("applies migration 010 to existing duplicate rows and stays idempotent", () => {
    const db = createDb();
    try {
      seedUsage(db, [
        usageSeed({ eventId: "history-a", sessionId: "history-parent", messageId: "old-message" }),
        usageSeed({ eventId: "history-b", sessionId: "history-fork", messageId: "old-message" })
      ]);
      db.exec(`
        DROP VIEW additive_usage_events;
        DROP INDEX idx_usage_events_workbuddy_message;
        DELETE FROM schema_migrations WHERE name = '010-deduplicate-inherited-workbuddy-usage';
      `);

      runDomainMigrations(db as unknown as SqliteDatabaseLike, "2026-10-26T12:00:00.000Z");
      expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 1 });
      expect(
        db.prepare("SELECT version, name FROM schema_migrations WHERE name = '010-deduplicate-inherited-workbuddy-usage'").get()
      ).toEqual({ version: 10, name: "010-deduplicate-inherited-workbuddy-usage" });

      runDomainMigrations(db as unknown as SqliteDatabaseLike, "2026-10-26T13:00:00.000Z");
      expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM additive_usage_events").get()).toEqual({ count: 1 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '010-deduplicate-inherited-workbuddy-usage'").get()
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
