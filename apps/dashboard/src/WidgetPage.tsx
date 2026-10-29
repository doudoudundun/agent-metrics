import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  fetchSyncRun,
  fetchSyncStatus,
  fetchWidgetSnapshot,
  triggerSync,
  type SyncStatusResponse,
  type WidgetSnapshotResponse
} from "./api";
import { getAgentMetricsWidgetBridge, type AgentMetricsWidgetBridge } from "./desktop-mode";
import { QueryClient, type QueryState } from "./query-client";
import { useQuery } from "./query-hooks";
import { waitForSyncRuns } from "./sync-runs";
import { UiIcon } from "./components/UiIcon";

type WidgetStatus = "loading" | "ready" | "syncing" | "stale" | "offline" | "error";

const WIDGET_POLL_MS = 10_000;
const SNAPSHOT_FRESHNESS_MS = 5 * 60 * 1000;
/** Native collapsed geometry is ~88px; treat anything under this as compact chrome. */
const COMPACT_WIDTH_PX = 160;

export function WidgetPage() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const [syncing, setSyncing] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth < COMPACT_WIDTH_PX);

  useEffect(() => {
    const bridge = getAgentMetricsWidgetBridge();
    if (!bridge?.getSettings) {
      return;
    }
    void bridge.getSettings().then((value) => {
      if (
        value &&
        typeof value === "object" &&
        (value as { widgetModeOnStartup?: unknown }).widgetModeOnStartup === "pinned"
      ) {
        setPinned(true);
      }
    });
  }, []);

  // Hard cap: never leave Sync pinned if Core wedges mid-request.
  useEffect(() => {
    if (!syncing) {
      return;
    }
    const timer = window.setTimeout(() => setSyncing(false), 15_000);
    return () => window.clearTimeout(timer);
  }, [syncing]);
  const snapshotQuery = useQuery<WidgetSnapshotResponse>(
    queryClient,
    "widget-snapshot",
    fetchSnapshot,
    { pollIntervalMs: WIDGET_POLL_MS, pollWhileHidden: true }
  );
  const syncQuery = useQuery<SyncStatusResponse>(
    queryClient,
    "sync-status",
    fetchStatus,
    { pollIntervalMs: WIDGET_POLL_MS, pollWhileHidden: true }
  );
  const snapshot = snapshotQuery.data;
  const syncStatus = syncQuery.data;
  const status = deriveQueryWidgetStatus(snapshotQuery, syncQuery, syncing);
  const errorMessage = snapshotQuery.error?.message ?? syncQuery.error?.message ?? null;
  const refresh = useCallback(async () => {
    await Promise.all([snapshotQuery.refresh(), syncQuery.refresh()]);
  }, [snapshotQuery.refresh, syncQuery.refresh]);

  useEffect(() => () => queryClient.dispose(), [queryClient]);

  useEffect(() => {
    const update = () => setCompact(window.innerWidth < COMPACT_WIDTH_PX);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const accepted = await triggerSync(undefined, "widget");
      if (accepted?.runs?.length) {
        await waitForSyncRuns(accepted.runs, fetchSyncRun);
      }
      await refresh();
    } catch {
      queryClient.invalidate("sync-status");
    } finally {
      setSyncing(false);
    }
  };

  const nativeBridge = getAgentMetricsWidgetBridge();

  const callBridge = (
    action: (bridge: AgentMetricsWidgetBridge) => Promise<unknown>,
    label: string
  ) => {
    const bridge = getAgentMetricsWidgetBridge();
    if (!bridge) {
      console.error(`[widget] ${label} skipped: desktop bridge unavailable`);
      return;
    }
    void Promise.resolve(action(bridge)).catch((error: unknown) => {
      console.error(`[widget] ${label} failed`, error);
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement | null)?.closest("button, a, input, select, textarea")) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    callBridge((bridge) => bridge.pointerBegin(), "pointerBegin");
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    callBridge((bridge) => bridge.pointerUpdate(), "pointerUpdate");
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    callBridge((bridge) => bridge.pointerEnd(), "pointerEnd");
  };

  if (compact) {
    const tokens = snapshot ? formatCompactCount(snapshot.metrics.totalTokens) : "—";
    const cost = snapshot ? formatCost(snapshot.metrics.totalCostUsd) : "—";
    return (
      <main
        className="widget-page widget-page--compact"
        aria-label="Agent Metrics widget collapsed"
        title={snapshot ? `${formatCount(snapshot.metrics.totalTokens)} tokens · ${formatCost(snapshot.metrics.totalCostUsd)} · ${formatRate(snapshot.metrics.cacheHitRate)} cache hit` : "Loading local metrics…"}
        onPointerEnter={() => callBridge((bridge) => bridge.pointerEnter(), "pointerEnter")}
        onPointerLeave={() => callBridge((bridge) => bridge.pointerLeave(), "pointerLeave")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() =>
          callBridge((bridge) => bridge.setWidgetMode("pinned"), "setWidgetMode(pinned)")
        }
        onFocusCapture={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("button, a, input, select, textarea")) {
            callBridge((bridge) => bridge.focusWithin(true), "focusWithin(true)");
          }
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            callBridge((bridge) => bridge.focusWithin(false), "focusWithin(false)");
          }
        }}
      >
        <strong className="widget-page__primary-value" data-long={tokens.length > 4 || undefined}>
          {tokens}
          <small>Tokens</small>
        </strong>
        <div className="widget-page__cost-row">
          <strong
            className={`widget-page__cost-value${cost.length >= 7 ? " widget-page__cost-value--long" : cost.length >= 6 ? " widget-page__cost-value--medium" : ""}`}
          >
            {cost}
          </strong>
        </div>
      </main>
    );
  }

  return (
    <main
      className="widget-page"
      aria-label="Agent Metrics widget"
      data-syncing={syncing}
      onPointerEnter={() => callBridge((bridge) => bridge.pointerEnter(), "pointerEnter")}
      onPointerLeave={() => callBridge((bridge) => bridge.pointerLeave(), "pointerLeave")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Widget buttons retain keyboard focus after a click, which keeps
      // `keyboardFocusInside` true on the main process and blocks the
      // auto-collapse rule (spec §16.4). Blur only after the button handler.
      onClick={() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.tagName === "BUTTON") {
          active.blur();
        }
      }}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, a, input, select, textarea")) {
          callBridge((bridge) => bridge.focusWithin(true), "focusWithin(true)");
        }
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(next)) {
          callBridge((bridge) => bridge.focusWithin(false), "focusWithin(false)");
        }
      }}
    >
      <header className="widget-page__header">
        <div className="widget-page__brand">
          <i className={`widget-page__brand-status widget-page__status--${status}`} />
          <span className="widget-page__eyebrow">Agent Metrics</span>
        </div>
        <div className="widget-page__header-actions">
          <button type="button" aria-label="Refresh" title="Refresh" onClick={() => void refresh()} disabled={syncing}>
            <UiIcon name="refresh" size={13} />
          </button>
          {nativeBridge ? (
            <>
              <button
                type="button"
                aria-label={pinned ? "Unpin widget" : "Pin widget"}
                aria-pressed={pinned}
                title={pinned ? "Unpin widget" : "Pin widget"}
                onClick={() => {
                  const nextPinned = !pinned;
                  setPinned(nextPinned);
                  callBridge(
                    (bridge) => bridge.setWidgetMode(nextPinned ? "pinned" : "expanded"),
                    "setWidgetMode"
                  );
                }}
              >
                <UiIcon name="pin" size={13} />
              </button>
              <button
                type="button"
                aria-label="Collapse widget"
                title="Collapse widget"
                onClick={() => callBridge((bridge) => bridge.setWidgetMode("collapsed"), "setWidgetMode(collapsed)")}
              >
                <UiIcon name="close" size={13} />
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="widget-page__scope">
        <h1>{describeScope(snapshot?.scope)} <span>/ All sources</span></h1>
        <span className={`widget-page__status widget-page__status--${status}`} role="status">
          {status}
        </span>
      </div>
      {snapshot ? (
        <>
          <div className="widget-page__hero">
            <div className="widget-page__primary">
              <span>Total tokens</span>
              <strong>{formatCount(snapshot.metrics.totalTokens)}</strong>
            </div>
            <div className="widget-page__cache">
              <CacheRing rate={snapshot.metrics.cacheHitRate} />
              <span><strong>{formatRate(snapshot.metrics.cacheHitRate)}</strong><small>Cache hit</small></span>
            </div>
          </div>
          <div className="widget-page__metrics">
            <Metric label="Est. cost" value={formatCost(snapshot.metrics.totalCostUsd)} />
            <Metric label="Tools" value={formatCount(snapshot.metrics.logicalToolCalls)} />
            <Metric label="Sessions" value={formatCount(snapshot.metrics.sessionCount)} />
            <Metric label="Tool success" value={formatRate(snapshot.metrics.toolSuccessRate)} />
          </div>
        </>
      ) : (
        <p className="widget-page__empty">Loading local metrics…</p>
      )}
      {errorMessage ? <p className="widget-page__error">{errorMessage}</p> : null}
      <footer className="widget-page__footer">
        <span className="widget-page__footer-meta">
          {syncStatus ? `${syncStatus.adapters.length} sources` : "Checking…"}
        </span>
        <div className="widget-page__footer-actions">
          <button type="button" onClick={() => void handleSync()} disabled={syncing}>
            <UiIcon className="widget-page__sync-icon" name="sync" size={12} />
            {syncing ? "Syncing…" : "Sync"}
          </button>
          {nativeBridge ? (
            <button
              className="widget-page__main-button"
              type="button"
              onClick={() => callBridge((bridge) => bridge.showMainWindow(), "showMainWindow")}
            >
              Main<UiIcon name="open" size={12} />
            </button>
          ) : null}
        </div>
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="widget-page__metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CacheRing({ rate }: { rate: number }) {
  const normalized = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
  return (
    <svg className="widget-cache-ring" viewBox="0 0 88 88" role="img" aria-label={`Cache hit ${formatRate(normalized)}`}>
      <circle className="widget-cache-ring__track" cx="44" cy="44" r="37" pathLength="1" />
      <circle
        className="widget-cache-ring__value"
        cx="44"
        cy="44"
        r="37"
        pathLength="1"
        strokeDasharray={`${normalized} 1`}
      />
    </svg>
  );
}

function deriveWidgetStatus(
  snapshot: WidgetSnapshotResponse,
  syncStatus: SyncStatusResponse
): WidgetStatus {
  const snapshotAge = Date.now() - Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(snapshotAge) || snapshotAge > SNAPSHOT_FRESHNESS_MS) {
    return "stale";
  }
  if (syncStatus.adapters.some((adapter) => adapter.status === "error")) {
    return "stale";
  }
  return "ready";
}

