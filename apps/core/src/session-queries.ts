import type { TokenTrendBucket } from "@agent-metrics/contracts";
import type { SourceVendor } from "@agent-metrics/event-schema";
import { estimateCostUsd, isAdditiveUsage } from "@agent-metrics/metrics-engine";
import type { ResolvedTimeScope, TimeScopeRange } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import {
  andWhere,
  buildTimeWindow,
  buildToolActivityWindow,
  TOOL_CALLS_SESSION_JOIN
} from "./query-support.js";
import { selectTokenUsageRows, type TokenUsageOverviewRow } from "./aggregate-queries.js";

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
  lastActivityAt: string;
};

type SourceBreakdownRow = {
  sourceVendor: SourceVendor;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
  toolCalls: number;
  costUsd: number | null;
  cacheHitRate: number;
};

type ProviderBreakdownRow = {
  providerHost: string | null;
  providerId: string | null;
  totalTokens: number;
};

type TokenTrendRow = {
  bucketStart: string;
  bucket: TokenTrendBucket;
  label: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
};

export function selectSessions(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): SessionListRow[] {
  const window = buildTimeWindow("started_at", scope, sourceVendor);

  const sessions = db
    .prepare<Omit<SessionListRow, "totalTokens"> & { sourceInstanceId: string; totalTokens?: number }>(
      `
        SELECT
          sessions.source_instance_id AS sourceInstanceId,
          sessions.session_id AS sessionId,
          sessions.workspace_path AS workspacePath,
          sessions.source_vendor AS sourceVendor,
          sessions.source_adapter AS sourceAdapter,
          COALESCE(prompt_counts.turnCount, 0) AS turnCount,
          0 AS totalTokens,
          latest_usage.providerId AS providerId,
          latest_usage.providerHost AS providerHost,
          latest_usage.lastModel AS lastModel,
          -- MAX() returns NULL when any argument is NULL, so every candidate is
          -- defaulted to '' first and the empty result is turned back into NULL.
          NULLIF(
            MAX(
              COALESCE(sessions.started_at, ''),
              COALESCE(sessions.ended_at, ''),
              COALESCE(
                (SELECT MAX(timestamp) FROM normalized_events
                 WHERE source_instance_id = sessions.source_instance_id
                   AND session_id = sessions.session_id
                   AND event_type = 'prompt.submitted'),
                ''
              ),
              COALESCE(
                (SELECT MAX(COALESCE(started_at, finished_at)) FROM tool_calls
                 WHERE source_instance_id = sessions.source_instance_id
                   AND session_id = sessions.session_id),
                ''
              ),
              COALESCE(
                (SELECT MAX(timestamp) FROM normalized_events
                 WHERE source_instance_id = sessions.source_instance_id
                   AND session_id = sessions.session_id
                   AND event_type = 'assistant.responded'),
                ''
              ),
              COALESCE(
                (SELECT MAX(occurred_at) FROM usage_events
                 WHERE source_instance_id = sessions.source_instance_id
                   AND session_id = sessions.session_id),
                ''
              ),
              COALESCE(
                (SELECT MAX(timestamp) FROM normalized_events
                 WHERE source_instance_id = sessions.source_instance_id
                   AND session_id = sessions.session_id
                   AND event_type = 'code.edit.applied'),
                ''
              )
            ),
            ''
          ) AS lastActivityAt
        FROM domain_sessions AS sessions
        LEFT JOIN (
          SELECT source_instance_id, session_id, COUNT(*) AS turnCount
          FROM normalized_events
          WHERE event_type = 'prompt.submitted'
          GROUP BY source_instance_id, session_id
        ) AS prompt_counts
          ON prompt_counts.source_instance_id = sessions.source_instance_id
         AND prompt_counts.session_id = sessions.session_id
        LEFT JOIN (
          SELECT source_instance_id, session_id, providerId, providerHost, lastModel
          FROM (
            SELECT
              source_instance_id,
              session_id,
              provider_id AS providerId,
              provider_host AS providerHost,
              model_id AS lastModel,
              ROW_NUMBER() OVER (
                PARTITION BY source_instance_id, session_id
                ORDER BY occurred_at DESC, event_id DESC
              ) AS rowNumber
            FROM usage_events
          )
          WHERE rowNumber = 1
        ) AS latest_usage
          ON latest_usage.source_instance_id = sessions.source_instance_id
         AND latest_usage.session_id = sessions.session_id
        ${window.whereSql}
        ORDER BY sessions.started_at DESC
      `
    )
    .all(...window.params);

  if (sessions.length === 0) {
    return [];
  }

  const totalsBySession = new Map<string, number>();
  for (const row of db
    .prepare<{ sourceInstanceId: string; sessionId: string; totalTokens: number | null }>(
      `SELECT
        source_instance_id AS sourceInstanceId,
        session_id AS sessionId,
        SUM(
          displayed_input_tokens + output_tokens +
          cache_read_input_tokens + cache_creation_input_tokens
        ) AS totalTokens
      FROM usage_events
      WHERE usage_measurement = 'increment'
      GROUP BY source_instance_id, session_id`
    )
    .all()) {
    totalsBySession.set(sessionKey(row.sourceInstanceId, row.sessionId), row.totalTokens ?? 0);
  }

  return sessions.map(({ sourceInstanceId, ...session }) => ({
    ...session,
    totalTokens: totalsBySession.get(sessionKey(sourceInstanceId, session.sessionId)) ?? 0
  }));
}

