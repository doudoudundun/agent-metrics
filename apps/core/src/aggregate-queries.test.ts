import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  selectOverviewRows,
  selectTokenUsageRows,
  selectTokensByModel
} from "./aggregate-queries.js";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";
import type { MetricsDatabase } from "./core-types.js";
import type { ResolvedTimeScope } from "./time-scope.js";

type UsageSeed = {
  eventId: string;
  sessionId: string;
  occurredAt: string;
  model: string | null;
  sourceVendor: string;
  displayedInputTokens: number;
  rawInputTokens?: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  inputTokenSemantics?: "delta" | "gross";
  usageMeasurement?: "increment" | "session-context-snapshot";
  usageSource?: string;
  /** Accelerated speed tier served; NULL/undefined means standard pricing. */
  serviceTier?: string | null;
  providerId?: string;
  providerHost?: string | null;
  decodeDurationMs?: number | null;
  firstTokenLatencyMs?: number | null;
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  runDomainMigrations(db as unknown as SqliteDatabaseLike, "2026-10-09T00:00:00.000Z");
  return db;
}

type UsageSeedInput = Partial<UsageSeed> &
  Pick<UsageSeed, "eventId" | "displayedInputTokens" | "outputTokens">;

function usageSeed(input: UsageSeedInput): UsageSeed {
  return {
    eventId: input.eventId,
    displayedInputTokens: input.displayedInputTokens,
    outputTokens: input.outputTokens,
    sessionId: input.sessionId ?? "ses-1",
    occurredAt: input.occurredAt ?? "2026-10-09T10:00:00.000Z",
    model: input.model ?? "glm-5.3",
    sourceVendor: input.sourceVendor ?? "zcode",
    usageSource: input.usageSource ?? "opencode-step-finish",
    inputTokenSemantics: input.inputTokenSemantics ?? "gross",
    rawInputTokens: input.rawInputTokens ?? input.displayedInputTokens,
    usageMeasurement: input.usageMeasurement ?? "increment",
    serviceTier: input.serviceTier ?? null,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheCreationTokens: input.cacheCreationTokens ?? 0,
    providerId: input.providerId ?? "unknown",
    providerHost: input.providerHost ?? null,
    decodeDurationMs: input.decodeDurationMs ?? null,
    firstTokenLatencyMs: input.firstTokenLatencyMs ?? null
  };
}

