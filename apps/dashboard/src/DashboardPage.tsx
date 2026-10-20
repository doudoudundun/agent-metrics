import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildExportUrl,
  fetchCursorAccountUsage,
  fetchKeyUsage,
  fetchOverview,
  fetchSyncRun,
  fetchSyncStatus,
  fetchTokenTrend,
  fetchTools,
  triggerSync,
  type OverviewResponse,
  type CursorAccountUsageResponse,
  type KeyUsageResponse,
  type SourceBreakdownRow,
  type SourceVendor,
  type TokenTrendPoint,
  type ToolRow
} from "./api";
import { CursorQuotaCard } from "./components/CursorQuotaCard";
import { KeyUsagePanel } from "./components/KeyUsagePanel";
import { KpiGrid } from "./components/KpiGrid";
import { ModelUsagePanel } from "./components/ModelUsagePanel";
import { ProviderBreakdownPanel } from "./components/ProviderBreakdownPanel";
import { TimeScopeToolbar } from "./components/TimeScopeToolbar";
import { TokenTrendPanel } from "./components/TokenTrendPanel";
import { TrendChart } from "./components/TrendChart";
import {
  deriveDashboardStatus,
  formatDashboardStatusLabel,
  type DashboardHealthStatus
} from "./dashboard-status";
import { getAgentMetricsMainBridge } from "./desktop-mode";
import { QueryClient, type QueryState } from "./query-client";
import { useQuery } from "./query-hooks";
import { waitForSyncRuns } from "./sync-runs";
import { buildScopeLabel, DEFAULT_TIME_SCOPE, scopeCacheKey, type TimeScopeSelection } from "./time-scope";

type SourceOption = { value: SourceVendor; label: string };

const ALL_SOURCES_OPTION: SourceOption = { value: "all", label: "All sources" };

/** Declared order is only the tie-break when usage in the current scope is equal. */
const SOURCE_CATALOG: SourceOption[] = [
  { value: "mimo", label: "MiMo" },
  { value: "zcode", label: "ZCode" },
  { value: "kimicode", label: "Kimi Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "dsh", label: "DSH" },
  { value: "workbuddy", label: "WorkBuddy" }
];

const VISIBLE_SOURCE_LIMIT = 5;

const COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const SMALL_COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

/**
 * Rank every source by token usage in the current scope. The top five sit on
 * the bar, left to right. The rest fold into Others. "All sources" stays pinned
 * at the front. Ties fall back to tool calls, then sessions, then catalog order.
 */
function rankSourcesForScope(breakdown: readonly SourceBreakdownRow[]): {
  primary: SourceOption[];
  others: SourceOption[];
} {
  const usage = new Map<SourceVendor, SourceBreakdownRow>(
    breakdown.map((row) => [row.sourceVendor, row])
  );
  const ranked = SOURCE_CATALOG.map((option, index) => ({ option, index })).sort((left, right) => {
    const a = usage.get(left.option.value);
    const b = usage.get(right.option.value);
    return (
      (b?.totalTokens ?? 0) - (a?.totalTokens ?? 0) ||
      (b?.toolCalls ?? 0) - (a?.toolCalls ?? 0) ||
      (b?.sessionCount ?? 0) - (a?.sessionCount ?? 0) ||
      left.index - right.index
    );
  });
  const ordered = ranked.map((entry) => entry.option);

  return {
    primary: [ALL_SOURCES_OPTION, ...ordered.slice(0, VISIBLE_SOURCE_LIMIT)],
    others: ordered.slice(VISIBLE_SOURCE_LIMIT)
  };
}

function breakdownIsSelectedSourceOnly(
  breakdown: readonly SourceBreakdownRow[],
  selected: SourceVendor
): boolean {
  return (
    selected !== "all" &&
    breakdown.length > 0 &&
    breakdown.every((row) => row.sourceVendor === selected)
  );
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) {
    return "—";
  }
  if (costUsd > 0 && costUsd < 0.01) {
    return SMALL_COST_FORMAT.format(costUsd);
  }

  return COST_FORMAT.format(costUsd);
}

function formatSourceCost(
  breakdown: readonly SourceBreakdownRow[],
  vendor: SourceVendor
): string | null {
  if (vendor === "all") {
    return null;
  }

  const row = breakdown.find((entry) => entry.sourceVendor === vendor);
  return row?.costUsd != null ? formatCost(row.costUsd) : null;
}

