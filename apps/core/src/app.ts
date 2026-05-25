import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AnyEventSchema } from "@agent-metrics/event-schema";

type MetricsApp = ReturnType<typeof Fastify> & {
  db: Database.Database;
};

export function resolveDefaultDbPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/sqlite/metrics.sqlite", moduleUrl));
}

export function buildApp(input: { dbPath: string }): MetricsApp {
  mkdirSync(dirname(input.dbPath), { recursive: true });

  const db = new Database(input.dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
  `);

  const app = Fastify();

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/api/overview", async () => {
    const sessionCount = Number(
      (db.prepare("SELECT COUNT(*) AS value FROM sessions").get() as { value: number }).value
    );
    const totalToolCalls = Number(
      (db.prepare("SELECT COUNT(*) AS value FROM tool_events").get() as { value: number }).value
    );
    const successfulExecutions = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS value FROM tool_events WHERE status = 'succeeded'")
          .get() as { value: number }
      ).value
    );

    return {
      sessionCount,
      totalToolCalls,
      successfulExecutions
    };
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
        "INSERT OR REPLACE INTO sessions (session_id, started_at, workspace_path) VALUES (?, ?, ?)"
      ).run(parsed.session_id, parsed.timestamp, parsed.workspace_path);
    }

    if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
      db.prepare(
        "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.tool_name, parsed.status, parsed.duration_ms, parsed.timestamp);
    }
  }
}