export function selectSourceBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  tokenUsageRows?: readonly TokenUsageOverviewRow[]
): SourceBreakdownRow[] {
  const breakdown = new Map<SourceVendor, SourceBreakdownRow>();
  // Cache hit rate needs cacheable input, which the breakdown row itself does
  // not carry; keep the two counters alongside instead of widening the row.
  const cacheTotals = new Map<SourceVendor, { cacheableInput: number; cacheReadTokens: number }>();

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
      toolCalls: 0,
      // Null until a priced model row contributes, so sources whose models all
      // lack list prices render "—" instead of a misleading $0.00.
      costUsd: null,
      cacheHitRate: 0
    };
    breakdown.set(rowSourceVendor, created);
    return created;
  };

  const sessionWindow = buildTimeWindow("started_at", scope, sourceVendor);
  const eventWindow = buildTimeWindow("timestamp", scope, sourceVendor);
  const toolWindow = buildToolActivityWindow(scope, sourceVendor);

  // domain_sessions keys sessions by (source instance, session id) while the
  // legacy table keyed them by session id alone, so COUNT(DISTINCT ...) keeps
  // the V1 session count.
  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; sessionCount: number }>(`
      SELECT source_vendor AS sourceVendor, COUNT(DISTINCT session_id) AS sessionCount
      FROM domain_sessions
      ${sessionWindow.whereSql}
      GROUP BY source_vendor
    `)
    .all(...sessionWindow.params)) {
    ensureRow(row.sourceVendor).sessionCount = row.sessionCount;
  }

  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; turnCount: number }>(`
      SELECT source_vendor AS sourceVendor, COUNT(*) AS turnCount
      FROM normalized_events
      ${andWhere(eventWindow, "event_type = 'prompt.submitted'")}
      GROUP BY source_vendor
    `)
    .all(...eventWindow.params)) {
    ensureRow(row.sourceVendor).turnCount = row.turnCount;
  }

  for (const row of db
    .prepare<{ sourceVendor: SourceVendor; toolCalls: number }>(`
      SELECT domain_sessions.source_vendor AS sourceVendor, COUNT(*) AS toolCalls
      ${TOOL_CALLS_SESSION_JOIN}
      ${andWhere(toolWindow, "tool_calls.status IN ('succeeded', 'failed')")}
      GROUP BY domain_sessions.source_vendor
    `)
    .all(...toolWindow.params)) {
    ensureRow(row.sourceVendor).toolCalls = row.toolCalls;
  }

  for (const row of tokenUsageRows ?? selectTokenUsageRows(db, scope, sourceVendor)) {
    if (!isAdditiveUsage(row)) {
      continue;
    }
    const target = ensureRow(row.source_vendor);
    target.totalTokens +=
      row.input_tokens +
      row.output_tokens +
      row.cache_read_input_tokens +
      row.cache_creation_input_tokens;
    const cacheableInput =
      row.input_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
    const sourceCacheTotals = cacheTotals.get(row.source_vendor) ?? {
      cacheableInput: 0,
      cacheReadTokens: 0
    };
    sourceCacheTotals.cacheableInput += cacheableInput;
    sourceCacheTotals.cacheReadTokens += row.cache_read_input_tokens;
    cacheTotals.set(row.source_vendor, sourceCacheTotals);
    // input_tokens already carries the displayed (gross-adjusted) input, which
    // is what the price table expects since cache reads are priced separately.
    const costUsd = estimateCostUsd({
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_input_tokens,
      cacheCreationTokens: row.cache_creation_input_tokens,
      serviceTier: row.service_tier
    });
    if (costUsd !== null) {
      target.costUsd = (target.costUsd ?? 0) + costUsd;
    }
  }

  return [...breakdown.values()]
    .map((row) => {
      const totals = cacheTotals.get(row.sourceVendor);
      return {
        ...row,
        cacheHitRate:
          totals !== undefined && totals.cacheableInput > 0
            ? totals.cacheReadTokens / totals.cacheableInput
            : 0
      };
    })
    .sort((left, right) => left.sourceVendor.localeCompare(right.sourceVendor));
}

