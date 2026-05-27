import {
  buildScopeSearchParams,
  DEFAULT_TIME_SCOPE,
  type TimeScopeSelection
} from "./time-scope";

export type AggregateMeta = {
  mode: TimeScopeSelection["mode"];
  range: TimeScopeSelection["range"];
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
  updatedAt: string;
};

export type OverviewResponse = {
  sessionCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
} & AggregateMeta;

export type ToolRow = {
  toolName: string;
  count: number;
  failures: number;
  averageDurationMs: number;
};

export type SessionRow = {
  sessionId: string;
  workspacePath: string;
};

export type SessionDetailResponse = {
  sessionId: string;
  timeline: Array<{
    type: string;
    toolName: string;
    status: string;
    durationMs: number;
    filesChanged: string[];
    insertions: number;
    deletions: number;
  }>;
};

export type AggregateRowsResponse<T> = AggregateMeta & {
  rows: T[];
};

export type ToolRowsResponse = AggregateRowsResponse<ToolRow>;
export type SessionRowsResponse = AggregateRowsResponse<SessionRow>;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchOverview(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE
): Promise<OverviewResponse> {
  return fetchJson<OverviewResponse>(withScope("/api/overview", scope));
}

export async function fetchTools(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE
): Promise<ToolRowsResponse> {
  return parseAggregateRowsResponse<ToolRow>(
    await fetchJson<unknown>(withScope("/api/tools", scope)),
    "/api/tools"
  );
}

export async function fetchSessions(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE
): Promise<SessionRowsResponse> {
  return parseAggregateRowsResponse<SessionRow>(
    await fetchJson<unknown>(withScope("/api/sessions", scope)),
    "/api/sessions"
  );
}

export async function fetchSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  return fetchJson<SessionDetailResponse>(`/api/sessions/${sessionId}`);
}

export function buildExportUrl(format: "csv" | "json"): string {
  return `/api/exports/${format}`;
}

function withScope(path: string, scope: TimeScopeSelection): string {
  return `${path}?${buildScopeSearchParams(scope).toString()}`;
}

function parseAggregateRowsResponse<T>(response: unknown, path: string): AggregateRowsResponse<T> {
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response) ||
    !("rows" in response) ||
    !Array.isArray(response.rows) ||
    !("mode" in response) ||
    !("range" in response) ||
    !("timezone" in response) ||
    !("windowStart" in response) ||
    !("windowEnd" in response) ||
    !("updatedAt" in response) ||
    typeof response.mode !== "string" ||
    typeof response.range !== "string" ||
    typeof response.timezone !== "string" ||
    typeof response.updatedAt !== "string" ||
    !isTimeScopeMode(response.mode) ||
    !isTimeScopeRange(response.range) ||
    !isValidTimeZone(response.timezone) ||
    !isTimestampString(response.updatedAt) ||
    !isNullableTimestamp(response.windowStart) ||
    !isNullableTimestamp(response.windowEnd)
  ) {
    throw new Error(`Request failed: scoped aggregate metadata missing for ${path}`);
  }

  return response as AggregateRowsResponse<T>;
}

function isTimeScopeMode(value: string): value is TimeScopeSelection["mode"] {
  return value === "calendar" || value === "rolling" || value === "lifetime";
}

function isTimeScopeRange(value: string): value is TimeScopeSelection["range"] {
  return value === "day" || value === "week" || value === "month";
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestampString(value);
}

function isTimestampString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
