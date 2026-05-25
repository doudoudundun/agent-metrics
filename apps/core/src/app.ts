import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import { buildOverviewMetrics } from "@agent-metrics/metrics-engine";

type MetricsStatement<Result = unknown> = {
  all(...params: unknown[]): Result[];
  get(...params: unknown[]): Result;
  run(...params: unknown[]): unknown;
};

type MetricsDatabase = {
  close(): void;
  exec(sql: string): unknown;
  prepare<Result = unknown>(sql: string): MetricsStatement<Result>;
};

type MetricsApp = ReturnType<typeof Fastify> & {
  db: MetricsDatabase;
};

export function resolveDefaultDbPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/sqlite/metrics.sqlite", moduleUrl));
}

export function buildApp(input: { dbPath: string }): MetricsApp {
  mkdirSync(dirname(input.dbPath), { recursive: true });

  const db = new Database(input.dbPath) as MetricsDatabase;

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_edits (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      insertions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      edit_operation_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const app = Fastify();

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/api/overview", async () => {
    const sessions = db.prepare<{ session_id: string; estimated_tokens: number }>(
      "SELECT session_id, estimated_tokens FROM sessions"
    ).all();
    const toolEvents = db.prepare<{ status: string; duration_ms: number | null }>(
      "SELECT status, duration_ms FROM tool_events"
    ).all();
    const codeEdits = db.prepare<{
      file_count: number;
      insertions: number;
      deletions: number;
      edit_operation_count: number;
    }>("SELECT file_count, insertions, deletions, edit_operation_count FROM code_edits").all();
    const estimatedTokens = sessions.reduce((sum, row) => sum + row.estimated_tokens, 0);

    return buildOverviewMetrics({
      sessions,
      toolEvents,
      codeEdits,
      estimatedTokens
    });
  });

  return Object.assign(app, { db });
}

export async function ingestEventLog(input: {
  app: MetricsApp;
  eventLogPath: string;
}): Promise<void> {
  const file = await readFile(input.eventLogPath, "utf8");
  const lines = file.trim().split("\n").filter(Boolean);
  const db = input.app.db;

  for (const line of lines) {
    const parsed = AnyEventSchema.parse(JSON.parse(line));

    if (parsed.type === "session.started") {
      db.prepare(
        "INSERT OR REPLACE INTO sessions (session_id, started_at, workspace_path, estimated_tokens) VALUES (?, ?, ?, 0)"
      ).run(parsed.session_id, parsed.timestamp, parsed.workspace_path);
    }

    if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
      db.prepare(
        "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.tool_name, parsed.status, parsed.duration_ms, parsed.timestamp);
    }

    if (parsed.type === "code.edit.applied") {
      db.prepare(
        "INSERT OR REPLACE INTO code_edits (event_id, session_id, tool_name, file_count, insertions, deletions, edit_operation_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        parsed.event_id,
        parsed.session_id,
        parsed.tool_name,
        parsed.file_count,
        parsed.insertions,
        parsed.deletions,
        parsed.edit_operation_count,
        parsed.timestamp
      );
    }
  }
}
