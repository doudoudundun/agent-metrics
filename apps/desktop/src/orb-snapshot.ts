export type DesktopOrbMetrics = {
  totalTokens: number;
  totalCostUsd: number;
  activeTasks: number;
  completedTasks: number;
  pendingApprovals: number;
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
      totalCostUsd: 0,
      activeTasks: 0,
      completedTasks: 0,
      pendingApprovals: 0
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
