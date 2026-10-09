export type DashboardHealthStatus =
  | "loading"
  | "empty"
  | "syncing"
  | "ready"
  | "stale"
  | "offline"
  | "error";

const STATUS_LABELS: Record<DashboardHealthStatus, string> = {
  loading: "Loading metrics",
  empty: "No activity in this scope",
  syncing: "Syncing sources",
  ready: "Live and up to date",
  stale: "Showing stale data",
  offline: "Metrics core offline",
  error: "Overview unavailable"
};

export function formatDashboardStatusLabel(status: DashboardHealthStatus): string {
  return STATUS_LABELS[status];
}

export function deriveDashboardStatus(
  overviewStatus: "idle" | "loading" | "ready" | "stale" | "error",
  overview: { sessionCount: number; totalTokens: number } | null,
  adapters: Array<{ status: string }>,
  syncing: boolean
): DashboardHealthStatus {
  if (overviewStatus === "error") {
    return overview === null ? "offline" : "error";
  }
  if (overviewStatus === "idle" || overviewStatus === "loading") {
    return "loading";
  }
  if (syncing) {
    return "syncing";
  }
  if (overviewStatus === "stale") {
    return "stale";
  }
  // Background adapter sync must not pin the UI on "syncing" when we already have data.
  const hasUsableOverview =
    overview !== null && (overview.sessionCount > 0 || overview.totalTokens > 0);
  if (
    !hasUsableOverview &&
    adapters.some((adapter) => adapter.status === "syncing" || adapter.status === "queued")
  ) {
    return "syncing";
  }
  // Adapter freshness expiry is not a data outage; only failed adapters pin stale.
  if (adapters.some((adapter) => adapter.status === "error")) {
    return "stale";
  }
  if (overview !== null && overview.sessionCount === 0 && overview.totalTokens === 0) {
    return "empty";
  }
  return "ready";
}
