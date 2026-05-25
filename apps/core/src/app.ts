import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import { toCsv, toJson } from "@agent-metrics/export-kit";
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

type SessionOverviewRow = {
  session_id: string;
  estimated_tokens: number;
};

type ToolEventOverviewRow = {
  status: string;
  duration_ms: number | null;
};

type CodeEditOverviewRow = {
  file_count: number;
  insertions: number;
  deletions: number;
  edit_operation_count: number;
};

type ToolRankingRow = {
  toolName: string;
  count: number;
  failures: number;
  averageDurationMs: number;
};

type SessionListRow = {
  sessionId: string;
  workspacePath: string;
};

type SessionTimelineRow = {
  toolName: string;
  status: string;
  durationMs: number;
};

const TOOL_RANKING_QUERY = `
  SELECT
    tool_name AS toolName,
    COUNT(*) AS count,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
    COALESCE(CAST(AVG(duration_ms) AS INTEGER), 0) AS averageDurationMs
  FROM tool_events
  GROUP BY tool_name
  ORDER BY count DESC, toolName ASC
`;

export function resolveDefaultDbPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/sqlite/metrics.sqlite", moduleUrl));
}

function selectOverviewRows(db: MetricsDatabase): {
  sessions: SessionOverviewRow[];
  toolEvents: ToolEventOverviewRow[];
  codeEdits: CodeEditOverviewRow[];
  estimatedTokens: number;
} {
  const sessions = db
    .prepare<SessionOverviewRow>("SELECT session_id, estimated_tokens FROM sessions")
    .all();
  const toolEvents = db
    .prepare<ToolEventOverviewRow>("SELECT status, duration_ms FROM tool_events")
    .all();
  const codeEdits = db
    .prepare<CodeEditOverviewRow>(
      "SELECT file_count, insertions, deletions, edit_operation_count FROM code_edits"
    )
    .all();

  return {
    sessions,
    toolEvents,
    codeEdits,
    estimatedTokens: sessions.reduce((sum, row) => sum + row.estimated_tokens, 0)
  };
}

function selectToolRanking(db: MetricsDatabase): ToolRankingRow[] {
  return db.prepare<ToolRankingRow>(TOOL_RANKING_QUERY).all();
}

function selectSessions(db: MetricsDatabase): SessionListRow[] {
  return db
    .prepare<SessionListRow>(
      "SELECT session_id AS sessionId, workspace_path AS workspacePath FROM sessions ORDER BY started_at DESC"
    )
    .all();
}

function migrateLegacySessionsSchema(db: MetricsDatabase): void {
  const sessionColumns = db.prepare<{ name: string }>("PRAGMA table_info(sessions)").all();
  const hasEstimatedTokens = sessionColumns.some((column) => column.name === "estimated_tokens");

  if (!hasEstimatedTokens) {
    db.exec("ALTER TABLE sessions ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0");
  }
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
  migrateLegacySessionsSchema(db);

  const app = Fastify();

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/api/overview", async () => {
    const overviewRows = selectOverviewRows(db);

    return buildOverviewMetrics({
      sessions: overviewRows.sessions,
      toolEvents: overviewRows.toolEvents,
      codeEdits: overviewRows.codeEdits,
      estimatedTokens: overviewRows.estimatedTokens
    });
  });

  app.get("/api/tools", async () => {
    return selectToolRanking(db);
  });

  app.get("/api/sessions", async () => {
    return selectSessions(db);
  });

  app.get("/api/sessions/:id", async (request) => {
    const params = request.params as { id: string };
    const rows = db
      .prepare<SessionTimelineRow>(
        "SELECT tool_name AS toolName, status, duration_ms AS durationMs FROM tool_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);

    return {
      sessionId: params.id,
      timeline: rows.map((row) => ({
        type: `tool.${row.status}`,
        toolName: row.toolName,
        status: row.status,
        durationMs: row.durationMs
      }))
    };
  });

  app.get("/api/exports/json", async (_, reply) => {
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="tools.json"');
    return toJson(selectToolRanking(db));
  });

  app.get("/api/exports/csv", async (_, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="tools.csv"');
    return toCsv(selectToolRanking(db));
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