function seedUsage(db: InstanceType<typeof Database>, seeds: UsageSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO usage_events (
      event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
      occurred_at, model_id, provider_id, provider_host, input_token_semantics, usage_measurement,
      raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, first_token_latency_ms, decode_duration_ms,
      server_tool_use, usage_source, service_tier, semantic_fingerprint
    ) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
  `);

  for (const seed of seeds) {
    insert.run(
      seed.eventId,
      `${seed.sourceVendor}:default`,
      seed.sourceVendor,
      seed.sessionId,
      `msg-${seed.eventId}`,
      seed.occurredAt,
      seed.model,
      seed.providerId ?? "unknown",
      seed.providerHost ?? null,
      seed.inputTokenSemantics ?? "delta",
      seed.usageMeasurement ?? "increment",
      seed.rawInputTokens ?? seed.displayedInputTokens,
      seed.displayedInputTokens,
      seed.outputTokens,
      seed.cacheCreationTokens ?? 0,
      seed.cacheReadTokens ?? 0,
      seed.firstTokenLatencyMs ?? null,
      seed.decodeDurationMs ?? null,
      seed.usageSource ?? "claude-transcript",
      seed.serviceTier ?? null,
      `fp-${seed.eventId}`
    );
  }
}

function customScope(windowStart: string, windowEnd: string): ResolvedTimeScope {
  return { mode: "custom", range: null, timezone: "UTC", windowStart, windowEnd };
}

describe("selectTokensByModel", () => {
  it("folds tokens and timing per (source vendor, model) from usage_events alone", () => {
    const db = createDb();
    seedUsage(db, [
      usageSeed({
        eventId: "u1",
        occurredAt: "2026-10-09T10:00:00.000Z",
        displayedInputTokens: 100,
        outputTokens: 40,
        decodeDurationMs: 4000,
        firstTokenLatencyMs: 500
      }),
      usageSeed({
        eventId: "u2",
        occurredAt: "2026-10-09T10:01:00.000Z",
        displayedInputTokens: 100,
        outputTokens: 20,
        decodeDurationMs: 2000,
        firstTokenLatencyMs: 700
      }),
      // session-context snapshots stay out of token totals and speed aggregation
      usageSeed({
        eventId: "u3",
        occurredAt: "2026-10-09T10:02:00.000Z",
        displayedInputTokens: 100,
        outputTokens: 999,
        usageSource: "cursor-composer-context",
        inputTokenSemantics: "delta",
        usageMeasurement: "session-context-snapshot",
        decodeDurationMs: 100,
        firstTokenLatencyMs: 100
      }),
      // rows without timing do not drag the averages down
      usageSeed({
        eventId: "u4",
        occurredAt: "2026-10-09T10:03:00.000Z",
        displayedInputTokens: 100,
        outputTokens: 999
      })
    ]);

    const rows = selectTokensByModel(db as unknown as MetricsDatabase);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "glm-5.3",
      sourceVendor: "zcode",
      inputTokens: 300,
      outputTokens: 1059,
      totalTokens: 1359,
      // (40 + 20) output tokens over (4000 + 2000) ms => 10 tok/s
      avgOutputTokensPerSecond: 10,
      // mean of 500 and 700
      avgFirstTokenLatencyMs: 600
    });

    db.close();
  });

  it("reports null timing when no usage row carried one", () => {
    const db = createDb();
    seedUsage(db, [
      usageSeed({
        eventId: "u1",
        sourceVendor: "claude-code",
        model: "sonnet",
        usageSource: "claude-transcript",
        inputTokenSemantics: "delta",
        displayedInputTokens: 100,
        outputTokens: 40
      })
    ]);

    const rows = selectTokensByModel(db as unknown as MetricsDatabase);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "sonnet", inputTokens: 100, totalTokens: 140 });
    expect(rows[0]?.avgOutputTokensPerSecond).toBeNull();
    expect(rows[0]?.avgFirstTokenLatencyMs).toBeNull();

    db.close();
  });

  it("drops models whose only usage rows are session-context snapshots", () => {
    const db = createDb();
    seedUsage(db, [
      usageSeed({
        eventId: "snapshot-1",
        sourceVendor: "cursor",
        model: "composer-2",
        usageSource: "cursor-composer-context",
        inputTokenSemantics: "delta",
        usageMeasurement: "session-context-snapshot",
        displayedInputTokens: 2500,
        outputTokens: 999
      })
    ]);

    expect(selectTokensByModel(db as unknown as MetricsDatabase)).toEqual([]);

    db.close();
  });

  it("keeps one row per (source vendor, model) and prices displayed input tokens", () => {
    const db = createDb();
    seedUsage(db, [
      usageSeed({
        eventId: "u1",
        sourceVendor: "opencode",
        sessionId: "ses-open",
        model: "hy3-preview-free",
        usageSource: "opencode-step-finish",
        inputTokenSemantics: "gross",
        rawInputTokens: 27470,
        displayedInputTokens: 25422,
        cacheReadTokens: 2048,
        outputTokens: 207
      }),
      usageSeed({
        eventId: "u2",
        sourceVendor: "opencode",
        sessionId: "ses-open",
        occurredAt: "2026-10-09T10:01:00.000Z",
        model: "gpt-5.4",
        usageSource: "opencode-step-finish",
        inputTokenSemantics: "gross",
        displayedInputTokens: 10,
        outputTokens: 1
      }),
      usageSeed({
        eventId: "u3",
        sourceVendor: "codex",
        sessionId: "ses-codex",
        model: "hy3-preview-free",
        usageSource: "codex-rollout",
        inputTokenSemantics: "gross",
        displayedInputTokens: 5,
        outputTokens: 0
      })
    ]);

    const rows = selectTokensByModel(db as unknown as MetricsDatabase);

    expect(
      rows.map((row) => [row.sourceVendor, row.model, row.inputTokens, row.cacheReadTokens, row.totalTokens])
    ).toEqual([
      ["opencode", "hy3-preview-free", 25422, 2048, 27677],
      ["opencode", "gpt-5.4", 10, 0, 11],
      ["codex", "hy3-preview-free", 5, 0, 5]
    ]);

    db.close();
  });
});

describe("selectTokenUsageRows", () => {
  it("hands over display-normalized rows tagged delta for incremental usage only", () => {
    const db = createDb();
    seedUsage(db, [
      usageSeed({
        eventId: "u1",
        sourceVendor: "opencode",
        usageSource: "opencode-step-finish",
        inputTokenSemantics: "gross",
        rawInputTokens: 27470,
        displayedInputTokens: 25422,
        cacheReadTokens: 2048,
        outputTokens: 207
      }),
      usageSeed({
        eventId: "snapshot-1",
        sourceVendor: "cursor",
        model: "composer-2",
        usageSource: "cursor-composer-context",
        inputTokenSemantics: "delta",
        usageMeasurement: "session-context-snapshot",
        displayedInputTokens: 2500,
        outputTokens: 999
      })
    ]);

    const rows = selectTokenUsageRows(db as unknown as MetricsDatabase);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // raw_input_tokens (27470) must not leak into the aggregate layer: the
      // projection already subtracted the cache reads.
      input_tokens: 25422,
      input_token_semantics: "delta",
      usage_measurement: "increment",
      usage_source: "opencode-step-finish"
    });

    db.close();
  });
});

describe("selectOverviewRows", () => {
  it("reads sessions, events, tool counts, usage and edit stats from the canonical tables", () => {
    const db = createDb();
    const sourceInstanceId = "claude:default";
    db.prepare(
      `INSERT INTO domain_sessions
        (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at)
       VALUES (?, ?, 'claude-code', 'claude-transcript', '/workspace', ?)`
    ).run(sourceInstanceId, "session-in", "2026-10-09T01:00:00.000Z");
    db.prepare(
      `INSERT INTO domain_sessions
        (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at)
       VALUES (?, ?, 'claude-code', 'claude-transcript', '/workspace', ?)`
    ).run(sourceInstanceId, "session-out", "2026-10-08T01:00:00.000Z");

    const insertEvent = db.prepare(
      `INSERT INTO normalized_events (
        event_id, schema_version, session_id, source_instance_id, timestamp, type, event_type,
        source_vendor, source_record_namespace, workspace_path, semantic_fingerprint, payload_json
      ) VALUES (?, 2, ?, ?, ?, ?, ?, 'claude-code', 'claude', '/workspace', ?, ?)`
    );
    const insertPrompt = (eventId: string, sessionId: string, timestamp: string): void => {
      insertEvent.run(
        eventId,
        sessionId,
        sourceInstanceId,
        timestamp,
        "prompt.submitted",
        "prompt.submitted",
        `fp-${eventId}`,
        JSON.stringify({ type: "prompt.submitted", prompt_id: eventId, prompt_chars: 12 })
      );
    };
    insertPrompt("prompt-1", "session-in", "2026-10-09T01:05:00.000Z");
    insertPrompt("prompt-2", "session-in", "2026-10-09T01:06:00.000Z");
    // Outside the window: the overview must not count it.
    insertPrompt("prompt-old", "session-out", "2026-10-08T01:05:00.000Z");

    insertEvent.run(
      "response-1",
      "session-in",
      sourceInstanceId,
      "2026-10-09T01:07:00.000Z",
      "assistant.responded",
      "assistant.responded",
      "fp-response-1",
      JSON.stringify({ type: "assistant.responded", message_id: "msg-1", model: "sonnet", response_chars: 5 })
    );

    insertEvent.run(
      "edit-1",
      "session-in",
      sourceInstanceId,
      "2026-10-09T01:08:00.000Z",
      "code.edit.applied",
      "code.edit.applied",
      "fp-edit-1",
      JSON.stringify({
        type: "code.edit.applied",
        tool_name: "Edit",
        files_changed: ["src/app.ts", "src/index.ts"],
        file_count: 2,
        insertions: 12,
        deletions: 4,
        edit_operation_count: 1
      })
    );

    const insertToolCall = db.prepare(
      `INSERT INTO tool_calls (
        source_instance_id, session_id, tool_call_id, tool_name, started_at, finished_at, status, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertToolCall.run(
      sourceInstanceId,
      "session-in",
      "tool-1",
      "Read",
      "2026-10-09T01:10:00.000Z",
      "2026-10-09T01:10:00.014Z",
      "succeeded",
      14
    );
    insertToolCall.run(
      sourceInstanceId,
      "session-in",
      "tool-2",
      "Write",
      null,
      "2026-10-09T01:11:00.000Z",
      "failed",
      21
    );
    insertToolCall.run(
      sourceInstanceId,
      "session-in",
      "tool-3",
      "Grep",
      "2026-10-09T01:12:00.000Z",
      null,
      "started",
      null
    );

    seedUsage(db, [
      usageSeed({
        eventId: "usage-1",
        sessionId: "session-in",
        sourceVendor: "claude-code",
        usageSource: "claude-transcript",
        inputTokenSemantics: "delta",
        displayedInputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 1,
        occurredAt: "2026-10-09T01:09:00.000Z"
      }),
      usageSeed({
        eventId: "snapshot-1",
        sessionId: "session-in",
        sourceVendor: "cursor",
        usageSource: "cursor-composer-context",
        inputTokenSemantics: "delta",
        usageMeasurement: "session-context-snapshot",
        displayedInputTokens: 2500,
        outputTokens: 999,
        occurredAt: "2026-10-09T01:09:30.000Z"
      })
    ]);

    const rows = selectOverviewRows(
      db as unknown as MetricsDatabase,
      customScope("2026-10-09T00:00:00.000Z", "2026-10-09T12:00:00.000Z")
    );

    expect(rows.sessions.map((row) => row.session_id)).toEqual(["session-in"]);
    expect(rows.toolCounts).toEqual({
      successfulExecutions: 1,
      failedExecutions: 1,
      startedOnlyExecutions: 1
    });
    expect(rows.prompts).toHaveLength(2);
    expect(rows.responses).toHaveLength(1);
    expect(rows.codeEdits).toEqual([
      {
        files_changed: ["src/app.ts", "src/index.ts"],
        file_count: 2,
        insertions: 12,
        deletions: 4,
        edit_operation_count: 1
      }
    ]);
    // Only the incremental usage row survives the snapshot filter.
    expect(rows.tokenUsage).toHaveLength(1);
    expect(rows.tokenUsage[0]).toMatchObject({ input_tokens: 10, source_vendor: "claude-code" });

    const codexRows = selectOverviewRows(
      db as unknown as MetricsDatabase,
      customScope("2026-10-09T00:00:00.000Z", "2026-10-09T12:00:00.000Z"),
      "codex"
    );
    expect(codexRows.sessions).toEqual([]);
    expect(codexRows.toolCounts).toEqual({
      successfulExecutions: 0,
      failedExecutions: 0,
      startedOnlyExecutions: 0
    });
    expect(codexRows.codeEdits).toEqual([]);

    db.close();
  });
});