export function DashboardPage() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const desktopBridge = useMemo(() => getAgentMetricsMainBridge(), []);
  const [scope, setScope] = useState<TimeScopeSelection>(DEFAULT_TIME_SCOPE);
  const [sourceVendor, setSourceVendor] = useState<SourceVendor>("all");
  const [tokenTrendOverride, setTokenTrendOverride] = useState<TimeScopeSelection | null>(null);
  const [rankingOverride, setRankingOverride] = useState<TimeScopeSelection | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const scopeKey = useMemo(() => scopeCacheKey(scope), [scope]);
  const queryKey = useMemo(() => `${scopeKey}:${sourceVendor}`, [scopeKey, sourceVendor]);
  const tokenTrendScope = tokenTrendOverride ?? scope;
  const rankingScope = rankingOverride ?? scope;
  const tokenTrendKey = `${scopeCacheKey(tokenTrendScope)}:${sourceVendor}`;
  const rankingKey = `${scopeCacheKey(rankingScope)}:${sourceVendor}`;
  const overviewLoader = useCallback(
    (signal: AbortSignal) => fetchOverview(scope, sourceVendor, signal),
    [scope, sourceVendor]
  );
  // The chips compare sources against each other, so this query always reads the
  // unfiltered view. Keyed on scope only: switching the selected chip must not
  // make the selected chip rank first.
  const sourceUsageLoader = useCallback(
    (signal: AbortSignal) => fetchOverview(scope, "all", signal),
    [scope]
  );
  const toolsLoader = useCallback(
    (signal: AbortSignal) => fetchTools(rankingScope, sourceVendor, signal),
    [rankingScope, sourceVendor]
  );
  const tokenTrendLoader = useCallback(
    (signal: AbortSignal) => fetchTokenTrend(tokenTrendScope, sourceVendor, signal),
    [tokenTrendScope, sourceVendor]
  );
  const cursorUsageLoader = useCallback(
    (signal: AbortSignal) => fetchCursorAccountUsage(signal),
    []
  );
  const keyUsageLoader = useCallback(
    (signal: AbortSignal) => fetchKeyUsage(signal),
    []
  );
  const syncStatusLoader = useCallback(
    (signal: AbortSignal) => fetchSyncStatus(signal),
    []
  );
  const overviewQuery = useQuery<OverviewResponse>(queryClient, `overview:${queryKey}`, overviewLoader);
  const sourceUsageQuery = useQuery<OverviewResponse>(
    queryClient,
    `source-usage:${scopeKey}`,
    sourceUsageLoader,
    { enabled: sourceVendor !== "all" }
  );
  const toolsQuery = useQuery<{ rows: ToolRow[] }>(queryClient, `tools:${rankingKey}`, toolsLoader);
  const tokenTrendQuery = useQuery<{ rows: TokenTrendPoint[] }>(
    queryClient,
    `token-trend:${tokenTrendKey}`,
    tokenTrendLoader
  );
  const cursorUsageQuery = useQuery<CursorAccountUsageResponse | null>(
    queryClient,
    "cursor-account-usage",
    cursorUsageLoader
  );
  const keyUsageQuery = useQuery<KeyUsageResponse>(
    queryClient,
    "key-usage",
    keyUsageLoader
  );
  const syncQuery = useQuery(queryClient, "sync-status", syncStatusLoader);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      syncControllerRef.current?.abort();
      queryClient.dispose();
    };
  }, [queryClient]);

  const handleSync = async () => {
    const controller = new AbortController();
    syncControllerRef.current = controller;
    setSyncing(true);
    setSyncError(null);
    try {
      const accepted = await triggerSync(undefined, "dashboard", controller.signal);
      queryClient.invalidate("sync-status");
      const completedRuns = await waitForSyncRuns(accepted.runs, fetchSyncRun, {
        signal: controller.signal
      });
      const failedRuns = completedRuns.filter(
        (run) => run.status === "failed" || run.status === "aborted"
      );
      if (failedRuns.length > 0 && mountedRef.current) {
        setSyncError(
          failedRuns
            .map((run) => run.error?.summary ?? `${run.adapterInstanceId} ${run.status}`)
            .join(" ")
        );
      }
      try {
        await Promise.all([
          overviewQuery.refresh(),
          sourceVendor !== "all" ? sourceUsageQuery.refresh() : Promise.resolve(),
          toolsQuery.refresh(),
          tokenTrendQuery.refresh(),
          cursorUsageQuery.refresh(),
          keyUsageQuery.refresh(),
          syncQuery.refresh()
        ]);
      } catch (refreshError) {
        if (!controller.signal.aborted && mountedRef.current && failedRuns.length === 0) {
          setSyncError(
            refreshError instanceof Error
              ? `Sync finished, but refreshing views failed: ${refreshError.message}`
              : "Sync finished, but refreshing views failed."
          );
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) {
        setSyncError(
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "One or more source sync runs did not complete."
        );
      }
    } finally {
      if (syncControllerRef.current === controller) {
        syncControllerRef.current = null;
        if (mountedRef.current) {
          setSyncing(false);
        }
      }
    }
  };

  const overview = overviewQuery.data;
  // A filtered overview only contains the selected source, so ranking from it
  // would move whichever chip was clicked into first place. Keep the last
  // all-sources breakdown for this scope and ignore that one-row replacement.
  const stableBreakdownRef = useRef<{ scopeKey: string; rows: readonly SourceBreakdownRow[] } | null>(
    null
  );
  const incomingBreakdown = sourceVendor === "all"
    ? overviewQuery.data?.sourceBreakdown
    : sourceUsageQuery.data?.sourceBreakdown;
  if (
    incomingBreakdown &&
    (stableBreakdownRef.current === null ||
      stableBreakdownRef.current.scopeKey !== scopeKey ||
      !breakdownIsSelectedSourceOnly(incomingBreakdown, sourceVendor))
  ) {
    stableBreakdownRef.current = { scopeKey, rows: incomingBreakdown };
  }
  const sourceUsageBreakdown =
    stableBreakdownRef.current?.scopeKey === scopeKey ? stableBreakdownRef.current.rows : [];
  const rankedSources = useMemo(
    () => rankSourcesForScope(sourceUsageBreakdown),
    [sourceUsageBreakdown]
  );
  const primarySourceOptions = rankedSources.primary;
  const otherSourceOptions = rankedSources.others;
  const othersSelected = otherSourceOptions.some((option) => option.value === sourceVendor);
  const tools = toolsQuery.data?.rows ?? [];
  const tokenTrend = tokenTrendQuery.data?.rows ?? [];
  const status = deriveDashboardStatus(
    overviewQuery.status,
    overview,
    syncQuery.data?.adapters ?? [],
    syncing
  );
  const statusLabel = formatDashboardStatusLabel(status);
  const scopeLabel = buildScopeLabel(scope);
  const showCursorOfficialUsage = sourceVendor === "cursor" || sourceVendor === "all";

  return (
    <main className="dashboard-page">
      <div className="dashboard-overview-band">
        <header className="dashboard-topbar">
          <div>
            <span className="dashboard-topbar__eyebrow">Agent Metrics / Local Ops</span>
            <h1>Operational workspace</h1>
          </div>
          <div className="dashboard-topbar__actions">
            <span
              className={`health-chip health-chip--${status}`}
              role="status"
              aria-label={`Dashboard status: ${statusLabel}`}
            >
              {statusLabel}
            </span>
            <button type="button" onClick={() => void handleSync()} disabled={syncing}>
              {syncing ? "Syncing..." : "Sync sources"}
            </button>
            {desktopBridge ? (
              <button type="button" onClick={() => void desktopBridge.showMainWindow()}>
                Focus window
              </button>
            ) : null}
          </div>
        </header>
        {syncError ? <p className="dashboard-sync-error" role="alert">{syncError}</p> : null}

        <section className="dashboard-controls" aria-label="Dashboard filters">
          <div>
            <span className="dashboard-controls__label">Time range</span>
            <TimeScopeToolbar selection={scope} onChange={setScope} />
          </div>
          <div>
            <span className="dashboard-controls__label">Source</span>
            <div className="dashboard-source-tabs" role="toolbar" aria-label="Dashboard source filter">
              {primarySourceOptions.map((option) => {
                const costLabel = formatSourceCost(sourceUsageBreakdown, option.value);

                return (
                  <button
                    type="button"
                    aria-pressed={sourceVendor === option.value}
                    data-selected={sourceVendor === option.value}
                    key={option.value}
                    onClick={() => setSourceVendor(option.value)}
                  >
                    {option.label}
                    {costLabel === null ? null : (
                      <span className="dashboard-source-tabs__cost">{costLabel}</span>
                    )}
                  </button>
                );
              })}
              {otherSourceOptions.length > 0 ? (
              <div
                className="dashboard-source-others"
                data-open={othersOpen}
                onMouseEnter={() => setOthersOpen(true)}
                onMouseLeave={() => setOthersOpen(false)}
                onFocusCapture={() => setOthersOpen(true)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOthersOpen(false);
                  }
                }}
              >
                <button
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={othersOpen}
                  aria-controls="dashboard-source-others-menu"
                  aria-pressed={othersSelected}
                  data-selected={othersSelected}
                >
                  Others
                </button>
                <div
                  className="dashboard-source-others__menu"
                  id="dashboard-source-others-menu"
                  role="group"
                  aria-label="Other sources"
                >
                  {otherSourceOptions.map((option) => {
                    const costLabel = formatSourceCost(sourceUsageBreakdown, option.value);

                    return (
                      <button
                        type="button"
                        aria-pressed={sourceVendor === option.value}
                        data-selected={sourceVendor === option.value}
                        key={option.value}
                        onClick={() => setSourceVendor(option.value)}
                      >
                        {option.label}
                        {costLabel === null ? null : (
                          <span className="dashboard-source-tabs__cost">{costLabel}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              ) : null}
            </div>
          </div>
        </section>

        {overview ? (
          <>
            <KpiGrid overview={overview} scopeLabel={scopeLabel} />
            <section className="overview-strip" aria-label="Operational status summary">
              <span>{overview.sessionCount} sessions</span>
              <span>{overview.turnCount} turns</span>
              <span>{overview.totalToolCalls} tool calls</span>
              <span>{Math.round(overview.successRate * 100)}% success</span>
              <span>Est. cost {formatCost(overview.totalCostUsd)}</span>
              <span>Updated {new Date(overview.updatedAt).toLocaleTimeString()}</span>
            </section>
          </>
        ) : (
          <section className="dashboard-state" aria-live="polite">
            <strong>{statusLabel}</strong>
            <span>{overviewQuery.error?.message ?? "Waiting for the local metrics core."}</span>
          </section>
        )}
      </div>

      <section className="dashboard-grid">
        <TokenTrendPanel
          rows={tokenTrend}
          scope={scope}
          scopeLabel={scopeLabel}
          override={tokenTrendOverride}
          onOverrideChange={setTokenTrendOverride}
          statusMessage={tokenTrendQuery.error?.message ?? null}
          emptyMessage={pendingEmptyMessage(tokenTrendQuery, "Loading token trend...")}
        />
        <ModelUsagePanel rows={overview?.tokensByModel ?? []} />
        <TrendChart
          rows={tools}
          scope={scope}
          scopeLabel={scopeLabel}
          override={rankingOverride}
          onOverrideChange={setRankingOverride}
          statusMessage={toolsQuery.error?.message ?? null}
          emptyMessage={pendingEmptyMessage(toolsQuery, "Loading tool activity...")}
        />
        <ProviderBreakdownPanel rows={overview?.providerBreakdown ?? []} />
      </section>

      <KeyUsagePanel
        data={keyUsageQuery.data ?? null}
        loading={keyUsageQuery.status === "loading"}
        errorMessage={
          keyUsageQuery.status === "error"
            ? keyUsageQuery.error?.message ?? "Unable to load official key usage."
            : null
        }
        leadCards={
          showCursorOfficialUsage ? (
            <CursorQuotaCard
              usage={cursorUsageQuery.data ?? null}
              loading={cursorUsageQuery.status === "loading"}
              errorMessage={
                cursorUsageQuery.status === "error"
                  ? cursorUsageQuery.error?.message ?? "Unable to load Cursor official usage."
                  : null
            }
            />
          ) : null
        }
      />

      <footer className="dashboard-footer">
        <span>Local data stays on this device.</span>
        <span>Scope: {scopeLabel}</span>
        <a href={buildExportUrl("csv", scope, sourceVendor)}>Export CSV</a>
        <a href={buildExportUrl("json", scope, sourceVendor)}>Export JSON</a>
      </footer>
    </main>
  );
}

function isQueryPending<T>(query: QueryState<T>): boolean {
  return query.data === null && (query.status === "loading" || query.status === "stale" || query.status === "idle");
}

function pendingEmptyMessage<T>(query: QueryState<T>, loadingCopy: string): string | undefined {
  return isQueryPending(query) ? loadingCopy : undefined;
}

export { deriveDashboardStatus, formatDashboardStatusLabel, type DashboardHealthStatus };
