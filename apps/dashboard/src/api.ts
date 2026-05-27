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

type RowEnvelope<T> = T[] | AggregateRowsResponse<T>;

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
  return rowsFromResponse(
    await fetchJson<RowEnvelope<ToolRow>>(withScope("/api/tools", scope)),
    scope
  );
}

export async function fetchSessions(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE
): Promise<SessionRowsResponse> {
  return rowsFromResponse(
    await fetchJson<RowEnvelope<SessionRow>>(withScope("/api/sessions", scope)),
    scope
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

function rowsFromResponse<T>(
  response: RowEnvelope<T>,
  scope: TimeScopeSelection
): AggregateRowsResponse<T> {
  if (!Array.isArray(response)) {
    return response;
  }

  return {
    ...buildLegacyMeta(scope),
    rows: response
  };
}

function buildLegacyMeta(scope: TimeScopeSelection): AggregateMeta {
  return {
    mode: scope.mode,
    range: scope.range,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    windowStart: null,
    windowEnd: null,
    updatedAt: new Date().toISOString()
  };
}
