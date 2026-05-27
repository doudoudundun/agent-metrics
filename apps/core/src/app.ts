import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { syncKnownClaudeTranscripts } from "@agent-metrics/adapters-claude";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import { toCsv, toJson } from "@agent-metrics/export-kit";
import { buildOverviewMetrics } from "@agent-metrics/metrics-engine";
import { getAgentMetricsPaths } from "@agent-metrics/shared-utils";
import { resolveTimeScope, type ResolvedTimeScope } from "./time-scope.js";

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

type BuildAppInput = {
  dbPath: string;
  eventLogPath?: string;
  repoRoot?: string;
  now?: () => Date;
  timezone?: string;
  offsetMinutes?: number;
};

type SessionOverviewRow = {
  session_id: string;
};

type ToolEventOverviewRow = {
  status: string;
  duration_ms: number | null;
};

type CodeEditOverviewRow = {
  files_changed: string[];
  file_count: number;
  insertions: number;
  deletions: number;
  edit_operation_count: number;
};

type PromptOverviewRow = {
  prompt_id: string;
};

type AssistantResponseOverviewRow = {
  message_id: string;
};

type TokenUsageOverviewRow = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
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
  turnCount: number;
  totalTokens: number;
  lastModel: string | null;
};

type SessionRow = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
};

type ToolTimelineRow = {
  toolName: string;
  status: string;
  durationMs: number | null;
  createdAt: string;
};

type CodeEditTimelineRow = {
  toolName: string;
  filesChanged: string;
  insertions: number;
  deletions: number;
  createdAt: string;
};

type TimeWindow = {
  whereSql: string;
  params: string[];
};

type EventLogSignature = {
  mtimeMs: number;
  size: number;
};

export function resolveDefaultDbPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/sqlite/metrics.sqlite", moduleUrl));
}

export function resolveDefaultEventLogPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/events/events.jsonl", moduleUrl));
}

export function createEventLogSynchronizer(input: {
  eventLogPath: string;
  ingest: () => Promise<void>;
}): () => Promise<void> {
  let lastIngestedSignature: EventLogSignature | null = null;
  let syncQueue: Promise<void> = Promise.resolve();

  return async () => {
    const run = syncQueue.catch(() => undefined).then(async () => {
      const nextSignature = await readEventLogSignature(input.eventLogPath);

      if (isSameEventLogSignature(nextSignature, lastIngestedSignature)) {
        return;
      }

      if (nextSignature === null) {
        lastIngestedSignature = null;
        return;
      }

      await input.ingest();
      lastIngestedSignature = nextSignature;
    });

    syncQueue = run;
    await run;
  };
}

function selectOverviewRows(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope
): {
  sessions: SessionOverviewRow[];
  toolEvents: ToolEventOverviewRow[];
  prompts: PromptOverviewRow[];
  responses: AssistantResponseOverviewRow[];
  tokenUsage: TokenUsageOverviewRow[];
  codeEdits: CodeEditOverviewRow[];
} {
  const sessionWindow = buildTimeWindow("started_at", scope);
  const toolWindow = buildTimeWindow("created_at", scope);
  const promptWindow = buildTimeWindow("created_at", scope);
  const responseWindow = buildTimeWindow("created_at", scope);
  const tokenUsageWindow = buildTimeWindow("created_at", scope);
  const codeEditWindow = buildTimeWindow("created_at", scope);
  const sessions = db
    .prepare<SessionOverviewRow>(`SELECT session_id FROM sessions${sessionWindow.whereSql}`)
    .all(...sessionWindow.params);
  const toolEvents = db
    .prepare<ToolEventOverviewRow>(`SELECT status, duration_ms FROM tool_events${toolWindow.whereSql}`)
    .all(...toolWindow.params);
  const prompts = db
    .prepare<PromptOverviewRow>(`SELECT prompt_id FROM prompt_events${promptWindow.whereSql}`)
    .all(...promptWindow.params);
  const responses = db
    .prepare<AssistantResponseOverviewRow>(
      `SELECT message_id FROM assistant_responses${responseWindow.whereSql}`
    )
    .all(...responseWindow.params);
  const tokenUsage = db
    .prepare<TokenUsageOverviewRow>(
      `SELECT input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM token_usage_events${tokenUsageWindow.whereSql}`
    )
    .all(...tokenUsageWindow.params);
  const codeEdits = db
    .prepare<{
      filesChanged: string;
      file_count: number;
      insertions: number;
      deletions: number;
      edit_operation_count: number;
    }>(
      `SELECT files_changed AS filesChanged, file_count, insertions, deletions, edit_operation_count FROM code_edits${codeEditWindow.whereSql}`
    )
    .all(...codeEditWindow.params)
    .map((row) => ({
      files_changed: parseFilesChanged(row.filesChanged),
      file_count: row.file_count,
      insertions: row.insertions,
      deletions: row.deletions,
      edit_operation_count: row.edit_operation_count
    }));

  return {
    sessions,
    toolEvents,
    prompts,
    responses,
    tokenUsage,
    codeEdits
  };
}

