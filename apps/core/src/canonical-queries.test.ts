import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { selectWidgetSnapshot } from "./canonical-queries.js";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";

function expectQueryPlanUsesIndex(
  db: SqliteDatabaseLike,
  sql: string,
  indexName: string,
  params: unknown[] = []
): void {
  const plan = db
    .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
  expect(plan).toContain(indexName);
}

describe("canonical widget queries", () => {
  it("aggregates only incremental usage and logical tool calls in the calendar day window", () => {
    const db = new Database(":memory:") as unknown as SqliteDatabaseLike;
    runDomainMigrations(db, "2026-07-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO domain_sessions
        (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "claude:default",
      "session-1",
      "claude-code",
      "claude-transcript",
      "D:/workspace",
      "2026-07-16T12:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO usage_events
        (event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
         occurred_at, model_id, provider_id, input_token_semantics, usage_measurement,
         raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint)
       VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, 'delta', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "usage-1",
      "claude:default",
      "claude-code",
      "session-1",
      "message-1",
      "2026-07-16T13:00:00.000Z",
      "claude-sonnet",
      "unknown",
      "increment",
      10,
      10,
      4,
      2,
      3,
      "{}",
      "claude-transcript",
      "fingerprint-1"
    );
    db.prepare(
      `INSERT INTO usage_events
        (event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
         occurred_at, model_id, provider_id, input_token_semantics, usage_measurement,
         raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint)
       VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, 'delta', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "usage-snapshot",
      "claude:default",
      "claude-code",
      "session-1",
      "message-2",
      "2026-07-16T14:00:00.000Z",
      "claude-sonnet",
      "unknown",
      "session-context-snapshot",
      100,
      100,
      100,
      0,
      0,
      "{}",
      "cursor-composer-context",
      "fingerprint-snapshot"
    );
    db.prepare(
      `INSERT INTO tool_calls
        (source_instance_id, session_id, tool_call_id, tool_name, started_at, finished_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "claude:default",
      "session-1",
      "native:tool-1",
      "Read",
      "2026-07-16T13:01:00.000Z",
      "2026-07-16T13:01:01.000Z",
      "succeeded"
    );

    // UTC calendar day 2026-07-16 so fixtures above fall inside the window.
    const result = selectWidgetSnapshot(db, new Date("2026-07-16T18:00:00.000Z"), {
      offsetMinutes: 0
    });

    expect(result.scope).toMatchObject({
      mode: "calendar",
      range: "day"
    });
    expect(result.metrics).toMatchObject({
      totalTokens: 19,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      sessionCount: 1,
      logicalToolCalls: 1,
      cacheHitRate: 3 / 15,
      toolSuccessRate: 1,
      editOperationCount: 0,
      affectedFileCount: 0
    });
    db.close();
  });

  it("computes toolSuccessRate from terminal outcomes only, not started-only rows", () => {
    const db = new Database(":memory:") as unknown as SqliteDatabaseLike;
    runDomainMigrations(db, "2026-07-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO domain_sessions
        (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "opencode:default",
      "session-tools",
      "opencode",
      "opencode-sqlite",
      "D:/workspace",
      "2026-07-16T12:00:00.000Z"
    );

    const insertTool = db.prepare(
      `INSERT INTO tool_calls
        (source_instance_id, session_id, tool_call_id, tool_name, started_at, finished_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    // 2 succeeded, 1 failed, 7 started-only → logicalToolCalls=10 but rate = 2/3.
    insertTool.run(
      "opencode:default",
      "session-tools",
      "native:ok-1",
      "Read",
      "2026-07-16T13:00:00.000Z",
      "2026-07-16T13:00:01.000Z",
      "succeeded"
    );
    insertTool.run(
      "opencode:default",
      "session-tools",
      "native:ok-2",
      "Bash",
      "2026-07-16T13:01:00.000Z",
      "2026-07-16T13:01:02.000Z",
      "succeeded"
    );
    insertTool.run(
      "opencode:default",
      "session-tools",
      "native:fail-1",
      "Bash",
      "2026-07-16T13:02:00.000Z",
      "2026-07-16T13:02:03.000Z",
      "failed"
    );
    for (let index = 0; index < 7; index += 1) {
      insertTool.run(
        "opencode:default",
        "session-tools",
        `native:started-${index}`,
        "Edit",
        `2026-07-16T13:1${index}:00.000Z`,
        null,
        "started"
      );
    }

    const result = selectWidgetSnapshot(db, new Date("2026-07-16T18:00:00.000Z"), {
      offsetMinutes: 0
    });

    expect(result.metrics.logicalToolCalls).toBe(10);
    expect(result.metrics.toolSuccessRate).toBeCloseTo(2 / 3, 5);
    db.close();
  });

  it("uses the named indexes required for widget snapshot high-volume reads", () => {
    const db = new Database(":memory:") as unknown as SqliteDatabaseLike;
    runDomainMigrations(db, "2026-07-17T00:00:00.000Z");
    // Seed enough rows with spread timestamps for ANALYZE to prefer an index seek
    // over a full SCAN. A bounded 30-minute window covers a small slice of the
    // data, mirroring the rolling 24-hour widget snapshot read pattern.
    const baseMs = Date.parse("2026-07-16T00:00:00.000Z");
    const windowStart = "2026-07-16T12:30:00.000Z";
    const windowEnd = "2026-07-16T13:00:00.000Z";

    const insertSession = db.prepare(
      `INSERT INTO domain_sessions
        (source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertUsage = db.prepare(
      `INSERT INTO usage_events
        (event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
         occurred_at, model_id, provider_id, input_token_semantics, usage_measurement,
         raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint)
       VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, 'delta', 'increment', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTool = db.prepare(
      `INSERT INTO tool_calls
        (source_instance_id, session_id, tool_call_id, tool_name, started_at, finished_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEdit = db.prepare(
      `INSERT INTO normalized_events
        (event_id, schema_version, session_id, source_instance_id, timestamp, event_type, type,
         source_vendor, source_adapter, adapter_instance_id, source_record_namespace,
         source_record_id, workspace_path, semantic_fingerprint, payload_json, created_at)
       VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < 200; i += 1) {
      const ts = new Date(baseMs + i * 5 * 60_000).toISOString();
      insertSession.run("claude:default", `session-${i}`, "claude-code", "claude-transcript", ".", ts);
      insertUsage.run(
        `usage-${i}`, "claude:default", "claude-code", `session-${i}`, `message-${i}`,
        ts, "claude-sonnet", "unknown",
        10, 10, 4, 2, 3, "{}", "claude-transcript", `fingerprint-${i}`
      );
      insertTool.run(
        "claude:default", `session-${i}`, `native:tool-${i}`, "Read",
        ts, new Date(baseMs + i * 5 * 60_000 + 1000).toISOString(), "succeeded"
      );
      insertEdit.run(
        `edit-${i}`, `session-${i}`, "claude:default", ts,
        "code.edit.applied", "code.edit.applied", "claude-code", "claude-hook",
        "claude-hook@claude:default", "hook", `edit-record-${i}`, ".", `fp-edit-${i}`,
        '{"edit_operation_count":1,"files_changed":[]}', ts
      );
    }
    db.exec("ANALYZE;");

    expectQueryPlanUsesIndex(
      db,
      `SELECT COUNT(*) AS count
       FROM domain_sessions
       WHERE started_at >= ? AND started_at < ?`,
      "idx_domain_sessions_source_started_at",
      [windowStart, windowEnd]
    );
    expectQueryPlanUsesIndex(
      db,
      `SELECT
         displayed_input_tokens AS displayedInputTokens,
         output_tokens AS outputTokens,
         cache_read_input_tokens AS cacheReadTokens,
         cache_creation_input_tokens AS cacheCreationTokens,
         usage_source AS usageSource,
         occurred_at AS occurredAt
       FROM usage_events
       WHERE occurred_at >= ? AND occurred_at < ?
         AND usage_measurement = 'increment'`,
      "idx_usage_events_occurred_at",
      [windowStart, windowEnd]
    );
    // Matches the production widget snapshot query, which filters on started_at
    // across all sources. The single-column idx_tool_calls_started_at index serves
    // this aggregate (the composite idx_tool_calls_source_session_started index
    // requires source_instance_id/session_id leading columns that the widget roll-up
    // does not constrain).
    expectQueryPlanUsesIndex(
      db,
      `SELECT status
       FROM tool_calls
       WHERE started_at >= ? AND started_at < ?`,
      "idx_tool_calls_started_at",
      [windowStart, windowEnd]
    );
    expectQueryPlanUsesIndex(
      db,
      `SELECT payload_json AS payloadJson
       FROM normalized_events
       WHERE event_type = 'code.edit.applied'
         AND timestamp >= ? AND timestamp < ?`,
      "idx_normalized_events_type_timestamp",
      [windowStart, windowEnd]
    );

    db.close();
  });
});
