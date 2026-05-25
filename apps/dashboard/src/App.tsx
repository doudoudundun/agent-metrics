import { lazy, startTransition, Suspense, useEffect, useEffectEvent, useState } from "react";
import type { OverviewResponse, SessionRow, ToolRow } from "./api";
import { fetchOverview, fetchSessions, fetchTools } from "./api";
import { KpiGrid } from "./components/KpiGrid";
import { RecentSessionsTable } from "./components/RecentSessionsTable";
import { ToolRankingTable } from "./components/ToolRankingTable";
import "./styles.css";

type DashboardState = {
  overview: OverviewResponse | null;
  sessions: SessionRow[];
  tools: ToolRow[];
};

const INITIAL_STATE: DashboardState = {
  overview: null,
  sessions: [],
  tools: []
};

const TrendChart = lazy(async () => {
  const module = await import("./components/TrendChart");

  return { default: module.TrendChart };
});

export function App() {
  const [dashboard, setDashboard] = useState<DashboardState>(INITIAL_STATE);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  const applyLoadedData = useEffectEvent((nextState: DashboardState) => {
    startTransition(() => {
      setDashboard(nextState);
      setLastUpdated(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }).format(new Date())
      );
      setStaleMessage(null);
    });
  });

  const applyLoadError = useEffectEvent((message: string) => {
    if (dashboard.overview === null) {
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
          fetchOverview(),
          fetchTools(),
          fetchSessions()
        ]);

        if (!active) {
          return;
        }

        applyLoadedData({
          overview,
          sessions,
          tools
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
  }, [applyLoadError, applyLoadedData]);

  if (!dashboard.overview) {
    return (
      <main className="app-shell">
        <section className="hero-panel">
          <div className="hero-eyebrow">Local Ops Console</div>
          <h1>Agent Metrics</h1>
          <p className="hero-copy">Loading local activity signals from the metrics core.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-eyebrow">Local Ops Console</div>
        <h1>Agent Metrics</h1>
        <p className="hero-copy">
          Overview-first telemetry for local agent sessions, tool usage, and code edit activity.
          Token figures are estimated and intended for directional usage analysis.
        </p>
        <div className="status-row">
          <div className="status-pill" data-state={staleMessage ? "stale" : "fresh"}>
            <strong>Status</strong>
            <span>{staleMessage ? "Showing stale local data" : "Polling live local data"}</span>
          </div>
          {lastUpdated ? (
            <div className="status-pill">
              <strong>Updated</strong>
              <span>{lastUpdated}</span>
            </div>
          ) : null}
        </div>
      </section>

      <KpiGrid overview={dashboard.overview} />

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
            totalToolCalls={dashboard.overview.totalToolCalls}
            successfulExecutions={dashboard.overview.successfulExecutions}
            editOperationCount={dashboard.overview.editOperationCount}
          />
        </Suspense>
        <div className="surface-stack">
          <RecentSessionsTable rows={dashboard.sessions} />
        </div>
      </section>

      <section className="surface-stack">
        <ToolRankingTable rows={dashboard.tools} />
      </section>
    </main>
  );
}