function selectToolRanking(db: MetricsDatabase, scope?: ResolvedTimeScope): ToolRankingRow[] {
  const window = buildTimeWindow("created_at", scope);

  return db
    .prepare<ToolRankingRow>(`
      SELECT
        tool_name AS toolName,
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        COALESCE(CAST(AVG(duration_ms) AS INTEGER), 0) AS averageDurationMs
      FROM tool_events
      ${window.whereSql}
      GROUP BY tool_name
      ORDER BY count DESC, toolName ASC
    `)
    .all(...window.params);
}

function selectSessions(db: MetricsDatabase, scope?: ResolvedTimeScope): SessionListRow[] {
  const window = buildTimeWindow("started_at", scope);

  return db
    .prepare<SessionListRow>(
      `
        SELECT
          sessions.session_id AS sessionId,
          sessions.workspace_path AS workspacePath,
          COALESCE(prompt_counts.turnCount, 0) AS turnCount,
          COALESCE(token_totals.totalTokens, 0) AS totalTokens,
          (
            SELECT combined.model
            FROM (
              SELECT model, created_at, event_id
              FROM assistant_responses
              WHERE session_id = sessions.session_id AND model IS NOT NULL
              UNION ALL
              SELECT model, created_at, event_id
              FROM token_usage_events
              WHERE session_id = sessions.session_id AND model IS NOT NULL
            ) AS combined
            ORDER BY combined.created_at DESC, combined.event_id DESC
            LIMIT 1
          ) AS lastModel
        FROM sessions
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS turnCount
          FROM prompt_events
          GROUP BY session_id
        ) AS prompt_counts
          ON prompt_counts.session_id = sessions.session_id
        LEFT JOIN (
          SELECT
            session_id,
            SUM(
              input_tokens +
              output_tokens +
              cache_creation_input_tokens +
              cache_read_input_tokens
            ) AS totalTokens
          FROM token_usage_events
          GROUP BY session_id
        ) AS token_totals
          ON token_totals.session_id = sessions.session_id
        ${window.whereSql}
        ORDER BY sessions.started_at DESC
      `
    )
    .all(...window.params);
}

function buildTimeWindow(columnName: string, scope?: ResolvedTimeScope): TimeWindow {
  if (!scope?.windowStart || !scope.windowEnd) {
    return {
      whereSql: "",
      params: []
    };
  }

  return {
    whereSql: ` WHERE ${columnName} >= ? AND ${columnName} <= ?`,
    params: [scope.windowStart, scope.windowEnd]
  };
}

function resolveRequestScope(
  query: unknown,
  input: BuildAppInput
): ResolvedTimeScope & { updatedAt: string } {
  const now = input.now?.() ?? new Date();
  const scope = resolveTimeScope(queryRecord(query), {
    now,
    timezone: input.timezone,
    offsetMinutes: input.offsetMinutes
  });

  return {
    ...scope,
    updatedAt: now.toISOString()
  };
}

function withScopeMetadata<T extends object>(
  payload: T,
  scope: ResolvedTimeScope & { updatedAt: string }
): T & {
  mode: ResolvedTimeScope["mode"];
  range: ResolvedTimeScope["range"];
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
  updatedAt: string;
} {
  return {
    ...payload,
    mode: scope.mode,
    range: scope.range,
    timezone: scope.timezone,
    windowStart: scope.windowStart,
    windowEnd: scope.windowEnd,
    updatedAt: scope.updatedAt
  };
}

function queryRecord(query: unknown): Record<string, unknown> {
  return query && typeof query === "object" ? (query as Record<string, unknown>) : {};
}

function migrateLegacySessionsSchema(db: MetricsDatabase): void {
  const sessionColumns = db.prepare<{ name: string }>("PRAGMA table_info(sessions)").all();
  const hasEndedAt = sessionColumns.some((column) => column.name === "ended_at");
  const hasExitCode = sessionColumns.some((column) => column.name === "exit_code");

  if (!hasEndedAt) {
    db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  }

  if (!hasExitCode) {
    db.exec("ALTER TABLE sessions ADD COLUMN exit_code INTEGER");
  }
}

