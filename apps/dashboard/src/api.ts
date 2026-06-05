import {
  buildScopeSearchParams,
  DEFAULT_TIME_SCOPE,
  type TimeScopeSelection
} from "./time-scope";

export type SourceVendor = "all" | "claude-code" | "opencode" | "codex" | "cursor";

export type AggregateMeta = {
  mode: TimeScopeSelection["mode"];
  range: TimeScopeSelection["range"];
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
  updatedAt: string;
};

export type TokensByModelRow = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type SourceBreakdownRow = {
  sourceVendor: Exclude<SourceVendor, "all">;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
  toolCalls: number;
};

export type ProviderBreakdownRow = {
  providerHost: string | null;
  providerId: string | null;
  totalTokens: number;
};

export type OverviewResponse = {
  sessionCount: number;
  turnCount: number;
  responseCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokensByModel: TokensByModelRow[];
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  sourceBreakdown: SourceBreakdownRow[];
  providerBreakdown: ProviderBreakdownRow[];
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
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
  turnCount: number;
  totalTokens: number;
  lastModel: string | null;
};

export type SessionDetailResponse = {
  sessionId: string;
  workspacePath: string;
  sourceVendor: string;
  sourceAdapter: string;
  context: {
    executionPath: string | null;
    skillsLoaded: boolean;
    skillNames: string[];
  } | null;
  timeline: SessionTimelineEntry[];
};

export type SessionTimelineEntry = {
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

export type AggregateRowsResponse<T> = AggregateMeta & {
  rows: T[];
};

export type ToolRowsResponse = AggregateRowsResponse<ToolRow>;
export type SessionRowsResponse = AggregateRowsResponse<SessionRow>;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(resolveApiPath(path));

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchOverview(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all"
): Promise<OverviewResponse> {
  return parseOverviewResponse(
    await fetchJson<unknown>(withScope("/api/overview", scope, sourceVendor)),
    "/api/overview"
  );
}

export async function fetchTools(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all"
): Promise<ToolRowsResponse> {
  return parseAggregateRowsResponse<ToolRow>(
    await fetchJson<unknown>(withScope("/api/tools", scope, sourceVendor)),
    "/api/tools"
  );
}

export async function fetchSessions(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all"
): Promise<SessionRowsResponse> {
  return parseAggregateRowsResponse<SessionRow>(
    await fetchJson<unknown>(withScope("/api/sessions", scope, sourceVendor)),
    "/api/sessions"
  );
}

export async function fetchSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  return fetchJson<SessionDetailResponse>(`/api/sessions/${sessionId}`);
}

export function buildExportUrl(format: "csv" | "json"): string {
  return resolveApiPath(`/api/exports/${format}`);
}

function withScope(path: string, scope: TimeScopeSelection, sourceVendor: SourceVendor): string {
  const params = buildScopeSearchParams(scope);
  params.set("sourceVendor", sourceVendor);
  return `${path}?${params.toString()}`;
}

export function resolveApiPath(path: string, currentWindow: Window = window): string {
  const apiBase = resolveApiBase(currentWindow.location.search);

  if (apiBase === null) {
    return path;
  }

  return new URL(trimLeadingSlash(path), withTrailingSlash(apiBase)).toString();
}

function resolveApiBase(search: string): string | null {
  const params = new URLSearchParams(search);
  const apiBase = params.get("apiBase");

  if (!apiBase) {
    return null;
  }

  return apiBase;
}

function trimLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseOverviewResponse(response: unknown, path: string): OverviewResponse {
  const meta = parseAggregateMeta(response, path);
  const payload = response as Record<string, unknown>;

  return {
    ...meta,
    sessionCount: readMetric(payload, "sessionCount"),
    turnCount: readMetric(payload, "turnCount"),
    responseCount: readMetric(payload, "responseCount"),
    totalTokens: readMetric(payload, "totalTokens"),
    inputTokens: readMetric(payload, "inputTokens"),
    outputTokens: readMetric(payload, "outputTokens"),
    cacheReadTokens: readMetric(payload, "cacheReadTokens"),
    cacheCreationTokens: readMetric(payload, "cacheCreationTokens"),
    tokensByModel: parseTokensByModel(payload.tokensByModel),
    totalToolCalls: readMetric(payload, "totalToolCalls"),
    successfulExecutions: readMetric(payload, "successfulExecutions"),
    failedExecutions: readMetric(payload, "failedExecutions"),
    successRate: readMetric(payload, "successRate"),
    editOperationCount: readMetric(payload, "editOperationCount"),
    affectedFileCount: readMetric(payload, "affectedFileCount"),
    insertions: readMetric(payload, "insertions"),
    deletions: readMetric(payload, "deletions"),
    sourceBreakdown: parseSourceBreakdown(payload.sourceBreakdown),
    providerBreakdown: parseProviderBreakdown(payload.providerBreakdown)
  };
}

function parseAggregateRowsResponse<T>(response: unknown, path: string): AggregateRowsResponse<T> {
  if (
    !isRecord(response) ||
    !("rows" in response) ||
    !Array.isArray(response.rows)
  ) {
    throw new Error(`Request failed: scoped aggregate metadata missing for ${path}`);
  }

  return {
    ...parseAggregateMeta(response, path),
    rows: response.rows as T[]
  };
}

function parseAggregateMeta(response: unknown, path: string): AggregateMeta {
  if (
    !isRecord(response) ||
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

  return {
    mode: response.mode,
    range: response.range,
    timezone: response.timezone,
    windowStart: response.windowStart,
    windowEnd: response.windowEnd,
    updatedAt: response.updatedAt
  };
}

function parseTokensByModel(value: unknown): TokensByModelRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        model: typeof entry.model === "string" && entry.model.length > 0 ? entry.model : "unknown",
        totalTokens: readNumber(entry.totalTokens),
        inputTokens: readNumber(entry.inputTokens),
        outputTokens: readNumber(entry.outputTokens),
        cacheReadTokens: readNumber(entry.cacheReadTokens),
        cacheCreationTokens: readNumber(entry.cacheCreationTokens)
      }
    ];
  });
}

function parseSourceBreakdown(value: unknown): SourceBreakdownRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isSourceVendor(entry.sourceVendor)) {
      return [];
    }

    return [
      {
        sourceVendor: entry.sourceVendor,
        sessionCount: readNumber(entry.sessionCount),
        turnCount: readNumber(entry.turnCount),
        totalTokens: readNumber(entry.totalTokens),
        toolCalls: readNumber(entry.toolCalls)
      }
    ];
  });
}

function parseProviderBreakdown(value: unknown): ProviderBreakdownRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        providerHost: readNullableString(entry.providerHost),
        providerId: readNullableString(entry.providerId),
        totalTokens: readNumber(entry.totalTokens)
      }
    ];
  });
}

function readMetric(payload: Record<string, unknown>, key: string): number {
  return readNumber(payload[key]);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeScopeMode(value: string): value is TimeScopeSelection["mode"] {
  return value === "calendar" || value === "rolling" || value === "lifetime";
}

function isSourceVendor(value: unknown): value is SourceBreakdownRow["sourceVendor"] {
  return value === "claude-code" || value === "opencode" || value === "codex" || value === "cursor";
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

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