export function selectProviderBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  tokenUsageRows?: readonly TokenUsageOverviewRow[]
): ProviderBreakdownRow[] {
  const grouped = new Map<string, ProviderBreakdownRow>();

  for (const row of tokenUsageRows ?? selectTokenUsageRows(db, scope, sourceVendor)) {
    if (!isAdditiveUsage(row)) {
      continue;
    }

    const key = `${row.provider_host ?? ""}\0${row.provider_id ?? ""}`;
    const current = grouped.get(key) ?? {
      providerHost: row.provider_host,
      providerId: row.provider_id,
      totalTokens: 0
    };
    current.totalTokens +=
      row.input_tokens +
      row.output_tokens +
      row.cache_read_input_tokens +
      row.cache_creation_input_tokens;
    grouped.set(key, current);
  }

  return [...grouped.values()].sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      (left.providerHost ?? "").localeCompare(right.providerHost ?? "") ||
      (left.providerId ?? "").localeCompare(right.providerId ?? "")
  );
}

export function selectTokenTrend(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): TokenTrendRow[] {
  const rows = selectTokenUsageRows(db, scope, sourceVendor);
  if (rows.length === 0) {
    return [];
  }

  // Bucket granularity follows the window span: hour <= 48h, day <= 45d,
  // week <= 400d, natural month beyond that (including lifetime).
  const bucketType = resolveTokenTrendBucketType(scope);
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: scope?.timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  });
  const buckets = new Map<string, TokenTrendRow>();

  for (const row of rows) {
    // Session-context snapshots (cursor-composer-context) MUST NOT contribute
    // to additive trend totals (spec sections 9.5 and 9.6). The window query
    // drops them already; the guard keeps the rule at the point of use.
    if (!isAdditiveUsage(row)) {
      continue;
    }
    const bucket = resolveTokenTrendBucket(row.created_at, formatter, bucketType);
    const current = buckets.get(bucket.key) ?? {
      bucketStart: row.created_at,
      bucket: bucket.bucket,
      label: bucket.label,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: 0
    };

    current.inputTokens += row.input_tokens;
    current.outputTokens += row.output_tokens;
    current.cacheReadTokens += row.cache_read_input_tokens;
    current.cacheCreationTokens += row.cache_creation_input_tokens;
    current.totalTokens +=
      row.input_tokens +
      row.output_tokens +
      row.cache_read_input_tokens +
      row.cache_creation_input_tokens;
    buckets.set(bucket.key, current);
  }

  return Array.from(buckets.values()).map((row) => {
    const cacheableInput = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;

    return {
      ...row,
      cacheHitRate: cacheableInput > 0 ? row.cacheReadTokens / cacheableInput : 0
    };
  });
}

