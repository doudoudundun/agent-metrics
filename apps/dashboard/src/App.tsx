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
  const [selectedSession, setSelectedSession] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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
          Hooks-first telemetry for local agent sessions, real Claude Code tool usage, and code
          edit activity.
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
        <div className="hero-actions">
          <a className="hero-link" href={buildExportUrl("csv")}>
            Export CSV
          </a>
          <a className="hero-link" href={buildExportUrl("json")}>
            Export JSON
          </a>
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
          <TrendChart rows={dashboard.tools} />
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
        <ToolRankingTable rows={dashboard.tools} />
      </section>
    </main>
  );
}
