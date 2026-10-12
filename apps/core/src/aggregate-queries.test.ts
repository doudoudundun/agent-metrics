import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { selectTokensByModel } from "./aggregate-queries.js";
import type { MetricsDatabase } from "./core-types.js";

function createDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
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
      created_at TEXT NOT NULL
    );
    CREATE TABLE usage_events (
      event_id TEXT PRIMARY KEY,
      source_instance_id TEXT NOT NULL,
      adapter_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT,
      occurred_at TEXT NOT NULL,
      model_id TEXT,
      source_vendor TEXT NOT NULL,
      usage_source TEXT NOT NULL,
      raw_input_tokens INTEGER NOT NULL,
      displayed_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      input_token_semantics TEXT NOT NULL,
      usage_measurement TEXT NOT NULL,
      first_token_latency_ms INTEGER,
      decode_duration_ms INTEGER
    );
  `);
  return db;
}

describe("selectTokensByModel", () => {
  it("merges canonical timing into legacy model rows as weighted tok/s and mean TTFT", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO token_usage_events VALUES
        ('legacy-1', 'ses-1', 'msg-1', 'glm-5.3', 100, 40, 0, 0, '{}',
         'opencode-step-finish', 'zcode', 'zcode-db', '2026-10-09T10:00:00.000Z');
      INSERT INTO usage_events (
        event_id, source_instance_id, adapter_instance_id, session_id, message_id,
        occurred_at, model_id, source_vendor, usage_source,
        raw_input_tokens, displayed_input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens,
        input_token_semantics, usage_measurement,
        first_token_latency_ms, decode_duration_ms
      ) VALUES
        ('u1', 'zcode:default', 'zcode:default:zcode-db', 'ses-1', 'msg-1',
         '2026-10-09T10:00:00.000Z', 'glm-5.3', 'zcode', 'opencode-step-finish',
         100, 100, 40, 0, 0, 'gross', 'increment', 500, 4000),
        ('u2', 'zcode:default', 'zcode:default:zcode-db', 'ses-1', 'msg-2',
         '2026-10-09T10:01:00.000Z', 'glm-5.3', 'zcode', 'opencode-step-finish',
         100, 100, 20, 0, 0, 'gross', 'increment', 700, 2000),
        -- session-context snapshots are excluded from speed aggregation
        ('u3', 'zcode:default', 'zcode:default:zcode-db', 'ses-1', 'msg-3',
         '2026-10-09T10:02:00.000Z', 'glm-5.3', 'zcode', 'opencode-step-finish',
         100, 100, 999, 0, 0, 'gross', 'session-context-snapshot', 100, 100),
        -- rows without timing do not drag the averages down
        ('u4', 'zcode:default', 'zcode:default:zcode-db', 'ses-1', 'msg-4',
         '2026-10-09T10:03:00.000Z', 'glm-5.3', 'zcode', 'opencode-step-finish',
         100, 100, 999, 0, 0, 'gross', 'increment', NULL, NULL);
    `);

    const rows = selectTokensByModel(db as unknown as MetricsDatabase);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "glm-5.3",
      sourceVendor: "zcode",
      // (40 + 20) output tokens over (4000 + 2000) ms => 10 tok/s
      avgOutputTokensPerSecond: 10,
      // mean of 500 and 700
      avgFirstTokenLatencyMs: 600
    });

    db.close();
  });

  it("returns null timing when the canonical table predates migration 006", () => {
    const db = new Database(":memory:");
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
        created_at TEXT NOT NULL
      );
      CREATE TABLE usage_events (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        model_id TEXT,
        source_vendor TEXT NOT NULL,
        usage_source TEXT NOT NULL,
        output_tokens INTEGER NOT NULL,
        usage_measurement TEXT NOT NULL
      );
      INSERT INTO token_usage_events VALUES
        ('legacy-1', 'ses-1', 'msg-1', 'sonnet', 100, 40, 0, 0, '{}',
         'claude-transcript', 'claude-code', 'claude-transcript', '2026-10-09T10:00:00.000Z');
    `);

    const rows = selectTokensByModel(db as unknown as MetricsDatabase);

    expect(rows).toHaveLength(1);
    expect(rows[0].avgOutputTokensPerSecond).toBeNull();
    expect(rows[0].avgFirstTokenLatencyMs).toBeNull();

    db.close();
  });
});
