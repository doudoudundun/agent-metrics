import type { SourceVendor } from "@agent-metrics/event-schema";
import type { ResolvedTimeScope } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import { buildTimeWindow, readScalar } from "./query-support.js";

type TimeWindow = {
  whereSql: string;
  params: string[];
};

type OverviewToolRow = {
  event_id: string;
  session_id: string;
  tool_name: string;
  status: string;
  duration_ms: number | null;
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
  return readScalar(db, "SELECT COUNT(*) AS count FROM tool_calls") > 0;
}

export function selectOverviewToolEvents(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): OverviewToolRow[] {
  if (hasDomainToolCalls(db)) {
    const window = buildToolCallsWindow(scope, sourceVendor);
    return db
      .prepare<OverviewToolRow>(`
        SELECT
          tool_calls.tool_call_id AS event_id,
          tool_calls.session_id,
          tool_calls.tool_name,
          tool_calls.status,
          tool_calls.duration_ms
        ${TOOL_CALLS_JOIN}
        ${window.whereSql}
      `)
      .all(...window.params);
  }

  return selectLegacyOverviewToolEvents(db, scope, sourceVendor);
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
          tool_calls.session_id AS sessionId,
          tool_calls.tool_call_id AS eventId,
          1 AS count,
          CASE WHEN tool_calls.status = 'failed' THEN 1 ELSE 0 END AS failures,
          COALESCE(tool_calls.duration_ms, 0) AS totalDurationMs
        ${TOOL_CALLS_JOIN}
        ${window.whereSql}
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


function selectLegacyOverviewToolEvents(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): OverviewToolRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const toolCallKey = legacyToolCallKeyExpression();
  return db
    .prepare<OverviewToolRow>(`
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
      SELECT
        normalized_event_id AS event_id,
        session_id,
        tool_name,
        status,
        duration_ms
      FROM deduped_tool_events
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
