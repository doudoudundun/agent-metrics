import { dropCursorGenerationShadowedByOfficial } from "./cursor-account-usage.js";
import type { SessionDetailResponse, SessionRow, WidgetSnapshotResponse } from "@agent-metrics/contracts";
import { SessionDetailResponseSchema, WidgetSnapshotResponseSchema } from "@agent-metrics/contracts";
import type { SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";
import type { SqliteDatabaseLike } from "./domain-migrations.js";
import type { SourceVendorFilter } from "./core-types.js";
import { resolveTimeScope, type ResolvedTimeScope } from "./time-scope.js";

type UsageRow = {
  displayedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageSource: string | null;
  occurredAt: string;
};

type ToolRow = {
  status: "started" | "succeeded" | "failed";
};

type EventRow = {
  payloadJson: string;
};

type CanonicalSessionRow = {
  sourceInstanceId: string;
  sessionId: string;
  sourceVendor: SourceVendor;
  workspacePath: string;
  sourceAdapter: SourceAdapter | null;
};

type CanonicalTimelineRow = {
  eventId: string;
  createdAt: string;
  type: string;
  sourceVendor: CanonicalSessionRow["sourceVendor"];
  sourceAdapter: SourceAdapter | null;
  payloadJson: string;
};

type CanonicalSessionListRow = {
  sourceInstanceId: string;
  sessionId: string;
  sourceVendor: CanonicalSessionRow["sourceVendor"];
  workspacePath: string;
  sourceAdapter: SourceAdapter | null;
  lastActivityAt: string;
};

type SessionUsageTotalsRow = {
  sourceInstanceId: string;
  sessionId: string;
  totalTokens: number | null;
};

type LatestUsageRow = {
  sourceInstanceId: string;
  sessionId: string;
  providerId: string | null;
  providerHost: string | null;
  lastModel: string | null;
};

type SessionTurnCountRow = {
  sourceInstanceId: string;
  sessionId: string;
  turnCount: number;
};

type SessionAdapterRow = {
  sourceInstanceId: string;
  sessionId: string;
  sourceAdapter: SourceAdapter;
};

export type SessionListCursor = {
  lastActivityAt: string;
  sourceInstanceId: string;
  sessionId: string;
};

export type TimelineCursor = {
  createdAt: string;
  eventId: string;
};

export type CanonicalSessionListInput = {
  scope: ResolvedTimeScope & { updatedAt: string };
  sourceVendor: SourceVendorFilter;
  limit: number;
  cursor: SessionListCursor | null;
  createCursor: (cursor: SessionListCursor) => string;
};

export type CanonicalSessionDetailInput = {
  sourceInstanceId: string;
  sessionId: string;
  scope: ResolvedTimeScope & { updatedAt: string };
  limit: number;
  cursor: TimelineCursor | null;
  createCursor: (cursor: TimelineCursor) => string;
};

export function isSessionListCursor(value: unknown): value is SessionListCursor {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isTimestamp(value.lastActivityAt) &&
    isNonEmptyString(value.sourceInstanceId) &&
    isNonEmptyString(value.sessionId)
  );
}

export function isTimelineCursor(value: unknown): value is TimelineCursor {
  return isRecord(value) && isTimestamp(value.createdAt) && isNonEmptyString(value.eventId);
}

