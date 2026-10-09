import { startTransition, useEffect, useEffectEvent, useState } from "react";
import { FloatingDashboard } from "./components/FloatingDashboard";
import { OrbSurface } from "./components/OrbSurface";
import { PeekCardDashboard } from "./components/PeekCardDashboard";
import { getLegacyDesktopBridge } from "./legacyDesktopBridge";
import { fetchOverview, fetchTools, type OverviewResponse, type ToolRow } from "./legacy-api";
import { DEFAULT_TIME_SCOPE } from "./time-scope";

const LIVE_REFRESH_MS = 5000;
const DEFAULT_SOURCE_VENDOR = "all";

type PeekMetrics = Parameters<typeof PeekCardDashboard>[0]["metrics"];

type DesktopOrbSnapshot = {
  status: "loading" | "ready" | "stale";
  metrics: PeekMetrics;
  updatedAt: string | null;
};

type LegacyDesktopSurfacesProps = {
  surface: "desktop-floating" | "desktop-orb" | "desktop-orb-peek";
};

/**
 * Pre-Phase-5 compact desktop surfaces (floating summary, orb, and peek card).
 * These are isolated from the main DashboardPage/query-hooks path and are kept
 * only for Phase 7 parity; they still poll `legacy-api` directly.
 */
export function LegacyDesktopSurfaces({ surface }: LegacyDesktopSurfacesProps) {
  const isFloatingSurface = surface === "desktop-floating";
  const isOrbSurface = surface === "desktop-orb";
  const desktopApi = getLegacyDesktopBridge();
  const orbDockEdge = isOrbSurface
    ? (new URLSearchParams(window.location.search).get("dockEdge") as "left" | "right" | null)
    : null;
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [toolRows, setToolRows] = useState<ToolRow[] | null>(null);
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
    if (sharedPeekSnapshot !== null) {
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
        const nextOverview = await fetchOverview(DEFAULT_TIME_SCOPE, DEFAULT_SOURCE_VENDOR);

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
  }, []);

  useEffect(() => {
    if (!desktopApi?.getOrbSnapshot) {
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
          const nextSnapshot = shouldMarkStale
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
  }, [desktopApi, loadErrorMessage, overview, staleMessage]);

  useEffect(() => {
    if (isFloatingSurface || isOrbSurface) {
      setToolRows(null);
      return;
    }

    let active = true;

    const loadTools = async () => {
      try {
        const nextTools = await fetchTools(DEFAULT_TIME_SCOPE, DEFAULT_SOURCE_VENDOR);

        if (!active) {
          return;
        }

        startTransition(() => {
          setToolRows(nextTools.rows);
        });
      } catch {
        // Peek metrics fall back to a zeroed average duration when the tools request fails.
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
  }, [isFloatingSurface, isOrbSurface]);

  const floatingStatus =
    overview === null ? (loadErrorMessage ? "error" : "loading") : staleMessage ? "stale" : "ready";
  const floatingStatusMessage = overview === null ? loadErrorMessage : staleMessage;
  const peekMetrics = buildPeekMetrics(overview, toolRows);
  const effectivePeekSnapshot: DesktopOrbSnapshot =
    overview === null && sharedPeekSnapshot !== null
      ? sharedPeekSnapshot
      : {
          status: staleMessage ? "stale" : overview === null ? "loading" : "ready",
          metrics: peekMetrics,
          updatedAt: overview?.updatedAt ?? sharedPeekSnapshot?.updatedAt ?? null
        };

  useEffect(() => {
    if (!desktopApi?.setOrbSnapshot || overview === null) {
      return;
    }

    const nextMetrics = buildPeekMetrics(overview, toolRows);
    const nextSnapshot: DesktopOrbSnapshot = {
      status: staleMessage ? "stale" : "ready",
      metrics: nextMetrics,
      updatedAt: overview.updatedAt
    };

    startTransition(() => {
      setSharedPeekSnapshot(nextSnapshot);
    });
    void desktopApi.setOrbSnapshot(nextSnapshot);
  }, [toolRows, desktopApi, overview, staleMessage]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
