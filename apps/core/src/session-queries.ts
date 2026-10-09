import type { SourceVendor } from "@agent-metrics/event-schema";
import {
  estimateCostUsd,
  isAdditiveUsage,
  resolveDisplayedInputTokens,
  resolveTotalTokens
} from "@agent-metrics/metrics-engine";
import type { ResolvedTimeScope } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import { dropCursorGenerationShadowedByOfficial } from "./cursor-account-usage.js";
import { buildTimeWindow } from "./query-support.js";
import { selectSourceToolCallCounts } from "./tool-query-support.js";

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
  costUsd: number;
};

type ProviderBreakdownRow = {
  providerHost: string | null;
  providerId: string | null;
  totalTokens: number;
};

type TokenTrendRow = {
  bucketStart: string;
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
      toolCalls: 0,
      costUsd: 0
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

  for (const row of dropCursorGenerationShadowedByOfficial(
    db
      .prepare<{
        sourceVendor: SourceVendor;
        model: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        usage_source: string | null;
        created_at: string;
      }>(`
      SELECT
        source_vendor AS sourceVendor,
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
      source_vendor: row.sourceVendor,
      usage_source: row.usage_source,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens
    };
    const target = ensureRow(row.sourceVendor);
    target.totalTokens += resolveTotalTokens(usage);
    const costUsd = estimateCostUsd({
      model: row.model,
      inputTokens: resolveDisplayedInputTokens(usage),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens
    });
    if (costUsd !== null) {
      target.costUsd += costUsd;
    }
  }

  return [...breakdown.values()].sort((left, right) => left.sourceVendor.localeCompare(right.sourceVendor));
}

export function selectProviderBreakdown(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ProviderBreakdownRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const grouped = new Map<string, ProviderBreakdownRow>();

  for (const row of dropCursorGenerationShadowedByOfficial(
    db
      .prepare<{
        providerHost: string | null;
        providerId: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        source_vendor: SourceVendor;
        usage_source: string | null;
        created_at: string;
      }>(`
      SELECT
        provider_host AS providerHost,
        provider_id AS providerId,
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

    const key = `${row.providerHost ?? ""}\0${row.providerId ?? ""}`;
    const current = grouped.get(key) ?? {
      providerHost: row.providerHost,
      providerId: row.providerId,
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

  // Hourly buckets only for a single-day scope (Today / Last 24h).
  // Lifetime still sends range=day as a placeholder — force daily buckets there,
  // otherwise years of hourly points make the chart unusable.
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
    const bucket = resolveTokenTrendBucket(row.createdAt, formatter, bucketType, {
      includeYearInDayLabel: shouldIncludeYearInDayLabel(scope)
    });
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

function shouldIncludeYearInDayLabel(scope?: ResolvedTimeScope): boolean {
  if (!scope || scope.mode === "lifetime") {
    return scope?.mode === "lifetime";
  }
  if (scope.mode === "custom" && scope.windowStart && scope.windowEnd) {
    const spanMs = Date.parse(scope.windowEnd) - Date.parse(scope.windowStart);
    return Number.isFinite(spanMs) && spanMs > 366 * 24 * 60 * 60 * 1000;
  }
  return false;
}

function resolveTokenTrendBucketType(scope?: ResolvedTimeScope): "hour" | "day" {
  if (!scope || scope.mode === "lifetime") {
    return "day";
  }
  if (scope.mode === "custom") {
    if (!scope.windowStart || !scope.windowEnd) {
      return "day";
    }
    const spanMs = Date.parse(scope.windowEnd) - Date.parse(scope.windowStart);
    return Number.isFinite(spanMs) && spanMs <= 36 * 60 * 60 * 1000 ? "hour" : "day";
  }
  return scope.range === "day" ? "hour" : "day";
}

function resolveTokenTrendBucket(
  createdAt: string,
  formatter: Intl.DateTimeFormat,
  bucketType: "hour" | "day",
  options: { includeYearInDayLabel?: boolean } = {}
): { key: string; label: string } {
  const date = new Date(createdAt);
  const parts = formatter.formatToParts(date);
  const year = readDatePart(parts, "year");
  const month = readDatePart(parts, "month");
  const day = readDatePart(parts, "day");
  const hour = readDatePart(parts, "hour");

  if (bucketType === "hour") {
    return {
      key: `${year}-${month}-${day} ${hour}`,
      label: `${month}-${day} ${hour}:00`
    };
  }

  return {
    key: `${year}-${month}-${day}`,
    label: options.includeYearInDayLabel ? `${year}-${month}-${day}` : `${month}-${day}`
  };
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