function deriveQueryWidgetStatus(
  snapshotQuery: QueryState<WidgetSnapshotResponse>,
  syncQuery: QueryState<SyncStatusResponse>,
  syncing: boolean
): WidgetStatus {
  if (snapshotQuery.data === null) {
    if (snapshotQuery.status === "loading" || syncQuery.status === "loading") {
      return "loading";
    }
    return "offline";
  }
  if (snapshotQuery.error !== null || syncQuery.error !== null) {
    return "stale";
  }
  if (syncing) {
    return "syncing";
  }
  return syncQuery.data === null ? "stale" : deriveWidgetStatus(snapshotQuery.data, syncQuery.data);
}

function fetchSnapshot(signal: AbortSignal): Promise<WidgetSnapshotResponse> {
  return fetchWidgetSnapshot(signal);
}

function fetchStatus(signal: AbortSignal): Promise<SyncStatusResponse> {
  return fetchSyncStatus(signal);
}

/**
 * Widget snapshot is always the local calendar day.
 */
function describeScope(
  scope: WidgetSnapshotResponse["scope"] | undefined
): string {
  if (!scope) {
    return "Loading…";
  }
  return "Today";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumSignificantDigits: 3
  }).format(value);
}

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

function formatCost(value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (value !== 0 && Math.abs(value) < 0.01) {
    return SMALL_COST_FORMAT.format(value);
  }
  return COST_FORMAT.format(value);
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}
