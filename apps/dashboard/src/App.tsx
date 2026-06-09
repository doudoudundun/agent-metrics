import { lazy, startTransition, Suspense, useEffect, useEffectEvent, useState } from "react";
import type {
  OverviewResponse,
  SessionDetailResponse,
  SessionRow,
  SourceVendor,
  TokenTrendPoint,
  ToolRow
} from "./api";
import {
  buildExportUrl,
  fetchTokenTrend,
  fetchOverview,
  fetchSessionDetail,
  fetchSessions,
  fetchTools
} from "./api";
import { FloatingDashboard } from "./components/FloatingDashboard";
import { KpiGrid } from "./components/KpiGrid";
import { ModelUsagePanel } from "./components/ModelUsagePanel";
import { OrbSurface } from "./components/OrbSurface";
import { PeekCardDashboard } from "./components/PeekCardDashboard";
import { RecentSessionsTable } from "./components/RecentSessionsTable";
import { SessionTimelinePanel } from "./components/SessionTimelinePanel";
import { TimeScopeToolbar } from "./components/TimeScopeToolbar";
import { TokenTrendPanel } from "./components/TokenTrendPanel";
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

type TokenTrendState = {
  rows: TokenTrendPoint[] | null;
  loading: boolean;
  errorMessage: string | null;
};

type RowsPanelState = {
  rows: unknown[] | null;
  loading: boolean;
  errorMessage: string | null;
};

type SessionsState = {
  rows: SessionRow[] | null;
  loading: boolean;
  errorMessage: string | null;
};

type PeekMetrics = Parameters<typeof PeekCardDashboard>[0]["metrics"];

type DesktopOrbSnapshot = {
  status: "loading" | "ready" | "stale";
  metrics: PeekMetrics;
  updatedAt: string | null;
};

const INITIAL_PANEL_TOOLS_STATE: PanelToolsState = {
  rows: null,
  loading: false,
  errorMessage: null
};

