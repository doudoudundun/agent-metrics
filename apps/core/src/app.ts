import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import {
  syncKnownClaudeTranscripts,
  type ClaudeSessionContext
} from "@agent-metrics/adapters-claude";
import { syncCodexRollouts } from "@agent-metrics/adapters-codex";
import { syncCursorArtifacts } from "@agent-metrics/adapters-cursor";
import { syncOpenCodeDatabase } from "@agent-metrics/adapters-opencode";
import { AnyEventSchema, type AnyEvent, type SourceVendor } from "@agent-metrics/event-schema";
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
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
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

type SourceVendorFilter = SourceVendor | "all";

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
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

type TokensByModelRow = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

type SourceBreakdownRow = {
  sourceVendor: SourceVendor;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
  toolCalls: number;
};

type ProviderBreakdownRow = {
  providerHost: string | null;
  providerId: string | null;
  totalTokens: number;
};

type ToolRankingRow = {
  toolName: string;
  count: number;
  failures: number;
  averageDurationMs: number;
};

type RawToolRankingRow = {
  sourceVendor: SourceVendor;
  toolName: string;
  count: number;
  failures: number;
  totalDurationMs: number;
};

type SessionListRow = {
  sessionId: string;
  workspacePath: string;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
  turnCount: number;
  totalTokens: number;
  lastModel: string | null;
};

type SessionRow = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  workspacePath: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type SessionContextRow = {
  executionPath: string | null;
  skillsLoaded: number;
  skillNamesJson: string;
};

type ToolTimelineRow = {
  toolName: string;
  status: string;
  durationMs: number | null;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type CodeEditTimelineRow = {
  toolName: string;
  filesChanged: string;
  insertions: number;
  deletions: number;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type PromptTimelineRow = {
  promptId: string;
  promptChars: number;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type AssistantTimelineRow = {
  messageId: string;
  model: string | null;
  stopReason: string | null;
  responseChars: number;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
};

type TokenUsageTimelineRow = {
  messageId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageSource: string;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
};

type SessionTimelineEntry = {
  createdAt: string;
  type: string;
  toolName: string;
  status: string;
  durationMs: number;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  promptId: string | null;
  promptChars: number | null;
  messageId: string | null;
  model: string | null;
  stopReason: string | null;
  responseChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  usageSource: string | null;
};

type TimeWindow = {
  whereSql: string;
  params: string[];
};

type EventLogSignature = {
  mtimeMs: number;
  size: number;
};

type EventLogCursor = {
  offsetBytes: number;
  sizeBytes: number;
  mtimeMs: number;
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

function createSingleFlightAction(action: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return async () => {
    if (inFlight) {
      await inFlight;
      return;
    }

    const run = action().finally(() => {
      if (inFlight === run) {
        inFlight = null;
      }
    });

    inFlight = run;
    await run;
  };
}

function selectOverviewRows(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): {
  sessions: SessionOverviewRow[];
  toolEvents: ToolEventOverviewRow[];
  prompts: PromptOverviewRow[];
  responses: AssistantResponseOverviewRow[];
  tokenUsage: TokenUsageOverviewRow[];
  codeEdits: CodeEditOverviewRow[];
} {
  const sessionWindow = buildTimeWindow("started_at", scope, sourceVendor);
  const toolWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const promptWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const responseWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const tokenUsageWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const codeEditWindow = buildTimeWindow("created_at", scope, sourceVendor);
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
      `SELECT model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM token_usage_events${tokenUsageWindow.whereSql}`
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

function selectTokensByModel(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): TokensByModelRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);

  return db
    .prepare<TokensByModelRow>(`
      SELECT
        COALESCE(model, 'unknown') AS model,
        SUM(
          input_tokens +
          output_tokens +
          cache_creation_input_tokens +
          cache_read_input_tokens
        ) AS totalTokens,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_read_input_tokens) AS cacheReadTokens,
        SUM(cache_creation_input_tokens) AS cacheCreationTokens
      FROM token_usage_events
      ${window.whereSql}
      GROUP BY COALESCE(model, 'unknown')
      ORDER BY totalTokens DESC, model ASC
    `)
    .all(...window.params);
}

function selectToolRanking(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ToolRankingRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);

  const rows = db
    .prepare<RawToolRankingRow>(`
      SELECT
        source_vendor AS sourceVendor,
        tool_name AS toolName,
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        COALESCE(SUM(duration_ms), 0) AS totalDurationMs
      FROM tool_events
      ${window.whereSql}
      GROUP BY source_vendor, tool_name
      ORDER BY count DESC, toolName ASC
    `)
    .all(...window.params);

  return normalizeToolRankingRows(rows);
}

function normalizeToolRankingRows(rows: RawToolRankingRow[]): ToolRankingRow[] {
  const grouped = new Map<
    string,
    {
      count: number;
      failures: number;
      totalDurationMs: number;
    }
  >();

  for (const row of rows) {
    const toolName = normalizeToolRankingName(row.toolName, row.sourceVendor);
    if (toolName === null) {
      continue;
    }
    const current = grouped.get(toolName) ?? {
      count: 0,
      failures: 0,
      totalDurationMs: 0
    };

    current.count += row.count;
    current.failures += row.failures;
    current.totalDurationMs += row.totalDurationMs;
    grouped.set(toolName, current);
  }

  return Array.from(grouped.entries())
    .map(([toolName, value]) => ({
      toolName,
      count: value.count,
      failures: value.failures,
      averageDurationMs:
        value.count > 0 ? Math.round(value.totalDurationMs / value.count) : 0
    }))
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName));
}

