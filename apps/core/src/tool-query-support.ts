import type { SourceVendor } from "@agent-metrics/event-schema";
import type { ToolExecutionCounts } from "@agent-metrics/metrics-engine";
import type { ResolvedTimeScope } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import { buildTimeWindow } from "./query-support.js";

type TimeWindow = {
  whereSql: string;
  params: string[];
};

type ToolStatusCountRow = {
  status: string;
  count: number;
};

type RawToolRankingRow = {
  sourceVendor: SourceVendor;
  toolName: string;
  sessionId: string;
  eventId: string;
  count: number;
  failures: number;
  totalDurationMs: number;
};

type SourceToolCountRow = {
  sourceVendor: SourceVendor;
  toolCalls: number;
};

const TOOL_CALLS_JOIN = `
  FROM tool_calls
  INNER JOIN domain_sessions
    ON domain_sessions.source_instance_id = tool_calls.source_instance_id
   AND domain_sessions.session_id = tool_calls.session_id
`;

const TOOL_ACTIVITY_AT = "COALESCE(tool_calls.started_at, tool_calls.finished_at)";

export function hasDomainToolCalls(db: MetricsDatabase): boolean {
  return Boolean(db.prepare("SELECT 1 FROM tool_calls LIMIT 1").get());
}

export function selectOverviewToolCounts(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ToolExecutionCounts {
  let rows: ToolStatusCountRow[];
  if (hasDomainToolCalls(db)) {
    const window = buildToolCallsWindow(scope, sourceVendor);
    rows = db
      .prepare<ToolStatusCountRow>(`
        SELECT tool_calls.status, COUNT(*) AS count
        ${TOOL_CALLS_JOIN}
        ${window.whereSql}
        GROUP BY tool_calls.status
      `)
      .all(...window.params);
  } else {
    rows = selectLegacyOverviewToolCounts(db, scope, sourceVendor);
  }

  const counts: ToolExecutionCounts = {
    successfulExecutions: 0, failedExecutions: 0, startedOnlyExecutions: 0
  };
  for (const row of rows) {
    if (row.status === "succeeded") counts.successfulExecutions += row.count;
    else if (row.status === "failed") counts.failedExecutions += row.count;
    else if (row.status === "started") counts.startedOnlyExecutions += row.count;
  }
  return counts;
}

export function selectToolRankingRows(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): RawToolRankingRow[] {
  if (hasDomainToolCalls(db)) {
    const window = buildToolCallsWindow(scope, sourceVendor);
    return db
      .prepare<RawToolRankingRow>(`
        SELECT
          domain_sessions.source_vendor AS sourceVendor,
          tool_calls.tool_name AS toolName,
          '' AS sessionId,
          '' AS eventId,
          COUNT(*) AS count,
          SUM(CASE WHEN tool_calls.status = 'failed' THEN 1 ELSE 0 END) AS failures,
          SUM(COALESCE(tool_calls.duration_ms, 0)) AS totalDurationMs
        ${TOOL_CALLS_JOIN}
        ${window.whereSql}
        GROUP BY domain_sessions.source_vendor, tool_calls.tool_name
      `)
      .all(...window.params);
  }

  return selectLegacyToolRankingRows(db, scope, sourceVendor);
}

export function selectSourceToolCallCounts(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): SourceToolCountRow[] {
  if (hasDomainToolCalls(db)) {
    const window = buildToolCallsWindow(scope, sourceVendor);
    const terminalClause = window.whereSql.length > 0
      ? `${window.whereSql} AND tool_calls.status IN ('succeeded', 'failed')`
      : ` WHERE tool_calls.status IN ('succeeded', 'failed')`;
    return db
      .prepare<SourceToolCountRow>(`
        SELECT
          domain_sessions.source_vendor AS sourceVendor,
          COUNT(*) AS toolCalls
        ${TOOL_CALLS_JOIN}
        ${terminalClause}
        GROUP BY domain_sessions.source_vendor
      `)
      .all(...window.params);
  }

  return selectLegacySourceToolCallCounts(db, scope, sourceVendor);
}

function buildToolCallsWindow(
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): TimeWindow {
  const clauses: string[] = [];
  const params: string[] = [];

  if (scope?.windowStart && scope.windowEnd) {
    clauses.push(`${TOOL_ACTIVITY_AT} >= ? AND ${TOOL_ACTIVITY_AT} <= ?`);
    params.push(scope.windowStart, scope.windowEnd);
  }

  if (sourceVendor !== "all") {
    clauses.push("domain_sessions.source_vendor = ?");
    params.push(sourceVendor);
  }

  return {
    whereSql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function legacyToolCallKeyExpression(): string {
  return `COALESCE(NULLIF(tool_call_id, ''), event_id)`;
}


function selectLegacyOverviewToolCounts(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ToolStatusCountRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const toolCallKey = legacyToolCallKeyExpression();
  return db
    .prepare<ToolStatusCountRow>(`
      WITH deduped_tool_events AS (
        SELECT
          ${toolCallKey} AS normalized_event_id,
          session_id,
          tool_name,
          CASE
            WHEN SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'failed'
            WHEN SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) > 0 THEN 'succeeded'
            ELSE 'started'
          END AS status,
          MAX(duration_ms) AS duration_ms
        FROM tool_events
        ${window.whereSql}
        GROUP BY normalized_event_id, session_id, tool_name
      )
      SELECT status, COUNT(*) AS count
      FROM deduped_tool_events
      GROUP BY status
    `)
    .all(...window.params);
}

function selectLegacyToolRankingRows(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): RawToolRankingRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const toolCallKey = legacyToolCallKeyExpression();
  return db
    .prepare<RawToolRankingRow>(`
      WITH deduped_tool_events AS (
        SELECT
          source_vendor AS sourceVendor,
          tool_name AS toolName,
          ${toolCallKey} AS eventId,
          CASE
            WHEN SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0 THEN 1
            ELSE 0
          END AS failures,
          MAX(COALESCE(duration_ms, 0)) AS totalDurationMs
        FROM tool_events
        ${window.whereSql}
        GROUP BY source_vendor, tool_name, eventId
      )
      SELECT
        sourceVendor,
        toolName,
        '' AS sessionId,
        eventId,
        COUNT(*) AS count,
        SUM(failures) AS failures,
        COALESCE(SUM(totalDurationMs), 0) AS totalDurationMs
      FROM deduped_tool_events
      GROUP BY sourceVendor, toolName
      ORDER BY count DESC, toolName ASC
    `)
    .all(...window.params);
}

function selectLegacySourceToolCallCounts(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): SourceToolCountRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const toolCallKey = legacyToolCallKeyExpression();
  return db
    .prepare<SourceToolCountRow>(`
      WITH deduped_tool_events AS (
        SELECT
          source_vendor AS sourceVendor,
          ${toolCallKey} AS eventId,
          MAX(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS hasSucceeded,
          MAX(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS hasFailed
        FROM tool_events
        ${window.whereSql}
        GROUP BY source_vendor, eventId
      )
      SELECT sourceVendor, COUNT(*) AS toolCalls
      FROM deduped_tool_events
      WHERE hasSucceeded = 1 OR hasFailed = 1
      GROUP BY sourceVendor
    `)
    .all(...window.params);
}
