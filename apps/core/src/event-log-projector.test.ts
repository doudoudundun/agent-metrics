import { appendFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";
import { initializeLegacySchema } from "./legacy-schema.js";
import {
  ingestEventLog,
  readProjectionWatermark,
  type EventProjectorDatabase
} from "./event-log-projector.js";

function createDb(): EventProjectorDatabase {
  const db = new Database(":memory:") as unknown as EventProjectorDatabase;
  // ingestion_state (used by the incremental cursor) lives in the legacy schema,
  // so both schema layers must be present — same as buildApp() in production.
  initializeLegacySchema(db);
  runDomainMigrations(db as unknown as SqliteDatabaseLike);
  return db;
}

describe("event log projector watermarks", () => {
  it("reports the normalized event count as the projection watermark", () => {
    const db = createDb();
    expect(readProjectionWatermark(db)).toBe(0);

    db.prepare(
      `INSERT INTO normalized_events
        (event_id, schema_version, session_id, source_instance_id, timestamp, event_type, type,
         source_vendor, source_adapter, adapter_instance_id, source_record_namespace,
         source_record_id, workspace_path, semantic_fingerprint, payload_json, created_at)
       VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "event-1",
      "session-1",
      "claude:default",
      "2026-07-17T10:00:00.000Z",
      "session.started",
      "session.started",
      "claude-code",
      "claude-hook",
      "claude-hook@claude:default",
      "hook",
      "record-1",
      ".",
      "fp-1",
      "{}",
      "2026-07-17T10:00:00.000Z"
    );

    expect(readProjectionWatermark(db)).toBe(1);
    const sqlite = db as unknown as InstanceType<typeof Database>;
    expect(() => sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM normalized_events WHERE event_id = 'event-1'").run();
      expect(readProjectionWatermark(db)).toBe(0);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(readProjectionWatermark(db)).toBe(1);
    sqlite.prepare("DELETE FROM normalized_events WHERE event_id = 'event-1'").run();
    expect(readProjectionWatermark(db)).toBe(0);
    db.close();
  });

  it("persists committed byte offsets after projecting appended event-log records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-projector-watermark-"));
    const eventLogPath = join(root, "events.jsonl");
    const db = createDb();

    const firstLine = `${JSON.stringify({
      event_id: "evt-watermark-1",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: ".",
      type: "session.started"
    })}\n`;
    await writeFile(eventLogPath, firstLine, "utf8");

    await ingestEventLog({ db, eventLogPath });
    const firstSize = (await stat(eventLogPath)).size;
    expect(
      db
        .prepare<{ offsetBytes: number; sizeBytes: number }>(
          "SELECT offset_bytes AS offsetBytes, size_bytes AS sizeBytes FROM ingestion_state WHERE stream_name = 'events.jsonl'"
        )
        .get()
    ).toMatchObject({
      offsetBytes: firstSize,
      sizeBytes: firstSize
    });
    expect(readProjectionWatermark(db)).toBeGreaterThan(0);

    const secondLine = `${JSON.stringify({
      event_id: "evt-watermark-2",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: ".",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 10
    })}\n`;
    await appendFile(eventLogPath, secondLine, "utf8");

    const watermarkBefore = readProjectionWatermark(db);
    await ingestEventLog({ db, eventLogPath });
    const secondSize = (await stat(eventLogPath)).size;

    expect(readProjectionWatermark(db)).toBeGreaterThanOrEqual(watermarkBefore);
    expect(
      db
        .prepare<{ offsetBytes: number }>(
          "SELECT offset_bytes AS offsetBytes FROM ingestion_state WHERE stream_name = 'events.jsonl'"
        )
        .get()
    ).toMatchObject({ offsetBytes: secondSize });

    db.close();
  });

  it("replays projected events idempotently after an externally reset cursor (spec section 11)", async () => {
    // event_id / semantic_fingerprint idempotency keeps counts stable if an old
    // installation has a cursor that was reset outside the projector transaction.
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-projector-partial-commit-"));
    const eventLogPath = join(root, "events.jsonl");
    const db = createDb();

    const line = `${JSON.stringify({
      event_id: "evt-partial-1",
      session_id: "session-partial",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: ".",
      type: "token.usage.recorded",
      message_id: "msg-partial-1",
      model: "sonnet",
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20,
      server_tool_use: "{}",
      usage_source: "claude-transcript",
      provider_id: "anthropic",
      provider_base_url: null,
      provider_host: "api.anthropic.com"
    })}\n`;
    await writeFile(eventLogPath, line, "utf8");

    // First ingest: projection commits, cursor advances.
    await ingestEventLog({ db, eventLogPath });
    const watermarkAfterFirst = readProjectionWatermark(db);
    expect(watermarkAfterFirst).toBeGreaterThan(0);
    const usageAfterFirst = db
      .prepare<{ count: number; total: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(displayed_input_tokens), 0) AS total FROM usage_events"
      )
      .get();
    expect(usageAfterFirst).toMatchObject({ count: 1, total: 100 });

    // Simulate the crash: rollback the cursor write only. The projection rows remain.
    db.prepare(
      "UPDATE ingestion_state SET offset_bytes = 0, committed_prefix_hash = NULL WHERE stream_name = 'events.jsonl'"
    ).run();

    // Second ingest replays the same record. Counts MUST stay stable.
    await ingestEventLog({ db, eventLogPath });
    expect(readProjectionWatermark(db)).toBe(watermarkAfterFirst);
    const usageAfterReplay = db
      .prepare<{ count: number; total: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(displayed_input_tokens), 0) AS total FROM usage_events"
      )
      .get();
    expect(usageAfterReplay).toMatchObject({ count: 1, total: 100 });

    // The cursor is advanced again after the safe replay.
    const fileSize = (await stat(eventLogPath)).size;
    expect(
      db
        .prepare<{ offsetBytes: number }>(
          "SELECT offset_bytes AS offsetBytes FROM ingestion_state WHERE stream_name = 'events.jsonl'"
        )
        .get()
    ).toMatchObject({ offsetBytes: fileSize });

    db.close();
  });

  it("rolls back projection and diagnostics when the cursor write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-projector-atomic-"));
    const eventLogPath = join(root, "events.jsonl");
    const db = failCursorWrite(createDb());
    await writeFile(
      eventLogPath,
      `${JSON.stringify({
        event_id: "evt-atomic-1",
        session_id: "session-atomic",
        timestamp: "2026-07-17T10:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: ".",
        type: "session.started"
      })}\nnot-json\n`,
      "utf8"
    );

    await expect(ingestEventLog({ db, eventLogPath })).rejects.toThrow("cursor write failed");
    expect(readProjectionWatermark(db)).toBe(0);
    expect(
      db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM event_diagnostics").get().count
    ).toBe(0);
    expect(
      db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM ingestion_state").get().count
    ).toBe(0);

    (db as unknown as InstanceType<typeof Database>).close();
  });
});

function failCursorWrite(db: EventProjectorDatabase): EventProjectorDatabase {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (<Row = unknown>(sql: string) => {
    const statement = originalPrepare<Row>(sql);
    if (!sql.includes("INSERT INTO ingestion_state")) {
      return statement;
    }
    return {
      all: (...params: unknown[]) => statement.all(...params),
      get: (...params: unknown[]) => statement.get(...params),
      run: () => {
        throw new Error("cursor write failed");
      }
    };
  }) as EventProjectorDatabase["prepare"];
  return db;
}
