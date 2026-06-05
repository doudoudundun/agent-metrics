import { lazy, startTransition, Suspense, useEffect, useEffectEvent, useState } from "react";
import type {
  OverviewResponse,
  SessionDetailResponse,
  SessionRow,
  SourceVendor,
  ToolRow
} from "./api";
import {
  buildExportUrl,
  fetchOverview,
  fetchSessionDetail,
  fetchSessions,
  fetchTools
} from "./api";
import { FloatingDashboard } from "./components/FloatingDashboard";
import { KpiGrid } from "./components/KpiGrid";
import { ModelUsagePanel } from "./components/ModelUsagePanel";
import { RecentSessionsTable } from "./components/RecentSessionsTable";
import { SessionTimelinePanel } from "./components/SessionTimelinePanel";
import { TimeScopeToolbar } from "./components/TimeScopeToolbar";
import { ToolRankingTable } from "./components/ToolRankingTable";
import {
  getAgentMetricsDesktopBridge,
  resolveDesktopSurface,
  type DesktopSurface
} from "./desktop-mode";
import {
  buildScopeLabel,
  DEFAULT_TIME_SCOPE,
  formatScopeDateTime,
  isSameScope,
  type TimeScopeSelection
} from "./time-scope";
import "./styles.css";

type PanelToolsState = {
  rows: ToolRow[] | null;
  loading: boolean;
  errorMessage: string | null;
};

type SessionsState = {
  rows: SessionRow[] | null;
  loading: boolean;
  errorMessage: string | null;
};

const INITIAL_PANEL_TOOLS_STATE: PanelToolsState = {
  rows: null,
  loading: false,
  errorMessage: null
};

const INITIAL_SESSIONS_STATE: SessionsState = {
  rows: null,
  loading: false,
  errorMessage: null
};

const TrendChart = lazy(async () => {
  const module = await import("./components/TrendChart");

  return { default: module.TrendChart };
});

const DEFAULT_TOOL_EMPTY_MESSAGE = "No tool activity in this scope.";
const SOURCE_UNAVAILABLE_MESSAGE = "Not available for this source yet.";
const LIVE_REFRESH_MS = 5000;
const SOURCE_OPTIONS: Array<{ value: SourceVendor; label: string }> = [
  { value: "all", label: "All" },
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" }
];

const SOURCE_LABELS: Record<SourceVendor, string> = {
  all: "All Sources",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor"
};

type AppProps = {
  initialSurface?: DesktopSurface;
};

