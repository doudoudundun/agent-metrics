import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TokenTrendBucketSchema, type TokenTrendBucket } from "@agent-metrics/contracts";
import { resolveTimeScope, type ResolvedTimeScope } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";

export type ScopeInput = {
  now?: () => Date;
  timezone?: string;
  offsetMinutes?: number;
};

export type TimeWindow = {
  whereSql: string;
  params: string[];
};

type PageCursorEnvelope = {
  filter: string;
  sortKey: unknown;
  version: number;
};

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor.");
    this.name = "InvalidCursorError";
  }
}

export function buildTimeWindow(
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

/**
 * tool_calls is keyed by (source_instance_id, session_id) and carries no vendor
 * column, so tool aggregates join the owning session row to filter and group by
 * source vendor.
 */
export const TOOL_CALLS_SESSION_JOIN = `
  FROM tool_calls
  INNER JOIN domain_sessions
    ON domain_sessions.source_instance_id = tool_calls.source_instance_id
   AND domain_sessions.session_id = tool_calls.session_id
`;

/**
 * Tool activity is dated by COALESCE(started_at, finished_at): a call observed
 * only through its terminal event has no started_at but still belongs to the
 * window. idx_tool_calls_activity_at covers the expression.
 */
export function buildToolActivityWindow(
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): TimeWindow {
  return buildTimeWindow(
    "COALESCE(tool_calls.started_at, tool_calls.finished_at)",
    scope,
    sourceVendor,
    "domain_sessions.source_vendor"
  );
}

/**
 * buildTimeWindow emits either an empty string or a leading " WHERE ...", so an
 * extra predicate has to join the window clause when one exists and open its own
 * WHERE clause when it does not.
 */
export function andWhere(window: TimeWindow, predicate: string): string {
  return window.whereSql.length > 0 ? `${window.whereSql} AND ${predicate}` : ` WHERE ${predicate}`;
}

export function resolveRequestScope(
  query: unknown,
  input: ScopeInput
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

export function withScopeMetadata<T extends object>(
  payload: T,
  scope: ResolvedTimeScope & { updatedAt: string }
): T & {
  mode: ResolvedTimeScope["mode"];
  range: ResolvedTimeScope["range"];
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
  bucket?: TokenTrendBucket;
  updatedAt: string;
} {
  const bucket = readRowBucket(payload);

  return {
    ...payload,
    ...(bucket ? { bucket } : {}),
    mode: scope.mode,
    range: scope.range,
    timezone: scope.timezone,
    windowStart: scope.windowStart,
    windowEnd: scope.windowEnd,
    updatedAt: scope.updatedAt
  };
}

/**
 * Trend rows carry their own granularity; promote it to the envelope when every
 * row agrees so clients can size axis density without re-deriving the window.
 */
function readRowBucket(payload: object): TokenTrendBucket | null {
  const rows = (payload as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const bucket = (rows[0] as { bucket?: unknown } | undefined)?.bucket;
  const parsed = TokenTrendBucketSchema.safeParse(bucket);
  if (!parsed.success) {
    return null;
  }

  return rows.every((row) => (row as { bucket?: unknown }).bucket === parsed.data)
    ? parsed.data
    : null;
}

export function queryRecord(query: unknown): Record<string, unknown> {
  return query && typeof query === "object" ? (query as Record<string, unknown>) : {};
}

export function readPageLimit(query: unknown): number | null {
  const value = queryRecord(query).limit;
  if (value === undefined) {
    return 50;
  }
  if (Array.isArray(value) || typeof value !== "string" || !/^\d+$/u.test(value)) {
    return null;
  }
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 200 ? limit : null;
}

export function readPageCursor<T>(
  query: unknown,
  filter: unknown,
  isSortKey: (value: unknown) => value is T
): T | null {
  const value = queryRecord(query).cursor;
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new InvalidCursorError();
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new InvalidCursorError();
  }

  let envelope: PageCursorEnvelope;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new InvalidCursorError();
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isPageCursorEnvelope(parsed)) {
      throw new InvalidCursorError();
    }
    envelope = parsed;
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw error;
    }
    throw new InvalidCursorError();
  }

  if (envelope.version !== 1 || envelope.filter !== createFilterFingerprint(filter) || !isSortKey(envelope.sortKey)) {
    throw new InvalidCursorError();
  }
  return envelope.sortKey;
}

export function createPageCursor(filter: unknown, sortKey: unknown): string {
  return Buffer.from(
    canonicalJson({
      filter: createFilterFingerprint(filter),
      sortKey,
      version: 1
    }),
    "utf8"
  ).toString("base64url");
}

export function readScalar(db: MetricsDatabase, sql: string): number {
  const row = db.prepare<{ count: number }>(sql).get();
  return typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count >= 0
    ? row.count
    : 0;
}

export function resolveSourceVendor(query: unknown): SourceVendorFilter {
  const value = queryRecord(query).sourceVendor;
  if (typeof value !== "string" || value.length === 0 || value === "all") {
    return "all";
  }
  // Keep the requested vendor even when event-schema dist is stale, so the
  // dashboard cannot silently fall back to all-sources aggregates.
  return value as SourceVendorFilter;
}

export function parseFilesChanged(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function createFilterFingerprint(filter: unknown): string {
  return createHash("sha256").update(canonicalJson(filter)).digest("base64url");
}

function isPageCursorEnvelope(value: unknown): value is PageCursorEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.filter === "string" &&
    typeof record.version === "number" &&
    Object.prototype.hasOwnProperty.call(record, "sortKey")
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cursor data must contain finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Cursor data must be JSON-compatible.");
}