function normalizeToolRankingName(toolName: string, sourceVendor: SourceVendor): string | null {
  if (sourceVendor !== "codex") {
    return toolName;
  }

  const normalized = normalizeCodexToolRankingToken(toolName);
  if (normalized === null) {
    return null;
  }

  if (normalized === "apply_patch") {
    return "Edit";
  }

  if (normalized === "websearch") {
    return "WebSearch";
  }

  if (["rg", "grep", "findstr", "select-string"].includes(normalized)) {
    return "Search";
  }

  if (["get-content", "cat", "type", "more", "less", "sed", "head", "tail", "nl", "bat"].includes(normalized)) {
    return "Read";
  }

  if (["get-childitem", "dir", "ls", "tree"].includes(normalized)) {
    return "List";
  }

  if (normalized === "git") {
    return "Git";
  }

  if (["corepack", "pnpm", "npm", "yarn", "bun"].includes(normalized)) {
    return "Build";
  }

  if (["invoke-restmethod", "invoke-webrequest", "curl", "wget"].includes(normalized)) {
    return "HTTP";
  }

  if (["get-process", "get-ciminstance", "get-nettcpconnection", "tasklist", "ps"].includes(normalized)) {
    return "Inspect";
  }

  if (["powershell", "bash", "cmd", "python", "node", "add-type", "start-sleep"].includes(normalized)) {
    return "Shell";
  }

  return "Shell";
}

const IGNORED_CODEX_TOOL_RANKING_NAMES = new Set([
  "close_agent",
  "resume_agent",
  "send_input",
  "spawn_agent",
  "update_plan",
  "wait_agent"
]);