export function App({ initialSurface }: AppProps = {}) {
  const desktopSurface = initialSurface ?? resolveDesktopSurface(window.location.search).surface;
  const isFloatingSurface = desktopSurface === "desktop-floating";
  const desktopApi = getAgentMetricsDesktopBridge();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [baseTools, setBaseTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [baseSessions, setBaseSessions] = useState<SessionsState>(INITIAL_SESSIONS_STATE);
  const [globalScope, setGlobalScope] = useState<TimeScopeSelection>(DEFAULT_TIME_SCOPE);
  const [selectedSourceVendor, setSelectedSourceVendor] = useState<SourceVendor>("all");
  const [trendOverride, setTrendOverride] = useState<TimeScopeSelection | null>(null);
  const [rankingOverride, setRankingOverride] = useState<TimeScopeSelection | null>(null);
  const [trendTools, setTrendTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [rankingTools, setRankingTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [selectedSession, setSelectedSession] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  const applyLoadedOverview = useEffectEvent((nextOverview: OverviewResponse) => {
    startTransition(() => {
      setOverview(nextOverview);
      setLoadErrorMessage(null);
      setStaleMessage(null);
    });
  });

  const applyLoadError = useEffectEvent((message: string) => {
    if (overview === null) {
      startTransition(() => {
        setLoadErrorMessage(message);
      });
      return;
    }

    startTransition(() => {
      setStaleMessage(message);
    });
  });

  useEffect(() => {
    let active = true;

    const loadOverview = async () => {
      try {
        const nextOverview = await fetchOverview(globalScope, selectedSourceVendor);

        if (!active) {
          return;
        }

        applyLoadedOverview(nextOverview);
      } catch (error) {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : "Failed to refresh local metrics.";
        applyLoadError(message);
      }
    };

    void loadOverview();
    const timer = window.setInterval(() => {
      void loadOverview();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [globalScope, selectedSourceVendor]);

  useEffect(() => {
    if (isFloatingSurface) {
      setBaseTools(INITIAL_PANEL_TOOLS_STATE);
      return;
    }

    let active = true;
    setBaseTools((current) => ({
      rows: current.rows,
      loading: true,
      errorMessage: null
    }));

    const loadTools = async () => {
      try {
        const nextTools = await fetchTools(globalScope, selectedSourceVendor);

        if (!active) {
          return;
        }

        startTransition(() => {
          setBaseTools({
            rows: nextTools.rows,
            loading: false,
            errorMessage: null
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }

        startTransition(() => {
          setBaseTools((current) => ({
            ...current,
            loading: false,
            errorMessage: messageFromError(error)
          }));
        });
      }
    };

    void loadTools();
    const timer = window.setInterval(() => {
      void loadTools();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [globalScope, isFloatingSurface, selectedSourceVendor]);

  useEffect(() => {
    let active = true;
    setBaseSessions((current) => ({
      rows: current.rows,
      loading: true,
      errorMessage: null
    }));

    const loadSessions = async () => {
      try {
        const nextSessions = await fetchSessions(globalScope, selectedSourceVendor);

        if (!active) {
          return;
        }

        startTransition(() => {
          setBaseSessions({
            rows: nextSessions.rows,
            loading: false,
            errorMessage: null
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }

        startTransition(() => {
          setBaseSessions((current) => ({
            ...current,
            loading: false,
            errorMessage: messageFromError(error)
          }));
        });
      }
    };

    void loadSessions();
    const timer = window.setInterval(() => {
      void loadSessions();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [globalScope, selectedSourceVendor]);

  useEffect(() => {
    if (isFloatingSurface || !trendOverride) {
      setTrendTools(INITIAL_PANEL_TOOLS_STATE);
      return;
    }

    let active = true;
    setTrendTools((current) => ({
      ...current,
      loading: true,
      errorMessage: null
    }));

    const loadTools = async () => {
      try {
        const tools = await fetchTools(trendOverride, selectedSourceVendor);

        if (!active) {
          return;
        }

        startTransition(() => {
          setTrendTools({
            rows: tools.rows,
            loading: false,
            errorMessage: null
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }

        startTransition(() => {
          setTrendTools((current) => ({
            ...current,
            loading: false,
            errorMessage: messageFromError(error)
          }));
        });
      }
    };

    void loadTools();
    const timer = window.setInterval(() => {
      void loadTools();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isFloatingSurface, trendOverride, selectedSourceVendor]);

  useEffect(() => {
    if (isFloatingSurface || !rankingOverride) {
      setRankingTools(INITIAL_PANEL_TOOLS_STATE);
      return;
    }

    let active = true;
    setRankingTools((current) => ({
      ...current,
      loading: true,
      errorMessage: null
    }));

    const loadTools = async () => {
      try {
        const tools = await fetchTools(rankingOverride, selectedSourceVendor);

        if (!active) {
          return;
        }

        startTransition(() => {
          setRankingTools({
            rows: tools.rows,
            loading: false,
            errorMessage: null
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }

        startTransition(() => {
          setRankingTools((current) => ({
            ...current,
            loading: false,
            errorMessage: messageFromError(error)
          }));
        });
      }
    };

    void loadTools();
    const timer = window.setInterval(() => {
      void loadTools();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isFloatingSurface, rankingOverride, selectedSourceVendor]);

  useEffect(() => {
    if (isFloatingSurface) {
      setSelectedSession(null);
      setSelectedSessionId(null);
      setSessionDetailLoading(false);
      return;
    }

    const sessionRows = baseSessions.rows ?? [];

    if (sessionRows.length === 0) {
      setSelectedSession(null);
      setSelectedSessionId(null);
      setSessionDetailLoading(false);
      return;
    }

    if (!selectedSessionId || !sessionRows.some((row) => row.sessionId === selectedSessionId)) {
      setSelectedSessionId(sessionRows[0]?.sessionId ?? null);
    }
  }, [baseSessions.rows, isFloatingSurface, selectedSessionId]);

  useEffect(() => {
    if (isFloatingSurface) {
      setSessionDetailLoading(false);
      return;
    }

    if (!selectedSessionId) {
      setSessionDetailLoading(false);
      return;
    }

    let active = true;
    setSessionDetailLoading(true);

    void fetchSessionDetail(selectedSessionId)
      .then((detail) => {
        if (!active) {
          return;
        }

        startTransition(() => {
          setSelectedSession(detail);
          setSessionDetailLoading(false);
        });
      })
      .catch(() => {
        if (!active) {
          return;
        }

        startTransition(() => {
          setSelectedSession(null);
          setSessionDetailLoading(false);
        });
      });

    return () => {
      active = false;
    };
  }, [isFloatingSurface, selectedSessionId]);

  const handleSelectSession = useEffectEvent((sessionId: string) => {
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setSelectedSession(null);
      setSessionDetailLoading(true);
    });
  });

  const handleScopeChange = useEffectEvent((selection: TimeScopeSelection) => {
    if (isSameScope(globalScope, selection)) {
      return;
    }

    setGlobalScope(selection);
    setLoadErrorMessage(null);
    setStaleMessage(null);
  });

  const handleSourceVendorChange = useEffectEvent((sourceVendor: SourceVendor) => {
    if (selectedSourceVendor === sourceVendor) {
      return;
    }

    startTransition(() => {
      setSelectedSourceVendor(sourceVendor);
      setLoadErrorMessage(null);
      setStaleMessage(null);
    });
  });

  const scopeLabel = buildScopeLabel(globalScope);
  const sourceLabel = SOURCE_LABELS[selectedSourceVendor];
  const sessionRows = baseSessions.rows ?? [];
  const floatingSessionsStatus =
    baseSessions.rows === null
      ? baseSessions.loading
        ? "loading"
        : baseSessions.errorMessage
          ? "error"
          : "ready"
      : "ready";
  const floatingSessionsStatusMessage =
    baseSessions.rows === null ? baseSessions.errorMessage : null;
  const floatingStatus =
    overview === null
      ? loadErrorMessage
        ? "error"
        : "loading"
      : staleMessage
        ? "stale"
        : "ready";
  const floatingStatusMessage = overview === null ? loadErrorMessage : staleMessage;
  const desktopActionStrip =
    !isFloatingSurface && desktopApi ? (
      <div className="desktop-actions" role="group" aria-label="Desktop window actions">
        <button
          type="button"
          className="desktop-action"
          onClick={() => void desktopApi.toggleFloatingWindow()}
        >
          Toggle Floating Window
        </button>
        <button
          type="button"
          className="desktop-action"
          onClick={() => void desktopApi.showMainWindow()}
        >
          Show Main Window
        </button>
        <span className="desktop-runtime-status">Runtime: desktop bridge ready</span>
      </div>
    ) : null;

  if (isFloatingSurface) {
    return (
      <main className="app-shell app-shell--floating">
        <FloatingDashboard
          overview={overview}
          sessions={sessionRows}
          status={floatingStatus}
          statusMessage={floatingStatusMessage}
          sessionStatus={floatingSessionsStatus}
          sessionStatusMessage={floatingSessionsStatusMessage}
        />
      </main>
    );
  }

  if (!overview) {
    return (
      <main className="app-shell">
        <section className="hero-panel">
          <div className="hero-eyebrow">Local Ops Console</div>
          <h1>Agent Metrics</h1>
          {loadErrorMessage ? (
            <p className="hero-copy">
              <strong>Failed to load dashboard metrics.</strong> {loadErrorMessage}
            </p>
          ) : (
            <p className="hero-copy">Loading local activity signals from the metrics core.</p>
          )}
          <TimeScopeToolbar selection={globalScope} onChange={handleScopeChange} />
          <div className="time-scope-toolbar" role="toolbar" aria-label="Dashboard source filter">
            {SOURCE_OPTIONS.map((option) => (
              <button
                type="button"
                className="time-scope-button"
                data-selected={selectedSourceVendor === option.value}
                key={option.value}
                onClick={() => handleSourceVendorChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="status-row">
            <div className="status-pill">
              <strong>Scope</strong>
              <span>{scopeLabel}</span>
            </div>
            <div className="status-pill">
              <strong>Source</strong>
              <span>{sourceLabel}</span>
            </div>
          </div>
          {desktopActionStrip}
        </section>
      </main>
    );
  }

  const baseToolRows = baseTools.rows ?? [];
  const lastUpdated = formatScopeDateTime(overview.updatedAt, overview.timezone);
  const trendRows = trendOverride ? (trendTools.rows ?? baseToolRows) : baseToolRows;
  const rankingRows = rankingOverride ? (rankingTools.rows ?? baseToolRows) : baseToolRows;
  const sourceBreakdownRows = overview.sourceBreakdown ?? [];
  const baseToolEmptyMessage = buildToolEmptyMessage(
    baseTools,
    baseToolRows,
    selectedSourceVendor
  );
  const trendStatusMessage = buildPanelStatusMessage(
    "Activity Snapshot",
    trendOverride,
    trendTools,
    baseTools
  );
  const rankingStatusMessage = buildPanelStatusMessage(
    "Tool Rankings",
    rankingOverride,
    rankingTools,
    baseTools
  );
  const sessionStatusMessage = buildSessionStatusMessage(baseSessions, sessionDetailLoading);

  return (
    <main className="app-shell">
      <section className="hero-panel hero-panel-compact">
        <div className="hero-grid">
          <div className="hero-main">
            <div className="hero-eyebrow">Local Ops Console</div>
            <h1>Agent Metrics</h1>
            <p className="hero-copy">
              Hooks-first telemetry for local agent sessions, real Claude Code tool usage, and
              code edit activity.
            </p>
          </div>
          <div className="hero-side">
            <TimeScopeToolbar selection={globalScope} onChange={handleScopeChange} />
            <div className="time-scope-toolbar" role="toolbar" aria-label="Dashboard source filter">
              {SOURCE_OPTIONS.map((option) => (
                <button
                  type="button"
                  className="time-scope-button"
                  data-selected={selectedSourceVendor === option.value}
                  key={option.value}
                  onClick={() => handleSourceVendorChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="status-row">
              <div className="status-pill" data-state={staleMessage ? "stale" : "fresh"}>
                <strong>Status</strong>
                <span>{staleMessage ? "Showing stale local data" : "Polling live local data"}</span>
              </div>
              <div className="status-pill">
                <strong>Scope</strong>
                <span>{scopeLabel}</span>
              </div>
              <div className="status-pill">
                <strong>Source</strong>
                <span>{sourceLabel}</span>
              </div>
              {lastUpdated ? (
                <div className="status-pill">
                  <strong>Updated</strong>
                  <span>{lastUpdated}</span>
                </div>
              ) : null}
            </div>
            {staleMessage ? <p className="hero-copy">{staleMessage}</p> : null}
            {desktopActionStrip}
            <div className="hero-actions">
              <a className="hero-link" href={buildExportUrl("csv")}>
                Export CSV
              </a>
              <a className="hero-link" href={buildExportUrl("json")}>
                Export JSON
              </a>
            </div>
          </div>
        </div>
      </section>

      <KpiGrid overview={overview} scopeLabel={scopeLabel} />
      <section className="panel compact-breakdown-panel" aria-label="Source Breakdown">
        <div className="panel-heading">
          <h2>Source Breakdown</h2>
          <span>Following global: {sourceLabel}</span>
        </div>
        <div className="kpi-secondary-row">
          {sourceBreakdownRows.length > 0 ? (
            sourceBreakdownRows.map((row) => (
              <article className="kpi-chip" key={row.sourceVendor}>
                <span className="kpi-chip-label">{SOURCE_LABELS[row.sourceVendor]}</span>
                <strong className="kpi-chip-value">{row.totalTokens.toLocaleString()} tokens</strong>
                <span className="kpi-meta">
                  {row.sessionCount} sessions / {row.turnCount} turns / {row.toolCalls} calls
                </span>
              </article>
            ))
          ) : (
            <article className="kpi-chip">
              <span className="kpi-chip-label">No source data</span>
              <strong className="kpi-chip-value">0</strong>
            </article>
          )}
        </div>
      </section>

      <section className="surface-grid surface-grid-dense">
        <div className="surface-stack">
          <Suspense
            fallback={
              <section className="panel chart-panel">
                <div className="panel-heading">
                  <h2>Activity Snapshot</h2>
                  <span>Rendering chart</span>
                </div>
              </section>
            }
          >
            <TrendChart
              rows={trendRows}
              scope={globalScope}
              scopeLabel={scopeLabel}
              override={trendOverride}
              onOverrideChange={setTrendOverride}
              statusMessage={trendStatusMessage}
              emptyMessage={baseToolEmptyMessage}
            />
          </Suspense>
          <ToolRankingTable
            rows={rankingRows}
            scope={globalScope}
            scopeLabel={scopeLabel}
            override={rankingOverride}
            onOverrideChange={setRankingOverride}
            statusMessage={rankingStatusMessage}
            emptyMessage={baseToolEmptyMessage}
          />
        </div>
        <div className="surface-stack">
          <RecentSessionsTable
            onSelect={handleSelectSession}
            errorMessage={baseSessions.errorMessage}
            loading={baseSessions.loading}
            rows={sessionRows}
            selectedSessionId={selectedSessionId}
          />
          <ModelUsagePanel rows={overview.tokensByModel ?? []} />
          <SessionTimelinePanel
            detail={selectedSession}
            loading={sessionDetailLoading}
            statusMessage={sessionStatusMessage}
          />
        </div>
      </section>
    </main>
  );
}

function buildPanelStatusMessage(
  panelName: string,
  override: TimeScopeSelection | null,
  state: PanelToolsState,
  baseState: PanelToolsState
): string | null {
  if (!override) {
    if (baseState.rows && baseState.errorMessage) {
      return `${panelName} showing last loaded data: ${baseState.errorMessage}`;
    }

    if (baseState.rows && baseState.loading) {
      return `Refreshing global tool metrics...`;
    }

    return null;
  }

  if (state.errorMessage) {
    return `${panelName} override failed: ${state.errorMessage}`;
  }

  if (state.loading) {
    return state.rows
      ? `Refreshing ${panelName} override...`
      : `Loading ${panelName} override...`;
  }

  return null;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to refresh scoped tool data.";
}

function buildToolEmptyMessage(
  state: PanelToolsState,
  rows: ToolRow[],
  selectedSourceVendor: SourceVendor
): string {
  if (state.loading) {
    return "Loading global tool metrics...";
  }

  if (state.errorMessage) {
    return `Global tool metrics unavailable: ${state.errorMessage}`;
  }

  if (rows.length === 0 && selectedSourceVendor !== "all") {
    return SOURCE_UNAVAILABLE_MESSAGE;
  }

  return DEFAULT_TOOL_EMPTY_MESSAGE;
}

function buildSessionStatusMessage(
  state: SessionsState,
  sessionDetailLoading: boolean
): string | null {
  if (state.loading && !state.rows) {
    return "Waiting for session activity...";
  }

  if (state.errorMessage && !state.rows) {
    return `Recent sessions unavailable: ${state.errorMessage}`;
  }

  if (sessionDetailLoading) {
    return "Loading session activity...";
  }

  return null;
}