export function selectWidgetSnapshot(
  db: SqliteDatabaseLike,
  now = new Date(),
  options: { offsetMinutes?: number } = {}
): WidgetSnapshotResponse {
  // Product default: local calendar day (Today), not a rolling 24h window.
  const resolved = resolveTimeScope(
    { mode: "calendar", range: "day" },
    {
      now,
      offsetMinutes: options.offsetMinutes ?? -now.getTimezoneOffset()
    }
  );
  const windowStart = resolved.windowStart ?? new Date(0).toISOString();
  const windowEnd = resolved.windowEnd ?? now.toISOString();

  const sessionCount = readCount(
    db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM domain_sessions
       WHERE started_at >= ? AND started_at < ?`
    ).get(windowStart, windowEnd)
  );
  const usageRows = dropCursorGenerationShadowedByOfficial(
    db
      .prepare<UsageRow>(
        `SELECT
         displayed_input_tokens AS displayedInputTokens,
         output_tokens AS outputTokens,
         cache_read_input_tokens AS cacheReadTokens,
         cache_creation_input_tokens AS cacheCreationTokens,
         usage_source AS usageSource,
         occurred_at AS occurredAt
       FROM usage_events
       WHERE occurred_at >= ? AND occurred_at < ?
         AND usage_measurement = 'increment'`
      )
      .all(windowStart, windowEnd)
      .map((row) => ({
        ...row,
        usageSource: row.usageSource,
        createdAt: row.occurredAt
      }))
  );
  const usage = usageRows.reduce(
    (total, row) => ({
      inputTokens: total.inputTokens + safeCount(row.displayedInputTokens),
      outputTokens: total.outputTokens + safeCount(row.outputTokens),
      cacheReadTokens: total.cacheReadTokens + safeCount(row.cacheReadTokens),
      cacheCreationTokens: total.cacheCreationTokens + safeCount(row.cacheCreationTokens)
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  );
  // Spec section 10.5 indexes tool_calls on (source_instance_id, session_id, started_at).
  // Terminal-only calls have started_at = null and fall outside any rolling window anchored
  // on started_at, so they are excluded by the indexable predicate below. COALESCE would
  // disable the index and is therefore avoided.
  const toolRows = db
    .prepare<ToolRow>(
      `SELECT status
       FROM tool_calls
       WHERE started_at >= ? AND started_at < ?`
    )
    .all(windowStart, windowEnd);
  const codeEditRows = db
    .prepare<EventRow>(
      `SELECT payload_json AS payloadJson
       FROM normalized_events
       WHERE event_type = 'code.edit.applied'
         AND timestamp >= ? AND timestamp < ?`
    )
    .all(windowStart, windowEnd);

  const editStats = codeEditRows.reduce(
    (total, row) => {
      const payload = parseRecord(row.payloadJson);
      const files = Array.isArray(payload?.files_changed) ? payload.files_changed : [];
      return {
        editOperationCount: total.editOperationCount + safeCount(payload?.edit_operation_count),
        affectedFileCount: total.affectedFileCount + files.length
      };
    },
    { editOperationCount: 0, affectedFileCount: 0 }
  );
  // logicalToolCalls counts every projected tool_call row (including in-flight
  // "started" rows). toolSuccessRate matches overview: only terminal outcomes
  // (succeeded/failed) enter the denominator so in-flight calls do not look like failures.
  const logicalToolCalls = toolRows.length;
  const successfulToolCalls = toolRows.filter((row) => row.status === "succeeded").length;
  const failedToolCalls = toolRows.filter((row) => row.status === "failed").length;
  const terminalToolCalls = successfulToolCalls + failedToolCalls;
  const cacheableInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

  return WidgetSnapshotResponseSchema.parse({
    generatedAt: windowEnd,
    scope: {
      mode: "calendar",
      range: "day",
      windowStart,
      windowEnd
    },
    metrics: {
      totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      sessionCount,
      logicalToolCalls,
      cacheHitRate: cacheableInput > 0 ? usage.cacheReadTokens / cacheableInput : 0,
      toolSuccessRate: terminalToolCalls > 0 ? successfulToolCalls / terminalToolCalls : 0,
      editOperationCount: editStats.editOperationCount,
      affectedFileCount: editStats.affectedFileCount
    }
  });
}

export function selectCanonicalSessions(
  db: SqliteDatabaseLike,
  input: CanonicalSessionListInput
): { rows: SessionRow[]; nextCursor: string | null } {
  const activityConditions: string[] = [];
  const activityParams: string[] = [];
  if (input.scope.windowStart !== null && input.scope.windowEnd !== null) {
    activityConditions.push("events.timestamp >= ? AND events.timestamp < ?");
    activityParams.push(input.scope.windowStart, input.scope.windowEnd);
  }
  if (input.sourceVendor !== "all") {
    activityConditions.push("events.source_vendor = ?");
    activityParams.push(input.sourceVendor);
  }
  const cursorCondition = buildSessionCursorCondition(input.cursor);
  const rows = db
    .prepare<CanonicalSessionListRow>(
      `WITH session_activity AS (
        SELECT
          events.source_instance_id AS sourceInstanceId,
          events.session_id AS sessionId,
          MAX(events.timestamp) AS lastActivityAt
        FROM normalized_events AS events
        ${activityConditions.length > 0 ? `WHERE ${activityConditions.join(" AND ")}` : ""}
        GROUP BY events.source_instance_id, events.session_id
      )
      SELECT
        sessions.source_instance_id AS sourceInstanceId,
        sessions.session_id AS sessionId,
        sessions.source_vendor AS sourceVendor,
        sessions.workspace_path AS workspacePath,
        sessions.source_adapter AS sourceAdapter,
        activity.lastActivityAt AS lastActivityAt
      FROM session_activity AS activity
      INNER JOIN domain_sessions AS sessions
        ON sessions.source_instance_id = activity.sourceInstanceId
       AND sessions.session_id = activity.sessionId
      ${cursorCondition.sql}
      ORDER BY activity.lastActivityAt DESC, sessions.source_instance_id ASC, sessions.session_id ASC
      LIMIT ?`
    )
    .all(...activityParams, ...cursorCondition.params, input.limit + 1);
  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);

  return {
    rows: toSessionRows(db, pageRows, input.scope),
    nextCursor:
      rows.length > input.limit && lastRow
        ? input.createCursor({
            lastActivityAt: lastRow.lastActivityAt,
            sourceInstanceId: lastRow.sourceInstanceId,
            sessionId: lastRow.sessionId
          })
        : null
  };
}

export function selectCanonicalSessionDetail(
  db: SqliteDatabaseLike,
  input: CanonicalSessionDetailInput
): SessionDetailResponse | null {
  const session = db
    .prepare<CanonicalSessionRow>(
      `SELECT
         source_instance_id AS sourceInstanceId,
         session_id AS sessionId,
         source_vendor AS sourceVendor,
         workspace_path AS workspacePath,
         source_adapter AS sourceAdapter
       FROM domain_sessions
       WHERE source_instance_id = ? AND session_id = ?`
    )
    .get(input.sourceInstanceId, input.sessionId);
  if (!session) {
    return null;
  }

  const timelineWindow = buildOccurrenceWindow("timestamp", input.scope);
  const timelineCursor = buildTimelineCursorCondition(input.cursor);
  const rowsWithExtra = db
    .prepare<CanonicalTimelineRow>(
      `SELECT
         event_id AS eventId,
         timestamp AS createdAt,
         event_type AS type,
         source_vendor AS sourceVendor,
         source_adapter AS sourceAdapter,
         payload_json AS payloadJson
       FROM normalized_events
       WHERE source_instance_id = ? AND session_id = ?
       ${timelineWindow.sql}
       ${timelineCursor.sql}
       ORDER BY timestamp ASC, event_id ASC
       LIMIT ?`
    )
    .all(
      input.sourceInstanceId,
      input.sessionId,
      ...timelineWindow.params,
      ...timelineCursor.params,
      input.limit + 1
    );
  const rows = rowsWithExtra.slice(0, input.limit);
  const lastRow = rows.at(-1);
  const sourceAdapters = selectSessionAdapters(db, input.sourceInstanceId, input.sessionId, [
    session.sourceAdapter
  ]);

  return SessionDetailResponseSchema.parse({
    mode: input.scope.mode,
    range: input.scope.range,
    timezone: input.scope.timezone,
    windowStart: input.scope.windowStart,
    windowEnd: input.scope.windowEnd,
    updatedAt: input.scope.updatedAt,
    sourceInstanceId: session.sourceInstanceId,
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    sourceVendor: session.sourceVendor,
    sourceAdapters,
    context: null,
    timeline: {
      rows: rows.map((row) => mapTimelineRow(row)),
      nextCursor:
        rowsWithExtra.length > input.limit && lastRow
          ? input.createCursor({ createdAt: lastRow.createdAt, eventId: lastRow.eventId })
          : null
    }
  });
}

function toSessionRows(
  db: SqliteDatabaseLike,
  sessions: CanonicalSessionListRow[],
  scope: ResolvedTimeScope
): SessionRow[] {
  if (sessions.length === 0) {
    return [];
  }

  const page = buildSessionPage(sessions);
  const usageWindow = buildOccurrenceWindow("occurred_at", scope);
  const eventWindow = buildOccurrenceWindow("timestamp", scope);
  const totalsBySession = new Map<string, number>();
  for (const row of db
    .prepare<SessionUsageTotalsRow>(
      `WITH page(source_instance_id, session_id) AS (VALUES ${page.valuesSql})
       SELECT
         usage.source_instance_id AS sourceInstanceId,
         usage.session_id AS sessionId,
         COALESCE(
         SUM(
           usage.displayed_input_tokens + usage.output_tokens +
           usage.cache_read_input_tokens + usage.cache_creation_input_tokens
         ),
         0
       ) AS totalTokens
       FROM usage_events AS usage
       INNER JOIN page
         ON page.source_instance_id = usage.source_instance_id
        AND page.session_id = usage.session_id
       WHERE usage.usage_measurement = 'increment'
       ${usageWindow.sql}
       GROUP BY usage.source_instance_id, usage.session_id`
    )
    .all(...page.params, ...usageWindow.params)) {
    totalsBySession.set(sessionMapKey(row.sourceInstanceId, row.sessionId), safeCount(row.totalTokens));
  }

  const latestUsageBySession = new Map<string, LatestUsageRow>();
  for (const row of db
    .prepare<LatestUsageRow>(
      `WITH page(source_instance_id, session_id) AS (VALUES ${page.valuesSql}),
       ranked_usage AS (
         SELECT
           usage.source_instance_id AS sourceInstanceId,
           usage.session_id AS sessionId,
           usage.provider_id AS providerId,
           usage.provider_host AS providerHost,
           usage.model_id AS lastModel,
           ROW_NUMBER() OVER (
             PARTITION BY usage.source_instance_id, usage.session_id
             ORDER BY usage.occurred_at DESC, usage.event_id DESC
           ) AS rowNumber
         FROM usage_events AS usage
         INNER JOIN page
           ON page.source_instance_id = usage.source_instance_id
          AND page.session_id = usage.session_id
         WHERE 1 = 1
         ${usageWindow.sql}
       )
       SELECT sourceInstanceId, sessionId, providerId, providerHost, lastModel
       FROM ranked_usage
       WHERE rowNumber = 1`
    )
    .all(...page.params, ...usageWindow.params)) {
    latestUsageBySession.set(sessionMapKey(row.sourceInstanceId, row.sessionId), row);
  }

  const turnsBySession = new Map<string, number>();
  for (const row of db
    .prepare<SessionTurnCountRow>(
      `WITH page(source_instance_id, session_id) AS (VALUES ${page.valuesSql})
       SELECT
         events.source_instance_id AS sourceInstanceId,
         events.session_id AS sessionId,
         COUNT(*) AS turnCount
       FROM normalized_events AS events
       INNER JOIN page
         ON page.source_instance_id = events.source_instance_id
        AND page.session_id = events.session_id
       WHERE events.event_type = 'prompt.submitted'
       ${eventWindow.sql}
       GROUP BY events.source_instance_id, events.session_id`
    )
    .all(...page.params, ...eventWindow.params)) {
    turnsBySession.set(sessionMapKey(row.sourceInstanceId, row.sessionId), safeCount(row.turnCount));
  }

  const adaptersBySession = new Map<string, SourceAdapter[]>();
  for (const row of db
    .prepare<SessionAdapterRow>(
      `WITH page(source_instance_id, session_id) AS (VALUES ${page.valuesSql})
       SELECT DISTINCT
         events.source_instance_id AS sourceInstanceId,
         events.session_id AS sessionId,
         events.source_adapter AS sourceAdapter
       FROM normalized_events AS events
       INNER JOIN page
         ON page.source_instance_id = events.source_instance_id
        AND page.session_id = events.session_id
       WHERE events.source_adapter IS NOT NULL
       ORDER BY events.source_adapter ASC`
    )
    .all(...page.params)) {
    const key = sessionMapKey(row.sourceInstanceId, row.sessionId);
    const adapters = adaptersBySession.get(key) ?? [];
    adapters.push(row.sourceAdapter);
    adaptersBySession.set(key, adapters);
  }

  return sessions.map((session) => {
    const key = sessionMapKey(session.sourceInstanceId, session.sessionId);
    const latestUsage = latestUsageBySession.get(key);
    return {
      sourceInstanceId: session.sourceInstanceId,
      sessionId: session.sessionId,
      workspacePath: session.workspacePath,
      sourceVendor: session.sourceVendor,
      sourceAdapters: uniqueAdapters([session.sourceAdapter, ...(adaptersBySession.get(key) ?? [])]),
      providerId: latestUsage?.providerId ?? "unknown",
      providerHost: latestUsage?.providerHost ?? null,
      turnCount: turnsBySession.get(key) ?? 0,
      totalTokens: totalsBySession.get(key) ?? 0,
      lastModel: latestUsage?.lastModel ?? null,
      lastActivityAt: session.lastActivityAt
    };
  });
}

function buildSessionPage(rows: CanonicalSessionListRow[]): {
  valuesSql: string;
  params: string[];
} {
  return {
    valuesSql: rows.map(() => "(?, ?)").join(", "),
    params: rows.flatMap((row) => [row.sourceInstanceId, row.sessionId])
  };
}

function sessionMapKey(sourceInstanceId: string, sessionId: string): string {
  return `${sourceInstanceId}\0${sessionId}`;
}

function selectSessionAdapters(
  db: SqliteDatabaseLike,
  sourceInstanceId: string,
  sessionId: string,
  fallback: Array<SourceAdapter | null | undefined>
): SourceAdapter[] {
  const rows = db
    .prepare<{ sourceAdapter: SourceAdapter | null }>(
      `SELECT DISTINCT source_adapter AS sourceAdapter
       FROM normalized_events
       WHERE source_instance_id = ? AND session_id = ?
         AND source_adapter IS NOT NULL
       ORDER BY source_adapter ASC`
    )
    .all(sourceInstanceId, sessionId);
  return uniqueAdapters([...fallback, ...rows.map((row) => row.sourceAdapter)]);
}

function buildSessionCursorCondition(
  cursor: SessionListCursor | null
): { sql: string; params: string[] } {
  if (cursor === null) {
    return { sql: "", params: [] };
  }
  return {
    sql: `WHERE (
      activity.lastActivityAt < ?
      OR (
        activity.lastActivityAt = ?
        AND (
          sessions.source_instance_id > ?
          OR (sessions.source_instance_id = ? AND sessions.session_id > ?)
        )
      )
    )`,
    params: [
      cursor.lastActivityAt,
      cursor.lastActivityAt,
      cursor.sourceInstanceId,
      cursor.sourceInstanceId,
      cursor.sessionId
    ]
  };
}

function buildTimelineCursorCondition(
  cursor: TimelineCursor | null
): { sql: string; params: string[] } {
  if (cursor === null) {
    return { sql: "", params: [] };
  }
  return {
    sql: "AND (timestamp > ? OR (timestamp = ? AND event_id > ?))",
    params: [cursor.createdAt, cursor.createdAt, cursor.eventId]
  };
}

function buildOccurrenceWindow(
  column: string,
  scope: ResolvedTimeScope
): { sql: string; params: string[] } {
  if (scope.windowStart === null || scope.windowEnd === null) {
    return { sql: "", params: [] };
  }
  return {
    sql: `AND ${column} >= ? AND ${column} < ?`,
    params: [scope.windowStart, scope.windowEnd]
  };
}

function mapTimelineRow(row: CanonicalTimelineRow): Record<string, unknown> {
  const payload = parseRecord(row.payloadJson) ?? {};
  const type = row.type;
  const toolType = type === "tool.called" || type === "tool.succeeded" || type === "tool.failed";
  const inputTokens = safeCountOrNull(payload.input_tokens);
  const outputTokens = safeCountOrNull(payload.output_tokens);
  const cacheReadTokens = safeCountOrNull(payload.cache_read_input_tokens);
  const cacheCreationTokens = safeCountOrNull(payload.cache_creation_input_tokens);
  const displayedInput = safeCountOrNull(payload.displayed_input_tokens) ?? inputTokens;

  return {
    eventId: row.eventId,
    createdAt: row.createdAt,
    type,
    sourceVendor: row.sourceVendor,
    sourceAdapters: uniqueAdapters([row.sourceAdapter]),
    toolCallId: toolType && typeof payload.tool_call_id === "string" ? payload.tool_call_id : null,
    toolName: toolType && typeof payload.tool_name === "string" ? payload.tool_name : null,
    status: typeof payload.status === "string" ? payload.status : null,
    durationMs: safeCountOrNull(payload.duration_ms),
    providerId: typeof payload.provider_id === "string" ? payload.provider_id : null,
    providerHost: typeof payload.provider_host === "string" ? payload.provider_host : null,
    filesChanged: readStringArray(payload.files_changed),
    insertions: safeCountOrNull(payload.insertions),
    deletions: safeCountOrNull(payload.deletions),
    promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
    promptChars: safeCountOrNull(payload.prompt_chars),
    messageId: typeof payload.message_id === "string" ? payload.message_id : null,
    model: typeof payload.model === "string" ? payload.model : null,
    stopReason: typeof payload.stop_reason === "string" ? payload.stop_reason : null,
    responseChars: safeCountOrNull(payload.response_chars),
    inputTokens: displayedInput,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens:
      displayedInput === null || outputTokens === null || cacheReadTokens === null || cacheCreationTokens === null
        ? null
        : displayedInput + outputTokens + cacheReadTokens + cacheCreationTokens,
    usageSource: typeof payload.usage_source === "string" ? payload.usage_source : null
  };
}

function uniqueAdapters(values: Array<SourceAdapter | null | undefined>): SourceAdapter[] {
  return [...new Set(values.filter((value): value is SourceAdapter => value !== null && value !== undefined))];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function safeCountOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readCount(row: { count: number } | undefined): number {
  return safeCount(row?.count);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