function sessionKey(sourceInstanceId: string, sessionId: string): string {
  return `${sourceInstanceId}\0${sessionId}`;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_BUCKET_MAX_MS = 48 * HOUR_MS;
const DAY_BUCKET_MAX_MS = 45 * DAY_MS;
const WEEK_BUCKET_MAX_MS = 400 * DAY_MS;

// Calendar and rolling windows are partial while they are still running (a
// calendar week is only hours old on Monday morning), so presets bucket on
// their nominal duration to keep one granularity across the whole range.
const PRESET_RANGE_MS: Record<TimeScopeRange, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS
};

function resolveTokenTrendBucketType(scope?: ResolvedTimeScope): TokenTrendBucket {
  const spanMs = resolveTokenTrendSpanMs(scope);

  if (spanMs <= HOUR_BUCKET_MAX_MS) {
    return "hour";
  }
  if (spanMs <= DAY_BUCKET_MAX_MS) {
    return "day";
  }
  if (spanMs <= WEEK_BUCKET_MAX_MS) {
    return "week";
  }
  return "month";
}

function resolveTokenTrendSpanMs(scope?: ResolvedTimeScope): number {
  if (!scope || scope.mode === "lifetime") {
    // Unbounded windows (lifetime, unscoped) take the coarsest bucket.
    return Number.POSITIVE_INFINITY;
  }

  const nominalMs = scope.range ? PRESET_RANGE_MS[scope.range] : 0;
  if (!scope.windowStart || !scope.windowEnd) {
    return scope.mode === "custom" ? Number.POSITIVE_INFINITY : nominalMs;
  }

  const actualMs = Date.parse(scope.windowEnd) - Date.parse(scope.windowStart);
  return Number.isFinite(actualMs) ? Math.max(actualMs, nominalMs) : Number.POSITIVE_INFINITY;
}

function resolveTokenTrendBucket(
  createdAt: string,
  formatter: Intl.DateTimeFormat,
  bucketType: TokenTrendBucket
): { key: string; label: string; bucket: TokenTrendBucket } {
  const date = new Date(createdAt);
  const parts = formatter.formatToParts(date);
  const year = readDatePart(parts, "year");
  const month = readDatePart(parts, "month");
  const day = readDatePart(parts, "day");

  if (bucketType === "hour") {
    const hour = readDatePart(parts, "hour");

    return {
      key: `${year}-${month}-${day} ${hour}`,
      label: `${month}-${day} ${hour}:00`,
      bucket: "hour"
    };
  }

  if (bucketType === "week") {
    const week = resolveLocalWeek(year, month, day);

    return { key: week.key, label: week.label, bucket: "week" };
  }

  if (bucketType === "month") {
    return {
      key: `${year}-${month}`,
      label: `${year}-${month}`,
      bucket: "month"
    };
  }

  return {
    key: `${year}-${month}-${day}`,
    label: `${month}-${day}`,
    bucket: "day"
  };
}

/**
 * Monday-start week of the scope-local calendar date. The part values are
 * already local, so the weekday comes from the date rather than the UTC instant.
 */
function resolveLocalWeek(year: string, month: string, day: string): { key: string; label: string } {
  const localDayMs = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const mondayOffsetDays = (new Date(localDayMs).getUTCDay() + 6) % 7;
  const weekStartMs = localDayMs - mondayOffsetDays * DAY_MS;
  const start = new Date(weekStartMs);
  const end = new Date(weekStartMs + 6 * DAY_MS);
  const startMonth = start.getUTCMonth() + 1;
  const startDay = start.getUTCDate();
  const endMonth = end.getUTCMonth() + 1;
  const endDay = end.getUTCDate();

  return {
    key: `${start.getUTCFullYear()}-${padTwo(startMonth)}-${padTwo(startDay)}`,
    label: `${startMonth}/${startDay}-${endMonth}/${endDay}`
  };
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function readDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: "year" | "month" | "day" | "hour"
): string {
  const value = parts.find((entry) => entry.type === type)?.value;

  if (!value) {
    throw new Error(`Missing ${type} in formatted date parts.`);
  }

  return value;
}
