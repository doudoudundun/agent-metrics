import type { TokenTrendBucket } from "@agent-metrics/contracts";
import type { SourceVendor } from "@agent-metrics/event-schema";
import {
  estimateCostUsd,
  isAdditiveUsage,
  resolveDisplayedInputTokens,
  resolveTotalTokens
} from "@agent-metrics/metrics-engine";
import type { ResolvedTimeScope, TimeScopeRange } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import { dropCursorGenerationShadowedByOfficial } from "./cursor-account-usage.js";
import { buildTimeWindow } from "./query-support.js";
import { selectSourceToolCallCounts } from "./tool-query-support.js";
import type { TokenUsageOverviewRow } from "./aggregate-queries.js";

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

type TokenTrendUsageRow = {
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sourceVendor: SourceVendor;
  usageSource: string | null;
};

export function selectSessions(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): SessionListRow[] {
  const window = buildTimeWindow("started_at", scope, sourceVendor);

  const sessions = db
    .prepare<Omit<SessionListRow, "totalTokens"> & { totalTokens?: number }>(
      `
        SELECT
          sessions.session_id AS sessionId,
          sessions.workspace_path AS workspacePath,
          sessions.source_vendor AS sourceVendor,
          sessions.source_adapter AS sourceAdapter,
          COALESCE(prompt_counts.turnCount, 0) AS turnCount,
          0 AS totalTokens,
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
          ) AS lastModel,
          MAX(
            sessions.started_at,
            COALESCE((SELECT MAX(created_at) FROM prompt_events WHERE session_id = sessions.session_id), sessions.started_at),
            COALESCE(
              (SELECT MAX(COALESCE(started_at, finished_at)) FROM tool_calls WHERE session_id = sessions.session_id),
              (SELECT MAX(created_at) FROM tool_events WHERE session_id = sessions.session_id),
              sessions.started_at
            ),
            COALESCE((SELECT MAX(created_at) FROM assistant_responses WHERE session_id = sessions.session_id), sessions.started_at),
            COALESCE((SELECT MAX(created_at) FROM token_usage_events WHERE session_id = sessions.session_id), sessions.started_at),
            COALESCE((SELECT MAX(created_at) FROM code_edits WHERE session_id = sessions.session_id), sessions.started_at)
          ) AS lastActivityAt
        FROM sessions
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS turnCount
          FROM prompt_events
          GROUP BY session_id
        ) AS prompt_counts
          ON prompt_counts.session_id = sessions.session_id
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
    .prepare<{
      session_id: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      source_vendor: SourceVendor;
      usage_source: string | null;
    }>(
      `SELECT
        session_id,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        source_vendor,
        usage_source
      FROM token_usage_events`
    )
    .all()) {
    if (!isAdditiveUsage(row)) {
      continue;
    }
    totalsBySession.set(
      row.session_id,
      (totalsBySession.get(row.session_id) ?? 0) + resolveTotalTokens(row)
    );
  }

  return sessions.map((session) => ({
    ...session,
    totalTokens: totalsBySession.get(session.sessionId) ?? 0
  }));
}

export function selectSourceBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  tokenUsageRows?: readonly TokenUsageOverviewRow[]
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
      toolCalls: 0,
      // Null until a priced model row contributes, so sources whose models all
      // lack list prices render "—" instead of a misleading $0.00.
      costUsd: null
    };
    breakdown.set(rowSourceVendor, created);
    return created;
  };

  const sessionWindow = buildTimeWindow("started_at", scope, sourceVendor);
  const promptWindow = buildTimeWindow("created_at", scope, sourceVendor);
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

  for (const row of selectSourceToolCallCounts(db, scope, sourceVendor)) {
    ensureRow(row.sourceVendor).toolCalls = row.toolCalls;
  }

  for (const row of tokenUsageRows ?? dropCursorGenerationShadowedByOfficial(
    db
      .prepare<{
        source_vendor: SourceVendor;
        model: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        usage_source: string | null;
        created_at: string;
      }>(`
      SELECT
        source_vendor,
        model,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        usage_source,
        created_at
      FROM token_usage_events
      ${tokenWindow.whereSql}
    `)
      .all(...tokenWindow.params)
  )) {
    if (!isAdditiveUsage(row)) {
      continue;
    }
    const usage = {
      source_vendor: row.source_vendor,
      usage_source: row.usage_source,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens
    };
    const target = ensureRow(row.source_vendor);
    target.totalTokens += resolveTotalTokens(usage);
    const costUsd = estimateCostUsd({
      model: row.model,
      inputTokens: resolveDisplayedInputTokens(usage),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens
    });
    if (costUsd !== null) {
      target.costUsd = (target.costUsd ?? 0) + costUsd;
    }
  }

  return [...breakdown.values()].sort((left, right) => left.sourceVendor.localeCompare(right.sourceVendor));
}

export function selectProviderBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  tokenUsageRows?: readonly TokenUsageOverviewRow[]
): ProviderBreakdownRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const grouped = new Map<string, ProviderBreakdownRow>();

  for (const row of tokenUsageRows ?? dropCursorGenerationShadowedByOfficial(
    db
      .prepare<{
        provider_host: string | null;
        provider_id: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        source_vendor: SourceVendor;
        usage_source: string | null;
        created_at: string;
      }>(`
      SELECT
        provider_host,
        provider_id,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        source_vendor,
        usage_source,
        created_at
      FROM token_usage_events
      ${window.whereSql}
    `)
      .all(...window.params)
  )) {
    if (!isAdditiveUsage(row)) {
      continue;
    }

    const key = `${row.provider_host ?? ""}\0${row.provider_id ?? ""}`;
    const current = grouped.get(key) ?? {
      providerHost: row.provider_host,
      providerId: row.provider_id,
      totalTokens: 0
    };
    current.totalTokens += resolveTotalTokens(row);
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
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const rows = db
    .prepare<TokenTrendUsageRow>(`
      SELECT
        created_at AS createdAt,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_input_tokens AS cacheReadTokens,
        cache_creation_input_tokens AS cacheCreationTokens,
        source_vendor AS sourceVendor,
        usage_source AS usageSource
      FROM token_usage_events
      ${window.whereSql}
      ORDER BY created_at ASC, event_id ASC
    `)
    .all(...window.params);

  const countableRows = dropCursorGenerationShadowedByOfficial(rows);
  if (countableRows.length === 0) {
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

  for (const row of countableRows) {
    // Session-context snapshots (cursor-composer-context) MUST NOT contribute
    // to additive trend totals (spec sections 9.5 and 9.6).
    if (row.usageSource === "cursor-composer-context") {
      continue;
    }
    const bucket = resolveTokenTrendBucket(row.createdAt, formatter, bucketType);
    const displayedInputTokens = resolveDisplayedInputTokens({
      source_vendor: row.sourceVendor,
      usage_source: row.usageSource,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cache_creation_input_tokens: row.cacheCreationTokens,
      cache_read_input_tokens: row.cacheReadTokens
    });
    const current = buckets.get(bucket.key) ?? {
      bucketStart: row.createdAt,
      bucket: bucket.bucket,
      label: bucket.label,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: 0
    };

    current.inputTokens += displayedInputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.cacheCreationTokens += row.cacheCreationTokens;
    current.totalTokens +=
      displayedInputTokens +
      row.outputTokens +
      row.cacheReadTokens +
      row.cacheCreationTokens;
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