const INITIAL_TOKEN_TREND_STATE: TokenTrendState = {
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
  const isOrbSurface = desktopSurface === "desktop-orb";
  const isPeekSurface = desktopSurface === "desktop-orb-peek";
  const isCompactSurface = isFloatingSurface || isOrbSurface || isPeekSurface;
  const isFullDashboardSurface = !isCompactSurface;
  const desktopApi = getAgentMetricsDesktopBridge();
  const orbDockEdge = isOrbSurface
    ? (new URLSearchParams(window.location.search).get("dockEdge") as "left" | "right" | null)
    : null;
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [baseTools, setBaseTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [baseSessions, setBaseSessions] = useState<SessionsState>(INITIAL_SESSIONS_STATE);
  const [globalScope, setGlobalScope] = useState<TimeScopeSelection>(DEFAULT_TIME_SCOPE);
  const [selectedSourceVendor, setSelectedSourceVendor] = useState<SourceVendor>("all");
  const [tokenTrendOverride, setTokenTrendOverride] = useState<TimeScopeSelection | null>(null);
  const [trendOverride, setTrendOverride] = useState<TimeScopeSelection | null>(null);
  const [rankingOverride, setRankingOverride] = useState<TimeScopeSelection | null>(null);
  const [baseTokenTrend, setBaseTokenTrend] = useState<TokenTrendState>(INITIAL_TOKEN_TREND_STATE);
  const [tokenTrendData, setTokenTrendData] = useState<TokenTrendState>(INITIAL_TOKEN_TREND_STATE);
  const [trendTools, setTrendTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [rankingTools, setRankingTools] = useState<PanelToolsState>(INITIAL_PANEL_TOOLS_STATE);
  const [selectedSession, setSelectedSession] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const [sharedPeekSnapshot, setSharedPeekSnapshot] = useState<DesktopOrbSnapshot | null>(null);
  const [peekPinned, setPeekPinned] = useState(false);

  const applyLoadedOverview = useEffectEvent((nextOverview: OverviewResponse) => {
    startTransition(() => {
      setOverview(nextOverview);
      setLoadErrorMessage(null);
      setStaleMessage(null);
    });
  });

  const applyLoadError = useEffectEvent((message: string) => {
    if (isCompactSurface && sharedPeekSnapshot !== null) {
      startTransition(() => {
        setSharedPeekSnapshot({
          ...sharedPeekSnapshot,
          status: "stale"
        });
        setLoadErrorMessage(null);
        setStaleMessage(message);
      });
      void desktopApi?.markOrbStale?.();
      return;
    }

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

  const handlePeekPin = useEffectEvent(() => {
    void desktopApi?.pinPeekCard().then((result) => {
      startTransition(() => {
        setPeekPinned(result.pinned);
      });
    });
  });

  const handlePeekPinButton = useEffectEvent(() => {
    const pinAction = peekPinned ? desktopApi?.togglePeekCardPin : desktopApi?.pinPeekCard;

    void pinAction?.().then((result) => {
      startTransition(() => {
        setPeekPinned(result.pinned);
      });
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
    if (!isCompactSurface || !desktopApi?.getOrbSnapshot) {
      setSharedPeekSnapshot(null);
      return;
    }

    let active = true;

    void desktopApi
      .getOrbSnapshot()
      .then((snapshot) => {
        if (!active) {
          return;
        }

        const parsedSnapshot = parseDesktopOrbSnapshot(snapshot);

        if (parsedSnapshot !== null) {
          const shouldMarkStale = overview === null && (loadErrorMessage !== null || staleMessage !== null);
          const nextSnapshot =
            shouldMarkStale
              ? {
                  ...parsedSnapshot,
                  status: "stale" as const
                }
              : parsedSnapshot;

          startTransition(() => {
            setSharedPeekSnapshot(nextSnapshot);
          });

          if (shouldMarkStale) {
            void desktopApi.markOrbStale?.();
          }
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [desktopApi, isCompactSurface, loadErrorMessage, overview, staleMessage]);

  useEffect(() => {
    if (!isFullDashboardSurface) {
      setBaseTokenTrend(INITIAL_TOKEN_TREND_STATE);
      return;
    }

    let active = true;
    setBaseTokenTrend((current) => ({
      rows: current.rows,
      loading: true,
      errorMessage: null
    }));

    const loadTokenTrend = async () => {
      try {
        const nextTrend = await fetchTokenTrend(globalScope, selectedSourceVendor);

        if (!active) {
          return;
        }

        startTransition(() => {
          setBaseTokenTrend({
            rows: nextTrend.rows,
            loading: false,
            errorMessage: null
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }

        startTransition(() => {
          setBaseTokenTrend((current) => ({
            ...current,
            loading: false,
            errorMessage: messageFromError(error)
          }));
        });
      }
    };

    void loadTokenTrend();
    const timer = window.setInterval(() => {
      void loadTokenTrend();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [globalScope, isFullDashboardSurface, selectedSourceVendor]);

  useEffect(() => {
    if (isFloatingSurface || isOrbSurface) {
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
  }, [globalScope, isFloatingSurface, isOrbSurface, selectedSourceVendor]);

  useEffect(() => {
    if (!isFullDashboardSurface) {
      setBaseSessions(INITIAL_SESSIONS_STATE);
      return;
    }

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
  }, [globalScope, isFloatingSurface, isFullDashboardSurface, selectedSourceVendor]);

  useEffect(() => {
    if (!isFullDashboardSurface || !tokenTrendOverride) {
      setTokenTrendData(INITIAL_TOKEN_TREND_STATE);
      return;
    }

    let active = true;
    setTokenTrendData((current) => ({
      rows: current.rows,
      loading: true,
      errorMessage: null
    }));

    const loadTokenTrend = async () => {
      try {
        const nextTrend = await fetchTokenTrend(tokenTrendOverride, selectedSourceVendor);

        if (!active) {
          return;
        }

        startTransition(() => {
          setTokenTrendData({
            rows: nextTrend.rows,
            loading: false,
            errorMessage: null
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }

        startTransition(() => {
          setTokenTrendData((current) => ({
            ...current,
            loading: false,
            errorMessage: messageFromError(error)
          }));
        });
      }
    };

    void loadTokenTrend();
    const timer = window.setInterval(() => {
      void loadTokenTrend();
    }, LIVE_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isFullDashboardSurface, selectedSourceVendor, tokenTrendOverride]);

  useEffect(() => {
    if (!isFullDashboardSurface || !trendOverride) {
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
  }, [isFullDashboardSurface, trendOverride, selectedSourceVendor]);

  useEffect(() => {
    if (!isFullDashboardSurface || !rankingOverride) {
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
  }, [isFullDashboardSurface, rankingOverride, selectedSourceVendor]);

  useEffect(() => {
    if (!isFullDashboardSurface) {
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
  }, [baseSessions.rows, isFullDashboardSurface, selectedSessionId]);

  useEffect(() => {
    if (!isFullDashboardSurface) {
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
  }, [isFullDashboardSurface, selectedSessionId]);

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
  const peekMetrics = buildPeekMetrics(overview, baseTools.rows);
  const effectivePeekSnapshot: DesktopOrbSnapshot =
    overview === null && sharedPeekSnapshot !== null
      ? sharedPeekSnapshot
      : {
          status: staleMessage ? "stale" : overview === null ? "loading" : "ready",
          metrics: peekMetrics,
          updatedAt: overview?.updatedAt ?? sharedPeekSnapshot?.updatedAt ?? null
        };

  useEffect(() => {
    if (!isCompactSurface || !desktopApi?.setOrbSnapshot || overview === null) {
      return;
    }

    const nextMetrics = buildPeekMetrics(overview, baseTools.rows);
    const nextSnapshot: DesktopOrbSnapshot = {
      status: staleMessage ? "stale" : "ready",
      metrics: nextMetrics,
      updatedAt: overview.updatedAt
    };

    startTransition(() => {
      setSharedPeekSnapshot(nextSnapshot);
    });
    void desktopApi.setOrbSnapshot(nextSnapshot);
  }, [baseTools.rows, desktopApi, isCompactSurface, overview, staleMessage]);

  if (isFloatingSurface) {
    return (
      <main className="app-shell app-shell--floating">
        <FloatingDashboard
          overview={overview}
          status={floatingStatus}
          statusMessage={floatingStatusMessage}
        />
      </main>
    );
  }

  if (isOrbSurface) {
    return (
      <main className="app-shell app-shell--orb">
        <OrbSurface
          collapsed={effectivePeekSnapshot.status === "loading"}
          stale={effectivePeekSnapshot.status === "stale"}
          dockEdge={orbDockEdge}
          onPointerEnter={() => void desktopApi?.showOrb()}
          onPointerLeave={() => void desktopApi?.hideOrb()}
          onActivate={handlePeekPin}
          onContextMenu={() => void desktopApi?.showOrbMenu?.()}
          onDragStart={() => void desktopApi?.orbDragStart()}
          onDragEnd={() => void desktopApi?.orbDragEnd()}
        />
      </main>
    );
  }

  if (isPeekSurface) {
    return (
      <main className="app-shell app-shell--peek">
        <PeekCardDashboard
          status={effectivePeekSnapshot.status}
          metrics={effectivePeekSnapshot.metrics}
          pinned={peekPinned}
          onPin={handlePeekPinButton}
          onExpand={() => void desktopApi?.expandOrbDetail()}
          onPointerEnter={() => void desktopApi?.peekEnter?.()}
          onPointerLeave={() => void desktopApi?.peekLeave?.()}
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
  const baseTokenTrendRows = baseTokenTrend.rows ?? [];
  const tokenTrendRows = tokenTrendOverride ? (tokenTrendData.rows ?? baseTokenTrendRows) : baseTokenTrendRows;
  const lastUpdated = formatScopeDateTime(overview.updatedAt, overview.timezone);
  const trendRows = trendOverride ? (trendTools.rows ?? baseToolRows) : baseToolRows;
  const rankingRows = rankingOverride ? (rankingTools.rows ?? baseToolRows) : baseToolRows;
  const sourceBreakdownRows = overview.sourceBreakdown ?? [];
  const baseToolEmptyMessage = buildToolEmptyMessage(
    baseTools,
    baseToolRows,
    selectedSourceVendor
  );
  const tokenTrendEmptyMessage = buildRowsEmptyMessage(
    "Loading global token trend...",
    "Global token trend unavailable",
    baseTokenTrend,
    baseTokenTrendRows,
    selectedSourceVendor,
    "No token activity in this scope."
  );
  const tokenTrendStatusMessage = buildPanelStatusMessage(
    "Token Trend",
    tokenTrendOverride,
    tokenTrendData,
    baseTokenTrend
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
          <TokenTrendPanel
            rows={tokenTrendRows}
            scope={globalScope}
            scopeLabel={scopeLabel}
            override={tokenTrendOverride}
            onOverrideChange={setTokenTrendOverride}
            statusMessage={tokenTrendStatusMessage}
            emptyMessage={tokenTrendEmptyMessage}
          />
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

function averageToolDuration(rows: ToolRow[] | null): number {
  if (!rows || rows.length === 0) {
    return 0;
  }

  const totals = rows.reduce(
    (accumulator, row) => {
      if (row.count <= 0) {
        return accumulator;
      }

      return {
        duration: accumulator.duration + row.averageDurationMs * row.count,
        count: accumulator.count + row.count
      };
    },
    { duration: 0, count: 0 }
  );

  return totals.count > 0 ? totals.duration / totals.count : 0;
}

function buildPeekMetrics(overview: OverviewResponse | null, rows: ToolRow[] | null): PeekMetrics {
  return {
    totalTokens: overview?.totalTokens ?? 0,
    cacheReadTokens: overview?.cacheReadTokens ?? 0,
    totalToolCalls: overview?.totalToolCalls ?? 0,
    editOperationCount: overview?.editOperationCount ?? 0,
    affectedFileCount: overview?.affectedFileCount ?? 0,
    insertions: overview?.insertions ?? 0,
    deletions: overview?.deletions ?? 0,
    successRate: overview?.successRate ?? 0,
    failedExecutions: overview?.failedExecutions ?? 0,
    averageDurationMs: averageToolDuration(rows)
  };
}

function parseDesktopOrbSnapshot(snapshot: unknown): DesktopOrbSnapshot | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.metrics)) {
    return null;
  }

  const status =
    snapshot.status === "ready" || snapshot.status === "stale" || snapshot.status === "loading"
      ? snapshot.status
      : "loading";

  return {
    status,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null,
    metrics: {
      totalTokens: readNumber(snapshot.metrics.totalTokens),
      cacheReadTokens: readNumber(snapshot.metrics.cacheReadTokens),
      totalToolCalls: readNumber(snapshot.metrics.totalToolCalls),
      editOperationCount: readNumber(snapshot.metrics.editOperationCount),
      affectedFileCount: readNumber(snapshot.metrics.affectedFileCount),
      insertions: readNumber(snapshot.metrics.insertions),
      deletions: readNumber(snapshot.metrics.deletions),
      successRate: readNumber(snapshot.metrics.successRate),
      failedExecutions: readNumber(snapshot.metrics.failedExecutions),
      averageDurationMs: readNumber(snapshot.metrics.averageDurationMs)
    }
  };
}

function buildPanelStatusMessage(
  panelName: string,
  override: TimeScopeSelection | null,
  state: RowsPanelState,
  baseState: RowsPanelState
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildToolEmptyMessage(
  state: PanelToolsState,
  rows: ToolRow[],
  selectedSourceVendor: SourceVendor
): string {
  return buildRowsEmptyMessage(
    "Loading global tool metrics...",
    "Global tool metrics unavailable",
    state,
    rows,
    selectedSourceVendor,
    DEFAULT_TOOL_EMPTY_MESSAGE
  );
}

function buildRowsEmptyMessage(
  loadingMessage: string,
  unavailablePrefix: string,
  state: RowsPanelState,
  rows: unknown[],
  selectedSourceVendor: SourceVendor,
  defaultMessage: string
): string {
  if (state.loading) {
    return loadingMessage;
  }

  if (state.errorMessage) {
    return `${unavailablePrefix}: ${state.errorMessage}`;
  }

  if (rows.length === 0 && selectedSourceVendor !== "all") {
    return SOURCE_UNAVAILABLE_MESSAGE;
  }

  return defaultMessage;
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
