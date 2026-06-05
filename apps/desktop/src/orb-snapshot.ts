export type DesktopOrbMetrics = {
  totalTokens: number;
  totalToolCalls: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  successRate: number;
  failedExecutions: number;
  averageDurationMs: number;
};

export type DesktopMetricsSnapshot = {
  status: "loading" | "ready" | "stale";
  metrics: DesktopOrbMetrics;
  updatedAt: string | null;
};

export function createDesktopMetricsSnapshot(): DesktopMetricsSnapshot {
  return {
    status: "loading",
    metrics: {
      totalTokens: 0,
      totalToolCalls: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      successRate: 0,
      failedExecutions: 0,
      averageDurationMs: 0
    },
    updatedAt: null
  };
}

export function updateDesktopMetricsSnapshot(
  current: DesktopMetricsSnapshot,
  metrics: DesktopOrbMetrics,
  updatedAt: string
): DesktopMetricsSnapshot {
  void current;

  return {
    status: "ready",
    metrics,
    updatedAt
  };
}
