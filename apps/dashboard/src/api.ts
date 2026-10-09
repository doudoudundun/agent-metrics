import {
  ApiErrorResponseSchema,
  CursorAccountUsageResponseSchema,
  ManualSyncResponseSchema,
  OverviewResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
  SyncRunResponseSchema,
  SyncStatusResponseSchema,
  TokenTrendResponseSchema,
  ToolsResponseSchema,
  WidgetSnapshotResponseSchema,
  type ManualSyncResponse,
  type CursorAccountUsageResponse,
  type SourceVendor as EventSourceVendor,
  type OverviewResponse,
  type SessionDetailResponse,
  type SessionsResponse,
  type SyncRunResponse,
  type SyncStatusResponse,
  type TokenTrendResponse,
  type ToolsResponse,
  type WidgetSnapshotResponse
} from "@agent-metrics/contracts";
import { getLocalAccessToken } from "./desktop-mode";
import {
  buildScopeSearchParams,
  DEFAULT_TIME_SCOPE,
  type TimeScopeSelection
} from "./time-scope";

export type SourceVendor = "all" | EventSourceVendor;
export type {
  ManualSyncResponse,
  CursorAccountUsageResponse,
  OverviewResponse,
  SessionDetailResponse,
  SessionsResponse,
  SyncRunResponse,
  SyncStatusResponse,
  TokenTrendResponse,
  ToolsResponse,
  WidgetSnapshotResponse
};
export type ToolRow = ToolsResponse["rows"][number];
export type TokenTrendPoint = TokenTrendResponse["rows"][number];
export type SessionRow = SessionsResponse["rows"][number];
export type TokensByModelRow = OverviewResponse["tokensByModel"][number];
export type SourceBreakdownRow = OverviewResponse["sourceBreakdown"][number];
export type ProviderBreakdownRow = OverviewResponse["providerBreakdown"][number];

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const SYNC_RUN_FETCH_TIMEOUT_MS = 60_000;

async function fetchContractJson(
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const { timeoutMs: requestedTimeoutMs, signal: callerSignal, ...requestInit } = init ?? {};
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  const timeoutMs = requestedTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  try {
    const token = getLocalAccessToken();
    const headers = new Headers(requestInit.headers);
    if (token) {
      headers.set("X-Agent-Metrics-Token", token);
    }
    const response = await fetch(resolveApiPath(path), {
      ...requestInit,
      headers,
      signal: controller.signal
    });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsedError = ApiErrorResponseSchema.safeParse(payload);
      if (parsedError.success) {
        throw new Error(parsedError.data.error.message);
      }
      throw new Error(`Request failed: ${response.status}`);
    }

    return payload;
  } catch (error) {
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseContractResponse<T>(
  response: unknown,
  schema: { parse(value: unknown): T },
  path: string
): T {
  try {
    return schema.parse(response);
  } catch {
    throw new Error(`Request failed: invalid response for ${path}`);
  }
}

export async function fetchOverview(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all",
  signal?: AbortSignal
): Promise<OverviewResponse> {
  return parseContractResponse(
    await fetchContractJson(withScope("/api/overview", scope, sourceVendor), { signal }),
    OverviewResponseSchema,
    "/api/overview"
  );
}

export async function fetchTools(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all",
  signal?: AbortSignal
): Promise<ToolsResponse> {
  return parseContractResponse(
    await fetchContractJson(withScope("/api/tools", scope, sourceVendor), { signal }),
    ToolsResponseSchema,
    "/api/tools"
  );
}

export async function fetchTokenTrend(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all",
  signal?: AbortSignal
): Promise<TokenTrendResponse> {
  return parseContractResponse(
    await fetchContractJson(withScope("/api/token-trend", scope, sourceVendor), { signal }),
    TokenTrendResponseSchema,
    "/api/token-trend"
  );
}

export async function fetchSessions(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all",
  signal?: AbortSignal
): Promise<SessionsResponse> {
  return parseContractResponse(
    await fetchContractJson(withScope("/api/sessions", scope, sourceVendor), { signal }),
    SessionsResponseSchema,
    "/api/sessions"
  );
}

export async function fetchSessionDetail(
  sourceInstanceId: string,
  sessionId: string,
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  limit = 50,
  signal?: AbortSignal
): Promise<SessionDetailResponse> {
  const params = buildScopeSearchParams(scope);
  params.set("limit", String(limit));
  return parseContractResponse(
    await fetchContractJson(
      `/api/sources/${encodeURIComponent(sourceInstanceId)}/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
      { signal }
    ),
    SessionDetailResponseSchema,
    "/api/sources/:sourceInstanceId/sessions/:sessionId"
  );
}

export async function fetchWidgetSnapshot(signal?: AbortSignal): Promise<WidgetSnapshotResponse> {
  return parseContractResponse(
    await fetchContractJson("/api/widget-snapshot", { signal }),
    WidgetSnapshotResponseSchema,
    "/api/widget-snapshot"
  );
}

export async function fetchCursorAccountUsage(signal?: AbortSignal): Promise<CursorAccountUsageResponse | null> {
  try {
    return parseContractResponse(
      await fetchContractJson("/api/cursor/account-usage", { signal }),
      CursorAccountUsageResponseSchema,
      "/api/cursor/account-usage"
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

export async function fetchSyncStatus(signal?: AbortSignal): Promise<SyncStatusResponse> {
  return parseContractResponse(
    await fetchContractJson("/api/sync/status", { signal }),
    SyncStatusResponseSchema,
    "/api/sync/status"
  );
}

export async function fetchSyncRun(runId: string, signal?: AbortSignal): Promise<SyncRunResponse> {
  return parseContractResponse(
    await fetchContractJson(`/api/sync/runs/${encodeURIComponent(runId)}`, {
      signal,
      timeoutMs: SYNC_RUN_FETCH_TIMEOUT_MS
    }),
    SyncRunResponseSchema,
    "/api/sync/runs/:runId"
  );
}

export async function triggerSync(
  adapterInstanceId?: string,
  reason?: string,
  signal?: AbortSignal
): Promise<ManualSyncResponse> {
  const path = adapterInstanceId
    ? `/api/sync/${encodeURIComponent(adapterInstanceId)}`
    : "/api/sync";
  return parseContractResponse(
    await fetchContractJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason === undefined ? {} : { reason }),
      signal
    }),
    ManualSyncResponseSchema,
    path
  );
}

export function buildExportUrl(
  format: "csv" | "json",
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all"
): string {
  return resolveApiPath(withScope(`/api/exports/${format}`, scope, sourceVendor));
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