function migrateLegacyCodeEditsSchema(db: MetricsDatabase): void {
  const codeEditColumns = db.prepare<{ name: string }>("PRAGMA table_info(code_edits)").all();

  if (codeEditColumns.length === 0) {
    return;
  }

  const hasFilesChanged = codeEditColumns.some((column) => column.name === "files_changed");

  if (!hasFilesChanged) {
    db.exec("ALTER TABLE code_edits ADD COLUMN files_changed TEXT NOT NULL DEFAULT '[]'");
  }
}

export function buildApp(input: BuildAppInput): MetricsApp {
  mkdirSync(dirname(input.dbPath), { recursive: true });

  const db = new Database(input.dbPath) as MetricsDatabase;
  const agentPaths = input.repoRoot ? getAgentMetricsPaths(input.repoRoot) : null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_responses (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      stop_reason TEXT,
      response_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage_events (
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
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_edits (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      files_changed TEXT NOT NULL DEFAULT '[]',
      file_count INTEGER NOT NULL,
      insertions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      edit_operation_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrateLegacySessionsSchema(db);
  migrateLegacyCodeEditsSchema(db);

  const app = Fastify();
  const metricsApp = Object.assign(app, { db });
  const syncEventLog = input.eventLogPath
    ? createEventLogSynchronizer({
        eventLogPath: input.eventLogPath,
        ingest: async () => {
          await ingestEventLog({
            app: metricsApp,
            eventLogPath: input.eventLogPath!
          });
        }
      })
    : null;

  app.addHook("onClose", async () => {
    db.close();
  });

  app.addHook("onRequest", async () => {
    if (agentPaths) {
      await syncKnownClaudeTranscripts({
        manifestPath: agentPaths.transcriptManifestPath,
        eventLogPath: input.eventLogPath ?? agentPaths.eventLogPath,
        transcriptCursorPath: agentPaths.transcriptCursorPath,
        transcriptLedgerPath: agentPaths.transcriptLedgerPath
      });
    }

    if (!syncEventLog) {
      return;
    }

    await syncEventLog();
  });

  app.get("/api/overview", async (request) => {
    const scope = resolveRequestScope(request.query, input);
    const overviewRows = selectOverviewRows(db, scope);

    return withScopeMetadata(
      buildOverviewMetrics({
        sessions: overviewRows.sessions,
        toolEvents: overviewRows.toolEvents,
        prompts: overviewRows.prompts,
        responses: overviewRows.responses,
        tokenUsage: overviewRows.tokenUsage,
        codeEdits: overviewRows.codeEdits
      }),
      scope
    );
  });

  app.get("/api/tools", async (request) => {
    const scope = resolveRequestScope(request.query, input);

    return withScopeMetadata({ rows: selectToolRanking(db, scope) }, scope);
  });

  app.get("/api/sessions", async (request) => {
    const scope = resolveRequestScope(request.query, input);

    return withScopeMetadata({ rows: selectSessions(db, scope) }, scope);
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const session = db
      .prepare<SessionRow>(
        "SELECT session_id AS sessionId, started_at AS startedAt, ended_at AS endedAt FROM sessions WHERE session_id = ?"
      )
      .get(params.id);

    if (!session) {
      reply.code(404);
      return { message: "Session not found" };
    }

    const toolRows = db
      .prepare<ToolTimelineRow>(
        "SELECT tool_name AS toolName, status, duration_ms AS durationMs, created_at AS createdAt FROM tool_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const codeEditRows = db
      .prepare<CodeEditTimelineRow>(
        "SELECT tool_name AS toolName, files_changed AS filesChanged, insertions, deletions, created_at AS createdAt FROM code_edits WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);

    const timeline = [
      {
        createdAt: session.startedAt,
        type: "session.started",
        toolName: "",
        status: "started",
        durationMs: 0,
        filesChanged: [],
        insertions: 0,
        deletions: 0
      },
      ...toolRows.map((row) => ({
        createdAt: row.createdAt,
        type: `tool.${row.status}`,
        toolName: row.toolName,
        status: row.status,
        durationMs: row.durationMs ?? 0,
        filesChanged: [],
        insertions: 0,
        deletions: 0
      })),
      ...codeEditRows.map((row) => ({
        createdAt: row.createdAt,
        type: "code.edit.applied",
        toolName: row.toolName,
        status: "applied",
        durationMs: 0,
        filesChanged: parseFilesChanged(row.filesChanged),
        insertions: row.insertions,
        deletions: row.deletions
      })),
      ...(session.endedAt
        ? [
            {
              createdAt: session.endedAt,
              type: "session.ended",
              toolName: "",
              status: "ended",
              durationMs: 0,
              filesChanged: [],
              insertions: 0,
              deletions: 0
            }
          ]
        : [])
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      sessionId: params.id,
      timeline: timeline.map(({ createdAt: _createdAt, ...entry }) => entry)
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

  return metricsApp;
}

export async function ingestEventLog(input: {
  app: MetricsApp;
  eventLogPath: string;
}): Promise<void> {
  let file: string;

  try {
    file = await readFile(input.eventLogPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  const lines = file.trim().split("\n").filter(Boolean);
  const db = input.app.db;

  for (const line of lines) {
    const parsed = AnyEventSchema.parse(JSON.parse(line));

    if (parsed.type === "session.started") {
      db.prepare(
        `
          INSERT INTO sessions (session_id, started_at, workspace_path, ended_at, exit_code)
          VALUES (?, ?, ?, NULL, NULL)
          ON CONFLICT(session_id) DO UPDATE SET
            started_at = excluded.started_at,
            workspace_path = excluded.workspace_path
        `
      ).run(parsed.session_id, parsed.timestamp, parsed.workspace_path);
    }

    if (parsed.type === "session.ended") {
      ensureSessionExists(db, parsed.session_id, parsed.timestamp, parsed.workspace_path);
      db.prepare(
        "UPDATE sessions SET ended_at = ?, exit_code = ?, workspace_path = ? WHERE session_id = ?"
      ).run(parsed.timestamp, parsed.exit_code ?? null, parsed.workspace_path, parsed.session_id);
    }

    if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
      db.prepare(
        "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.tool_name, parsed.status, parsed.duration_ms, parsed.timestamp);
    }

    if (parsed.type === "prompt.submitted") {
      ensureSessionExists(db, parsed.session_id, parsed.timestamp, parsed.workspace_path);
      db.prepare(
        "INSERT OR REPLACE INTO prompt_events (event_id, session_id, prompt_id, prompt_chars, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.prompt_id, parsed.prompt_chars, parsed.timestamp);
    }

    if (parsed.type === "assistant.responded") {
      ensureSessionExists(db, parsed.session_id, parsed.timestamp, parsed.workspace_path);
      db.prepare(
        "INSERT OR REPLACE INTO assistant_responses (event_id, session_id, message_id, model, stop_reason, response_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        parsed.event_id,
        parsed.session_id,
        parsed.message_id,
        parsed.model ?? null,
        parsed.stop_reason ?? null,
        parsed.response_chars,
        parsed.timestamp
      );
    }

    if (parsed.type === "token.usage.recorded") {
      ensureSessionExists(db, parsed.session_id, parsed.timestamp, parsed.workspace_path);
      db.prepare(
        "INSERT OR REPLACE INTO token_usage_events (event_id, session_id, message_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, usage_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        parsed.event_id,
        parsed.session_id,
        parsed.message_id,
        parsed.model ?? null,
        parsed.input_tokens,
        parsed.output_tokens,
        parsed.cache_creation_input_tokens,
        parsed.cache_read_input_tokens,
        parsed.server_tool_use,
        parsed.usage_source,
        parsed.timestamp
      );
    }

    if (parsed.type === "code.edit.applied") {
      db.prepare(
        "INSERT OR REPLACE INTO code_edits (event_id, session_id, tool_name, files_changed, file_count, insertions, deletions, edit_operation_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        parsed.event_id,
        parsed.session_id,
        parsed.tool_name,
        JSON.stringify(parsed.files_changed),
        parsed.file_count,
        parsed.insertions,
        parsed.deletions,
        parsed.edit_operation_count,
        parsed.timestamp
      );
    }
  }
}

function ensureSessionExists(
  db: MetricsDatabase,
  sessionId: string,
  startedAt: string,
  workspacePath: string
): void {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, started_at, workspace_path, ended_at, exit_code) VALUES (?, ?, ?, NULL, NULL)"
  ).run(sessionId, startedAt, workspacePath);
}

function parseFilesChanged(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readEventLogSignature(eventLogPath: string): Promise<EventLogSignature | null> {
  try {
    const details = await stat(eventLogPath);

    return {
      mtimeMs: details.mtimeMs,
      size: details.size
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function isSameEventLogSignature(
  left: EventLogSignature | null,
  right: EventLogSignature | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}
