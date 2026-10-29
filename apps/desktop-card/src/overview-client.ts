import { DEFAULT_SCOPE, type OverviewMetrics } from "./format.js";

export const DEFAULT_CORE_PORT = "45183";
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 30_000;

export type OverviewFetchResult =
  | { ok: true; metrics: OverviewMetrics }
  | { ok: false; status: "unavailable" | "error"; message: string };

export function resolveCoreApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENT_METRICS_CORE_API_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const port = env.AGENT_METRICS_CORE_PORT?.trim() || DEFAULT_CORE_PORT;
  return `http://127.0.0.1:${port}`;
}

export function resolveLocalAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.AGENT_METRICS_LOCAL_TOKEN?.trim();
  return token ? token : null;
}

export function buildOverviewUrl(baseUrl: string): string {
  const url = new URL("/api/overview", `${baseUrl}/`);
  url.searchParams.set("mode", DEFAULT_SCOPE.mode);
  url.searchParams.set("range", DEFAULT_SCOPE.range);
  url.searchParams.set("sourceVendor", "all");
  return url.toString();
}

export function parseOverviewMetrics(payload: unknown): OverviewMetrics | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const row = payload as Record<string, unknown>;
  const numbers = [
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "turnCount",
    "responseCount",
    "totalToolCalls",
    "successfulExecutions",
    "failedExecutions",
    "startedOnlyExecutions",
    "editOperationCount",
    "affectedFileCount",
    "insertions",
    "deletions"
  ] as const;
  const metrics: Record<string, number | null> = {};
  for (const key of numbers) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }
    metrics[key] = value;
  }
  const totalCostUsd = row.totalCostUsd;
  if (totalCostUsd !== null && (typeof totalCostUsd !== "number" || !Number.isFinite(totalCostUsd) || totalCostUsd < 0)) {
    return null;
  }
  return {
    ...(metrics as unknown as Omit<OverviewMetrics, "totalCostUsd">),
    totalCostUsd: typeof totalCostUsd === "number" ? totalCostUsd : null
  };
}

export async function fetchOverviewMetrics(input: {
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<OverviewFetchResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (input.signal?.aborted) {
    abortFromCaller();
  } else {
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    const headers = new Headers();
    if (input.token) {
      headers.set("X-Agent-Metrics-Token", input.token);
    }
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(buildOverviewUrl(input.baseUrl), {
      method: "GET",
      headers,
      signal: controller.signal
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status >= 500 ? "unavailable" : "error",
        message: statusMessage(response.status, payload)
      };
    }
    const metrics = parseOverviewMetrics(payload);
    if (!metrics) {
      return { ok: false, status: "error", message: "Overview response was invalid." };
    }
    return { ok: true, metrics };
  } catch (error) {
    if (timedOut) {
      return { ok: false, status: "unavailable", message: "Local metrics core is unavailable." };
    }
    if (isAbortError(error) && input.signal?.aborted) {
      return { ok: false, status: "unavailable", message: "Request cancelled." };
    }
    return { ok: false, status: "unavailable", message: "Local metrics core is unavailable." };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function statusMessage(status: number, payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.length > 0) {
      return error.message;
    }
  }
  if (status === 403) {
    return "Core rejected the local request.";
  }
  return `Request failed: ${status}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