describe("selectTokensByModel service tiers", () => {
  it("keeps an accelerated tier as its own row, priced at its multiplier", () => {
    const db = createDb();
    const row = (eventId: string, serviceTier: string | null) =>
      usageSeed({
        eventId,
        occurredAt: "2026-10-09T10:00:00.000Z",
        model: "gpt-6.1-sol",
        sourceVendor: "codex",
        usageSource: "codex-rollout",
        displayedInputTokens: 1_000_000,
        outputTokens: 0,
        serviceTier
      });

    // "standard" spelled out must fold into the unset rows, not form a third one.
    seedUsage(db, [row("std", null), row("fast", "fast"), row("std-spelled", "standard")]);
    const rows = selectTokensByModel(
      db as unknown as MetricsDatabase,
      customScope("2026-10-09T00:00:00.000Z", "2026-10-09T12:00:00.000Z")
    );

    // $2/1M standard input for gpt-6.1-sol: two list-price rows plus one 2x row.
    expect(rows).toHaveLength(2);
    const standardRow = rows.find((entry) => entry.serviceTier === null);
    const fastRow = rows.find((entry) => entry.serviceTier === "fast");
    expect(standardRow?.totalTokens).toBe(2_000_000);
    expect(standardRow?.costUsd).toBeCloseTo(4, 9);
    expect(standardRow?.serviceTierMultiplier).toBe(1);
    expect(fastRow?.totalTokens).toBe(1_000_000);
    expect(fastRow?.costUsd).toBeCloseTo(4, 9);
    expect(fastRow?.serviceTierMultiplier).toBe(2);

    db.close();
  });

  it("keeps cost null when only unpriced models report an accelerated tier", () => {
    const db = createDb();
    seedUsage(db, [
      usageSeed({
        eventId: "unpriced-fast",
        occurredAt: "2026-10-09T10:00:00.000Z",
        model: "hunyuan-chat",
        sourceVendor: "workbuddy",
        usageSource: "workbuddy-usage",
        displayedInputTokens: 500,
        outputTokens: 50,
        serviceTier: "ultrafast"
      })
    ]);

    const [row] = selectTokensByModel(
      db as unknown as MetricsDatabase,
      customScope("2026-10-09T00:00:00.000Z", "2026-10-09T12:00:00.000Z")
    );
    expect(row.costUsd).toBeNull();

    db.close();
  });
});