function normalizeCodexToolRankingToken(toolName: string): string | null {
  let cleaned = toolName.trim().toLowerCase();
  if (cleaned.length === 0) {
    return null;
  }

  cleaned = cleaned.replace(/^[&([{]+/u, "");
  cleaned = cleaned.replace(/^[`'"]+/u, "");
  cleaned = cleaned.replace(/[;|)\]}]+$/u, "");
  cleaned = cleaned.replace(/[`'"]+$/u, "");

  if (cleaned.length === 0 || cleaned.startsWith("$")) {
    return null;
  }

  if (IGNORED_CODEX_TOOL_RANKING_NAMES.has(cleaned)) {
    return null;
  }

  if (cleaned.includes(".ts") || cleaned.includes(".json") || cleaned.includes(".md") || cleaned.includes(".pid")) {
    return null;
  }

  return cleaned;
}

function selectSessions(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): SessionListRow[] {
  const window = buildTimeWindow("started_at", scope, sourceVendor);

  return db
    .prepare<SessionListRow>(
      `
        SELECT
          sessions.session_id AS sessionId,
          sessions.workspace_path AS workspacePath,
          sessions.source_vendor AS sourceVendor,
          sessions.source_adapter AS sourceAdapter,
          COALESCE(prompt_counts.turnCount, 0) AS turnCount,
          COALESCE(token_totals.totalTokens, 0) AS totalTokens,
          (
            SELECT combined.providerId
            FROM (
              SELECT provider_id AS providerId, created_at, event_id
              FROM assistant_responses
              WHERE session_id = sessions.session_id AND provider_id IS NOT NULL
              UNION ALL
              SELECT provider_id AS providerId, created_at, event_id
              FROM token_usage_events
              WHERE session_id = sessions.session_id AND provider_id IS NOT NULL
            ) AS combined
            ORDER BY combined.created_at DESC, combined.event_id DESC
            LIMIT 1
          ) AS providerId,
          (
            SELECT combined.providerHost
            FROM (
              SELECT provider_host AS providerHost, created_at, event_id
              FROM assistant_responses
              WHERE session_id = sessions.session_id AND provider_host IS NOT NULL
              UNION ALL
              SELECT provider_host AS providerHost, created_at, event_id
              FROM token_usage_events
              WHERE session_id = sessions.session_id AND provider_host IS NOT NULL
            ) AS combined
            ORDER BY combined.created_at DESC, combined.event_id DESC
            LIMIT 1
          ) AS providerHost,
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

function selectSourceBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): SourceBreakdownRow[] {
  const breakdown = new Map<SourceVendor, SourceBreakdownRow>();

  const ensureRow = (rowSourceVendor: SourceVendor): SourceBreakdownRow => {
    const existing = breakdown.get(rowSourceVendor);
    if (existing) {
      return existing;
    }

    const created: SourceBreakdownRow = {
      sourceVendor: rowSourceVendor,
      sessionCount: 0,
      turnCount: 0,
      totalTokens: 0,
      toolCalls: 0
    };
    breakdown.set(rowSourceVendor, created);
    return created;
  };

  const sessionWindow = buildTimeWindow("started_at", scope, sourceVendor);
  const promptWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const toolWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const tokenWindow = buildTimeWindow("created_at", scope, sourceVendor);

  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; sessionCount: number }>(`
      SELECT source_vendor AS sourceVendor, COUNT(*) AS sessionCount
      FROM sessions
      ${sessionWindow.whereSql}
      GROUP BY source_vendor
    `)
    .all(...sessionWindow.params)) {
    ensureRow(row.sourceVendor).sessionCount = row.sessionCount;
  }

  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; turnCount: number }>(`
      SELECT source_vendor AS sourceVendor, COUNT(*) AS turnCount
      FROM prompt_events
      ${promptWindow.whereSql}
      GROUP BY source_vendor
    `)
    .all(...promptWindow.params)) {
    ensureRow(row.sourceVendor).turnCount = row.turnCount;
  }

  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; toolCalls: number }>(`
      SELECT source_vendor AS sourceVendor, COUNT(*) AS toolCalls
      FROM tool_events
      ${toolWindow.whereSql}
      GROUP BY source_vendor
    `)
    .all(...toolWindow.params)) {
    ensureRow(row.sourceVendor).toolCalls = row.toolCalls;
  }

  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; totalTokens: number }>(`
      SELECT
        source_vendor AS sourceVendor,
        SUM(
          input_tokens +
          output_tokens +
          cache_creation_input_tokens +
          cache_read_input_tokens
        ) AS totalTokens
      FROM token_usage_events
      ${tokenWindow.whereSql}
      GROUP BY source_vendor
    `)
    .all(...tokenWindow.params)) {
    ensureRow(row.sourceVendor).totalTokens = row.totalTokens;
  }

  return [...breakdown.values()].sort((left, right) => left.sourceVendor.localeCompare(right.sourceVendor));
}

function selectProviderBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ProviderBreakdownRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);

  return db
    .prepare<ProviderBreakdownRow>(`
      SELECT
        provider_host AS providerHost,
        provider_id AS providerId,
        SUM(
          input_tokens +
          output_tokens +
          cache_creation_input_tokens +
          cache_read_input_tokens
        ) AS totalTokens
      FROM token_usage_events
      ${window.whereSql}
      GROUP BY provider_host, provider_id
      ORDER BY totalTokens DESC, providerHost ASC, providerId ASC
    `)
    .all(...window.params);
}

function buildTimeWindow(
  columnName: string,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  sourceColumnName = "source_vendor"
): TimeWindow {
  const clauses: string[] = [];
  const params: string[] = [];

  if (scope?.windowStart && scope.windowEnd) {
    clauses.push(`${columnName} >= ? AND ${columnName} <= ?`);
    params.push(scope.windowStart, scope.windowEnd);
  }

  if (sourceVendor !== "all") {
    clauses.push(`${sourceColumnName} = ?`);
    params.push(sourceVendor);
  }

  if (clauses.length === 0) {
    return {
      whereSql: "",
      params: []
    };
  }

  return {
    whereSql: ` WHERE ${clauses.join(" AND ")}`,
    params
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

function resolveSourceVendor(query: unknown): SourceVendorFilter {
  const sourceVendor = queryRecord(query).sourceVendor;

  return sourceVendor === "claude-code" || sourceVendor === "opencode" || sourceVendor === "codex" || sourceVendor === "cursor"
    ? sourceVendor
    : "all";
}

function migrateLegacySessionsSchema(db: MetricsDatabase): void {
  const sessionColumns = db.prepare<{ name: string }>("PRAGMA table_info(sessions)").all();
  const hasEndedAt = sessionColumns.some((column) => column.name === "ended_at");
  const hasExitCode = sessionColumns.some((column) => column.name === "exit_code");
  const hasSourceVendor = sessionColumns.some((column) => column.name === "source_vendor");
  const hasSourceAdapter = sessionColumns.some((column) => column.name === "source_adapter");

  if (!hasEndedAt) {
    db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  }

  if (!hasExitCode) {
    db.exec("ALTER TABLE sessions ADD COLUMN exit_code INTEGER");
  }

  if (!hasSourceVendor) {
    db.exec("ALTER TABLE sessions ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code'");
  }

  if (!hasSourceAdapter) {
    db.exec("ALTER TABLE sessions ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'claude-hook'");
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

  if (!codeEditColumns.some((column) => column.name === "source_vendor")) {
    db.exec("ALTER TABLE code_edits ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code'");
  }

  if (!codeEditColumns.some((column) => column.name === "source_adapter")) {
    db.exec("ALTER TABLE code_edits ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'claude-hook'");
  }
}

function migrateLegacyEventTableSchema(
  db: MetricsDatabase,
  tableName: "tool_events" | "prompt_events" | "assistant_responses" | "token_usage_events",
  input: {
    defaultAdapter: "claude-hook" | "claude-transcript";
    includeProviderColumns?: boolean;
  }
): void {
  const columns = db.prepare<{ name: string }>(`PRAGMA table_info(${tableName})`).all();

  if (columns.length === 0) {
    return;
  }

  if (!columns.some((column) => column.name === "source_vendor")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code'`);
  }

  if (!columns.some((column) => column.name === "source_adapter")) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN source_adapter TEXT NOT NULL DEFAULT '${input.defaultAdapter}'`
    );
  }

  if (!input.includeProviderColumns) {
    return;
  }

  if (!columns.some((column) => column.name === "provider_id")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN provider_id TEXT`);
  }

  if (!columns.some((column) => column.name === "provider_base_url")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN provider_base_url TEXT`);
  }

  if (!columns.some((column) => column.name === "provider_host")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN provider_host TEXT`);
  }
}

export function buildApp(input: BuildAppInput): MetricsApp {
  mkdirSync(dirname(input.dbPath), { recursive: true });

  const db = new Database(input.dbPath) as unknown as MetricsDatabase;
  const agentPaths = input.repoRoot ? getAgentMetricsPaths(input.repoRoot) : null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_responses (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      stop_reason TEXT,
      response_chars INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      provider_id TEXT,
      provider_base_url TEXT,
      provider_host TEXT,
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
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      provider_id TEXT,
      provider_base_url TEXT,
      provider_host TEXT,
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
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingestion_state (
      stream_name TEXT PRIMARY KEY,
      offset_bytes INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_contexts (
      session_id TEXT PRIMARY KEY,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      execution_path TEXT,
      skills_loaded INTEGER NOT NULL DEFAULT 0,
      skill_names_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `);
  migrateLegacySessionsSchema(db);
  migrateLegacyCodeEditsSchema(db);
  migrateLegacyEventTableSchema(db, "tool_events", { defaultAdapter: "claude-hook" });
  migrateLegacyEventTableSchema(db, "prompt_events", { defaultAdapter: "claude-transcript" });
  migrateLegacyEventTableSchema(db, "assistant_responses", {
    defaultAdapter: "claude-transcript",
    includeProviderColumns: true
  });
  migrateLegacyEventTableSchema(db, "token_usage_events", {
    defaultAdapter: "claude-transcript",
    includeProviderColumns: true
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_source_started_at
      ON sessions (source_vendor, started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_events_source_created_at
      ON tool_events (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_prompt_events_source_created_at
      ON prompt_events (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_responses_source_created_at
      ON assistant_responses (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_source_created_at
      ON token_usage_events (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_code_edits_source_created_at
      ON code_edits (source_vendor, created_at);
  `);

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
  const syncTranscriptState = agentPaths
    ? createSingleFlightAction(async () => {
        const result = await syncKnownClaudeTranscripts({
          manifestPath: agentPaths.transcriptManifestPath,
          eventLogPath: input.eventLogPath ?? agentPaths.eventLogPath,
          transcriptCursorPath: agentPaths.transcriptCursorPath,
          transcriptLedgerPath: agentPaths.transcriptLedgerPath
        });
        persistClaudeSessionContexts(db, result.sessionContexts);
      })
    : null;
  const syncOpenCodeState = agentPaths
    ? createSingleFlightAction(async () => {
        await syncOpenCodeDatabase({
          eventLogPath: input.eventLogPath ?? agentPaths.eventLogPath,
          cursorPath: agentPaths.opencodeCursorPath,
          ledgerPath: agentPaths.opencodeLedgerPath
        });
      })
    : null;
  const syncCursorState = agentPaths
    ? createSingleFlightAction(async () => {
        await syncCursorArtifacts({
          eventLogPath: input.eventLogPath ?? agentPaths.eventLogPath,
          cursorPath: agentPaths.cursorIdeStatePath,
          ledgerPath: agentPaths.cursorIdeLedgerPath
        });
      })
    : null;
  const syncCodexState = agentPaths
    ? createSingleFlightAction(async () => {
        await syncCodexRollouts({
          eventLogPath: input.eventLogPath ?? agentPaths.eventLogPath,
          cursorPath: agentPaths.codexCursorPath,
          ledgerPath: agentPaths.codexLedgerPath
        });
      })
    : null;

  app.addHook("onClose", async () => {
    db.close();
  });

  app.addHook("onRequest", async (request) => {
    const syncTasks: Promise<void>[] = [];

    if (syncTranscriptState) {
      syncTasks.push(
        syncTranscriptState().catch((error) => {
          request.log.warn(
            { err: error },
            "Transcript sync failed; serving stale local metrics."
          );
        })
      );
    }

    if (syncOpenCodeState) {
      syncTasks.push(
        syncOpenCodeState().catch((error) => {
          request.log.warn(
            { err: error },
            "OpenCode sync failed; serving stale local metrics."
          );
        })
      );
    }

    if (syncCursorState) {
      syncTasks.push(
        syncCursorState().catch((error) => {
          request.log.warn(
            { err: error },
            "Cursor sync failed; serving stale local metrics."
          );
        })
      );
    }

    if (syncCodexState) {
      syncTasks.push(
        syncCodexState().catch((error) => {
          request.log.warn(
            { err: error },
            "Codex sync failed; serving stale local metrics."
          );
        })
      );
    }

    if (syncTasks.length > 0) {
      await Promise.all(syncTasks);
    }

    if (!syncEventLog) {
      return;
    }

    await syncEventLog();
  });

  app.get("/api/overview", async (request) => {
    const scope = resolveRequestScope(request.query, input);
    const sourceVendor = resolveSourceVendor(request.query);
    const overviewRows = selectOverviewRows(db, scope, sourceVendor);

    return withScopeMetadata(
      {
        ...buildOverviewMetrics({
          sessions: overviewRows.sessions,
          toolEvents: overviewRows.toolEvents,
          prompts: overviewRows.prompts,
          responses: overviewRows.responses,
          tokenUsage: overviewRows.tokenUsage,
          codeEdits: overviewRows.codeEdits
        }),
        tokensByModel: selectTokensByModel(db, scope, sourceVendor),
        sourceBreakdown: selectSourceBreakdown(db, scope, sourceVendor),
        providerBreakdown: selectProviderBreakdown(db, scope, sourceVendor)
      },
      scope
    );
  });

  app.get("/api/tools", async (request) => {
    const scope = resolveRequestScope(request.query, input);
    const sourceVendor = resolveSourceVendor(request.query);

    return withScopeMetadata({ rows: selectToolRanking(db, scope, sourceVendor) }, scope);
  });

  app.get("/api/sessions", async (request) => {
    const scope = resolveRequestScope(request.query, input);
    const sourceVendor = resolveSourceVendor(request.query);

    return withScopeMetadata({ rows: selectSessions(db, scope, sourceVendor) }, scope);
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const session = db
      .prepare<SessionRow>(
        "SELECT session_id AS sessionId, started_at AS startedAt, ended_at AS endedAt, workspace_path AS workspacePath, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM sessions WHERE session_id = ?"
      )
      .get(params.id);

    if (!session) {
      reply.code(404);
      return { message: "Session not found" };
    }

    const sessionContext = db
      .prepare<SessionContextRow>(
        "SELECT execution_path AS executionPath, skills_loaded AS skillsLoaded, skill_names_json AS skillNamesJson FROM session_contexts WHERE session_id = ?"
      )
      .get(params.id);

    const toolRows = db
      .prepare<ToolTimelineRow>(
        "SELECT tool_name AS toolName, status, duration_ms AS durationMs, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM tool_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const promptRows = db
      .prepare<PromptTimelineRow>(
        "SELECT prompt_id AS promptId, prompt_chars AS promptChars, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM prompt_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const assistantRows = db
      .prepare<AssistantTimelineRow>(
        "SELECT message_id AS messageId, model, stop_reason AS stopReason, response_chars AS responseChars, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter, provider_id AS providerId, provider_host AS providerHost FROM assistant_responses WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const tokenUsageRows = db
      .prepare<TokenUsageTimelineRow>(
        "SELECT message_id AS messageId, model, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_input_tokens AS cacheReadTokens, cache_creation_input_tokens AS cacheCreationTokens, usage_source AS usageSource, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter, provider_id AS providerId, provider_host AS providerHost FROM token_usage_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const codeEditRows = db
      .prepare<CodeEditTimelineRow>(
        "SELECT tool_name AS toolName, files_changed AS filesChanged, insertions, deletions, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM code_edits WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);

    const timeline: SessionTimelineEntry[] = [
      createTimelineEntry({
        createdAt: session.startedAt,
        type: "session.started",
        toolName: "",
        status: "started",
        durationMs: 0,
        sourceVendor: session.sourceVendor,
        sourceAdapter: session.sourceAdapter,
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0
      }),
      ...promptRows.map((row) =>
        createTimelineEntry({
          createdAt: row.createdAt,
          type: "prompt.submitted",
          toolName: "",
          status: "submitted",
          durationMs: 0,
          sourceVendor: row.sourceVendor,
          sourceAdapter: row.sourceAdapter,
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          promptId: row.promptId,
          promptChars: row.promptChars
        })
      ),
      ...toolRows.map((row) =>
        createTimelineEntry({
        createdAt: row.createdAt,
        type: `tool.${row.status}`,
        toolName: row.toolName,
        status: row.status,
        durationMs: row.durationMs ?? 0,
        sourceVendor: row.sourceVendor,
        sourceAdapter: row.sourceAdapter,
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0
        })
      ),
      ...assistantRows.map((row) =>
        createTimelineEntry({
          createdAt: row.createdAt,
          type: "assistant.responded",
          toolName: "",
          status: "responded",
          durationMs: 0,
          sourceVendor: row.sourceVendor,
          sourceAdapter: row.sourceAdapter,
          providerId: row.providerId,
          providerHost: row.providerHost,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          messageId: row.messageId,
          model: row.model,
          stopReason: row.stopReason,
          responseChars: row.responseChars
        })
      ),
      ...tokenUsageRows.map((row) =>
        createTimelineEntry({
          createdAt: row.createdAt,
          type: "token.usage.recorded",
          toolName: "",
          status: "recorded",
          durationMs: 0,
          sourceVendor: row.sourceVendor,
          sourceAdapter: row.sourceAdapter,
          providerId: row.providerId,
          providerHost: row.providerHost,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          messageId: row.messageId,
          model: row.model ?? "unknown",
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          totalTokens:
            row.inputTokens +
            row.outputTokens +
            row.cacheReadTokens +
            row.cacheCreationTokens,
          usageSource: row.usageSource
        })
      ),
      ...codeEditRows.map((row) =>
        createTimelineEntry({
        createdAt: row.createdAt,
        type: "code.edit.applied",
        toolName: row.toolName,
        status: "applied",
        durationMs: 0,
        sourceVendor: row.sourceVendor,
        sourceAdapter: row.sourceAdapter,
        providerId: null,
        providerHost: null,
        filesChanged: parseFilesChanged(row.filesChanged),
        insertions: row.insertions,
        deletions: row.deletions
        })
      ),
      ...(session.endedAt
        ? [
            createTimelineEntry({
              createdAt: session.endedAt,
              type: "session.ended",
              toolName: "",
              status: "ended",
              durationMs: 0,
              sourceVendor: session.sourceVendor,
              sourceAdapter: session.sourceAdapter,
              providerId: null,
              providerHost: null,
              filesChanged: [],
              insertions: 0,
              deletions: 0
            })
          ]
        : [])
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      sessionId: params.id,
      workspacePath: session.workspacePath,
      sourceVendor: session.sourceVendor,
      sourceAdapter: session.sourceAdapter,
      context: sessionContext
        ? {
            executionPath: sessionContext.executionPath,
            skillsLoaded: sessionContext.skillsLoaded === 1,
            skillNames: parseFilesChanged(sessionContext.skillNamesJson)
          }
        : null,
      timeline
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
  const db = input.app.db;
  const signature = await readEventLogSignature(input.eventLogPath);

  if (signature === null) {
    return;
  }

  const existingCursor = readEventLogCursor(db);
  if (
    existingCursor !== null &&
    existingCursor.offsetBytes === signature.size &&
    existingCursor.sizeBytes === signature.size &&
    existingCursor.mtimeMs === signature.mtimeMs
  ) {
    return;
  }

  let file: Buffer;

  try {
    file = await readFile(input.eventLogPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  const committedSize = resolveCommittedEventLogSize(file);
  const shouldResumeIncrementally =
    existingCursor !== null &&
    existingCursor.offsetBytes > 0 &&
    existingCursor.offsetBytes <= committedSize &&
    existingCursor.sizeBytes < signature.size;
  const startOffset = shouldResumeIncrementally ? existingCursor.offsetBytes : 0;
  const nextOffset = committedSize;

  if (nextOffset <= startOffset) {
    writeEventLogCursor(db, {
      offsetBytes: nextOffset,
      sizeBytes: signature.size,
      mtimeMs: signature.mtimeMs
    });
    return;
  }

  const chunk = file.subarray(startOffset, nextOffset);
  const lines = chunk
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    writeEventLogCursor(db, {
      offsetBytes: nextOffset,
      sizeBytes: signature.size,
      mtimeMs: signature.mtimeMs
    });
    return;
  }

  const parsedEvents = lines.map((line) => AnyEventSchema.parse(JSON.parse(line)));
  const persistEvents = db.transaction((events: AnyEvent[]) => {
    for (const parsed of events) {
      const storedSourceVendor = parsed.source_vendor;
      const storedSourceAdapter = normalizeSourceAdapterForStorage(parsed);

      if (parsed.type === "session.started") {
        db.prepare(
          `
            INSERT INTO sessions (
              session_id,
              started_at,
              workspace_path,
              source_vendor,
              source_adapter,
              ended_at,
              exit_code
            )
            VALUES (?, ?, ?, ?, ?, NULL, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
              started_at = excluded.started_at,
              workspace_path = excluded.workspace_path,
              source_vendor = excluded.source_vendor,
              source_adapter = excluded.source_adapter
          `
        ).run(
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          storedSourceVendor,
          storedSourceAdapter
        );
      }

      if (parsed.type === "session.ended") {
        ensureSessionExists(
          db,
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          storedSourceVendor,
          storedSourceAdapter
        );
        db.prepare(
          "UPDATE sessions SET ended_at = ?, exit_code = ?, workspace_path = ?, source_vendor = ?, source_adapter = ? WHERE session_id = ?"
        ).run(
          parsed.timestamp,
          parsed.exit_code ?? null,
          parsed.workspace_path,
          storedSourceVendor,
          storedSourceAdapter,
          parsed.session_id
        );
      }

      if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
        db.prepare(
          "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, source_vendor, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          parsed.event_id,
          parsed.session_id,
          parsed.tool_name,
          parsed.status,
          parsed.duration_ms,
          storedSourceVendor,
          storedSourceAdapter,
          parsed.timestamp
        );
      }

      if (parsed.type === "prompt.submitted") {
        ensureSessionExists(
          db,
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          storedSourceVendor,
          storedSourceAdapter
        );
        db.prepare(
          "INSERT OR REPLACE INTO prompt_events (event_id, session_id, prompt_id, prompt_chars, source_vendor, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          parsed.event_id,
          parsed.session_id,
          parsed.prompt_id,
          parsed.prompt_chars,
          storedSourceVendor,
          storedSourceAdapter,
          parsed.timestamp
        );
      }

      if (parsed.type === "assistant.responded") {
        ensureSessionExists(
          db,
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          storedSourceVendor,
          storedSourceAdapter
        );
        db.prepare(
          "INSERT OR REPLACE INTO assistant_responses (event_id, session_id, message_id, model, stop_reason, response_chars, source_vendor, source_adapter, provider_id, provider_base_url, provider_host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          parsed.event_id,
          parsed.session_id,
          parsed.message_id,
          parsed.model ?? null,
          parsed.stop_reason ?? null,
          parsed.response_chars,
          storedSourceVendor,
          storedSourceAdapter,
          parsed.provider_id ?? null,
          parsed.provider_base_url ?? null,
          parsed.provider_host ?? null,
          parsed.timestamp
        );
      }

      if (parsed.type === "token.usage.recorded") {
        ensureSessionExists(
          db,
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          storedSourceVendor,
          storedSourceAdapter
        );
        db.prepare(
          "INSERT OR REPLACE INTO token_usage_events (event_id, session_id, message_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, usage_source, source_vendor, source_adapter, provider_id, provider_base_url, provider_host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
          storedSourceVendor,
          storedSourceAdapter,
          parsed.provider_id ?? null,
          parsed.provider_base_url ?? null,
          parsed.provider_host ?? null,
          parsed.timestamp
        );
      }

      if (parsed.type === "code.edit.applied") {
        db.prepare(
          "INSERT OR REPLACE INTO code_edits (event_id, session_id, tool_name, files_changed, file_count, insertions, deletions, edit_operation_count, source_vendor, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          parsed.event_id,
          parsed.session_id,
          parsed.tool_name,
          JSON.stringify(parsed.files_changed),
          parsed.file_count,
          parsed.insertions,
          parsed.deletions,
          parsed.edit_operation_count,
          storedSourceVendor,
          storedSourceAdapter,
          parsed.timestamp
        );
      }
    }
  });

  persistEvents(parsedEvents);
  writeEventLogCursor(db, {
    offsetBytes: nextOffset,
    sizeBytes: signature.size,
    mtimeMs: signature.mtimeMs
  });
}

function normalizeSourceAdapterForStorage(event: AnyEvent): string {
  if (event.source_adapter !== "claude") {
    return event.source_adapter;
  }

  if (
    event.type === "prompt.submitted" ||
    event.type === "assistant.responded" ||
    event.type === "token.usage.recorded"
  ) {
    return "claude-transcript";
  }

  return "claude-hook";
}

function ensureSessionExists(
  db: MetricsDatabase,
  sessionId: string,
  startedAt: string,
  workspacePath: string,
  sourceVendor: string,
  sourceAdapter: string
): void {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, started_at, workspace_path, source_vendor, source_adapter, ended_at, exit_code) VALUES (?, ?, ?, ?, ?, NULL, NULL)"
  ).run(sessionId, startedAt, workspacePath, sourceVendor, sourceAdapter);
}

function persistClaudeSessionContexts(
  db: MetricsDatabase,
  contexts: ClaudeSessionContext[]
): void {
  const persist = db.transaction((items: ClaudeSessionContext[]) => {
    for (const context of items) {
      ensureSessionExists(
        db,
        context.sessionId,
        context.updatedAt,
        context.workspacePath,
        context.sourceVendor,
        context.sourceAdapter
      );
      db.prepare(
        `
          INSERT INTO session_contexts (
            session_id,
            source_vendor,
            source_adapter,
            execution_path,
            skills_loaded,
            skill_names_json,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            source_vendor = excluded.source_vendor,
            source_adapter = excluded.source_adapter,
            execution_path = excluded.execution_path,
            skills_loaded = excluded.skills_loaded,
            skill_names_json = excluded.skill_names_json,
            updated_at = excluded.updated_at
        `
      ).run(
        context.sessionId,
        context.sourceVendor,
        context.sourceAdapter,
        context.executionPath,
        context.skillsLoaded ? 1 : 0,
        JSON.stringify(context.skillNames),
        context.updatedAt
      );
    }
  });

  persist(contexts);
}

function parseFilesChanged(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function createTimelineEntry(
  input: Omit<
    SessionTimelineEntry,
    | "sourceVendor"
    | "sourceAdapter"
    | "providerId"
    | "providerHost"
    | "promptId"
    | "promptChars"
    | "messageId"
    | "model"
    | "stopReason"
    | "responseChars"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheCreationTokens"
    | "totalTokens"
    | "usageSource"
  > &
    Partial<
      Pick<
        SessionTimelineEntry,
        | "sourceVendor"
        | "sourceAdapter"
        | "providerId"
        | "providerHost"
        | "promptId"
        | "promptChars"
        | "messageId"
        | "model"
        | "stopReason"
        | "responseChars"
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheCreationTokens"
        | "totalTokens"
        | "usageSource"
      >
    >
): SessionTimelineEntry {
  return {
    sourceVendor: "claude-code",
    sourceAdapter: "claude-hook",
    providerId: null,
    providerHost: null,
    promptId: null,
    promptChars: null,
    messageId: null,
    model: null,
    stopReason: null,
    responseChars: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    totalTokens: null,
    usageSource: null,
    ...input
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readEventLogCursor(db: MetricsDatabase): EventLogCursor | null {
  const row = db
    .prepare<{ offsetBytes: number; sizeBytes: number; mtimeMs: number }>(
      `
        SELECT
          offset_bytes AS offsetBytes,
          size_bytes AS sizeBytes,
          mtime_ms AS mtimeMs
        FROM ingestion_state
        WHERE stream_name = 'events.jsonl'
      `
    )
    .get();

  if (
    !row ||
    !Number.isInteger(row.offsetBytes) ||
    row.offsetBytes < 0 ||
    !Number.isInteger(row.sizeBytes) ||
    row.sizeBytes < 0 ||
    typeof row.mtimeMs !== "number" ||
    row.mtimeMs < 0
  ) {
    return null;
  }

  return row;
}

function writeEventLogCursor(db: MetricsDatabase, cursor: EventLogCursor): void {
  db.prepare(
    `
      INSERT INTO ingestion_state (stream_name, offset_bytes, size_bytes, mtime_ms)
      VALUES ('events.jsonl', ?, ?, ?)
      ON CONFLICT(stream_name) DO UPDATE SET
        offset_bytes = excluded.offset_bytes,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms
    `
  ).run(cursor.offsetBytes, cursor.sizeBytes, cursor.mtimeMs);
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

function resolveCommittedEventLogSize(file: Buffer): number {
  if (file.length === 0) {
    return 0;
  }

  const newlineIndex = file.lastIndexOf(0x0a);
  return newlineIndex === -1 ? 0 : newlineIndex + 1;
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
