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
};

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

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchOverview(): Promise<OverviewResponse> {
  return fetchJson<OverviewResponse>("/api/overview");
}

export async function fetchTools(): Promise<ToolRow[]> {
  return fetchJson<ToolRow[]>("/api/tools");
}

export async function fetchSessions(): Promise<SessionRow[]> {
  return fetchJson<SessionRow[]>("/api/sessions");
}

export async function fetchSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  return fetchJson<SessionDetailResponse>(`/api/sessions/${sessionId}`);
}

export function buildExportUrl(format: "csv" | "json"): string {
  return `/api/exports/${format}`;
}
