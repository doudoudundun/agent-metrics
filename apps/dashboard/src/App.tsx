import { lazy, startTransition, Suspense, useEffect, useEffectEvent, useState } from "react";
import type { OverviewResponse, SessionDetailResponse, SessionRow, ToolRow } from "./api";
import {
  buildExportUrl,
  fetchOverview,
  fetchSessionDetail,
  fetchSessions,
  fetchTools
} from "./api";
import { KpiGrid } from "./components/KpiGrid";
import { RecentSessionsTable } from "./components/RecentSessionsTable";
import { SessionTimelinePanel } from "./components/SessionTimelinePanel";
import { TimeScopeToolbar } from "./components/TimeScopeToolbar";
import { ToolRankingTable } from "./components/ToolRankingTable";
import {
  buildScopeLabel,
  DEFAULT_TIME_SCOPE,
  formatScopeDateTime,
  isSameScope,
  type TimeScopeSelection
} from "./time-scope";
import "./styles.css";

type DashboardState = {
  overview: OverviewResponse | null;
  sessions: SessionRow[];
  tools: ToolRow[];
};

type PanelToolsState = {
  rows: ToolRow[] | null;
  loading: boolean;
  errorMessage: string | null;
};

const INITIAL_STATE: DashboardState = {
  overview: null,
  sessions: [],
  tools: []
};

const INITIAL_PANEL_TOOLS_STATE: PanelToolsState = {
  rows: null,
  loading: false,
  errorMessage: null
};

const TrendChart = lazy(async () => {
  const module = await import("./components/TrendChart");

  return { default: module.TrendChart };
});

export function App() {
  const [dashboard, setDashboard] = useState<DashboardState>(INITIAL_STATE);
  const [globalScope, setGlobalScope] = useState<TimeScopeSelection>(DEFAULT_TIME_SCOPE);
  const [trendOverride, setTrendOverride] = useState<TimeScopeSelection | null>(null);
  const [rankingOverride, setRankingOverride] = useState<TimeScopeSelection | null>(null);
  const [trendTools, setTrendTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [rankingTools, setRankingTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [selectedSession, setSelectedSession] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  const applyLoadedData = useEffectEvent((nextState: DashboardState) => {
    startTransition(() => {
      setDashboard(nextState);
      setLoadErrorMessage(null);
      setStaleMessage(null);
    });
  });

  const applyLoadError = useEffectEvent((message: string) => {
    if (dashboard.overview === null) {
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

    const loadDashboard = async () => {
      try {
        const [overview, tools, sessions] = await Promise.all([
          fetchOverview(globalScope),
          fetchTools(globalScope),
          fetchSessions(globalScope)
        ]);

        if (!active) {
          return;
        }

        applyLoadedData({
          overview,
          sessions: sessions.rows,
          tools: tools.rows
        });
      } catch (error) {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : "Failed to refresh local metrics.";
        applyLoadError(message);
      }
    };

    void loadDashboard();
    const timer = window.setInterval(() => {
      void loadDashboard();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [globalScope]);

  useEffect(() => {
    if (!trendOverride) {
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
        const tools = await fetchTools(trendOverride);

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
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [trendOverride]);

  useEffect(() => {
    if (!rankingOverride) {
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
        const tools = await fetchTools(rankingOverride);

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
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [rankingOverride]);

  useEffect(() => {
    if (dashboard.sessions.length === 0) {
      setSelectedSession(null);
      setSelectedSessionId(null);
      return;
    }

    if (!selectedSessionId || !dashboard.sessions.some((row) => row.sessionId === selectedSessionId)) {
      setSelectedSessionId(dashboard.sessions[0]?.sessionId ?? null);
    }
  }, [dashboard.sessions, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    let active = true;

    void fetchSessionDetail(selectedSessionId)
      .then((detail) => {
        if (!active) {
          return;
        }

        startTransition(() => {
          setSelectedSession(detail);
        });
      })
      .catch(() => {
        if (!active) {
          return;
        }

        startTransition(() => {
          setSelectedSession(null);
        });
      });

    return () => {
      active = false;
    };
  }, [selectedSessionId]);

  const handleSelectSession = useEffectEvent((sessionId: string) => {
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setSelectedSession(null);
    });
  });

  const handleScopeChange = useEffectEvent((selection: TimeScopeSelection) => {
    if (isSameScope(globalScope, selection)) {
      return;
    }

    setGlobalScope(selection);
    setDashboard(INITIAL_STATE);
    setSelectedSession(null);
    setSelectedSessionId(null);
    setLoadErrorMessage(null);
    setStaleMessage(null);
  });

  const scopeLabel = buildScopeLabel(globalScope);

  if (!dashboard.overview) {
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
          <div className="status-row">
            <div className="status-pill">
              <strong>Scope</strong>
              <span>{scopeLabel}</span>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const lastUpdated = formatScopeDateTime(
    dashboard.overview.updatedAt,
    dashboard.overview.timezone
  );
  const trendRows = trendOverride ? (trendTools.rows ?? dashboard.tools) : dashboard.tools;
  const rankingRows = rankingOverride ? (rankingTools.rows ?? dashboard.tools) : dashboard.tools;
  const trendStatusMessage = buildPanelStatusMessage(
    "Activity Snapshot",
    trendOverride,
    trendTools
  );
  const rankingStatusMessage = buildPanelStatusMessage(
    "Tool Rankings",
    rankingOverride,
    rankingTools
  );

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-eyebrow">Local Ops Console</div>
        <h1>Agent Metrics</h1>
        <p className="hero-copy">
          Hooks-first telemetry for local agent sessions, real Claude Code tool usage, and code
          edit activity.
        </p>
        <TimeScopeToolbar selection={globalScope} onChange={handleScopeChange} />
        <div className="status-row">
          <div className="status-pill" data-state={staleMessage ? "stale" : "fresh"}>
            <strong>Status</strong>
            <span>{staleMessage ? "Showing stale local data" : "Polling live local data"}</span>
          </div>
          <div className="status-pill">
            <strong>Scope</strong>
            <span>{scopeLabel}</span>
          </div>
          {lastUpdated ? (
            <div className="status-pill">
              <strong>Updated</strong>
              <span>{lastUpdated}</span>
            </div>
          ) : null}
        </div>
        <div className="hero-actions">
          <a className="hero-link" href={buildExportUrl("csv")}>
            Export CSV
          </a>
          <a className="hero-link" href={buildExportUrl("json")}>
            Export JSON
          </a>
        </div>
      </section>

      <KpiGrid overview={dashboard.overview} scopeLabel={scopeLabel} />

      <section className="surface-grid">
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
          />
        </Suspense>
        <div className="surface-stack">
          <RecentSessionsTable
            onSelect={handleSelectSession}
            rows={dashboard.sessions}
            selectedSessionId={selectedSessionId}
          />
          <SessionTimelinePanel detail={selectedSession} />
        </div>
      </section>

      <section className="surface-stack">
        <ToolRankingTable
          rows={rankingRows}
          scope={globalScope}
          scopeLabel={scopeLabel}
          override={rankingOverride}
          onOverrideChange={setRankingOverride}
          statusMessage={rankingStatusMessage}
        />
      </section>
    </main>
  );
}

function buildPanelStatusMessage(
  panelName: string,
  override: TimeScopeSelection | null,
  state: PanelToolsState
): string | null {
  if (!override) {
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
