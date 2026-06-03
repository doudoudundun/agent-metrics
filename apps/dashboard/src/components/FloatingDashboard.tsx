import type { OverviewResponse, SessionRow } from "../api";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export type FloatingDashboardStatus = "loading" | "error" | "stale" | "ready";
export type FloatingDashboardSessionsStatus = "loading" | "error" | "ready";

type FloatingDashboardProps = {
  overview: OverviewResponse | null;
  sessions: SessionRow[];
  status: FloatingDashboardStatus;
  statusMessage?: string | null;
  sessionStatus?: FloatingDashboardSessionsStatus;
  sessionStatusMessage?: string | null;
};

export function FloatingDashboard({
  overview,
  sessions,
  status,
  statusMessage = null,
  sessionStatus,
  sessionStatusMessage = null
}: FloatingDashboardProps) {
  const visibleSessions = sessions.slice(0, 5);
  const showMetrics = overview !== null;
  const resolvedSessionStatus =
    sessionStatus ??
    (status === "loading" ? "loading" : status === "error" ? "error" : "ready");
  const sessionSummaryLabel =
    resolvedSessionStatus === "ready"
      ? `${NUMBER_FORMAT.format(sessions.length)} live`
      : resolvedSessionStatus === "loading"
        ? "syncing"
        : "degraded";

  return (
    <section className="floating-dashboard" aria-label="Floating dashboard">
      <header className="floating-dashboard__header">
        <div>
          <p className="floating-dashboard__eyebrow">Desktop Floating</p>
          <h1>Agent Metrics</h1>
        </div>
        <p className="floating-dashboard__summary">Always-on-top summary</p>
      </header>

      {status === "loading" ? (
        <div role="status" aria-live="polite">
          <strong>Loading live summary...</strong>
        </div>
      ) : null}
      {status === "error" ? (
        <div role="alert">
          <strong>Floating summary unavailable</strong>
          {statusMessage ? <p>{statusMessage}</p> : null}
        </div>
      ) : null}
      {status === "stale" ? (
        <div role="status" aria-live="polite">
          <strong>Showing stale summary</strong>
          {statusMessage ? <p>{statusMessage}</p> : null}
        </div>
      ) : null}

      {showMetrics ? (
        <ul className="floating-dashboard__kpis" aria-label="Floating summary metrics">
          <li>
            <span>Sessions</span>
            <strong>{NUMBER_FORMAT.format(overview.sessionCount)}</strong>
          </li>
          <li>
            <span>Turns</span>
            <strong>{NUMBER_FORMAT.format(overview.turnCount)}</strong>
          </li>
          <li>
            <span>Tokens</span>
            <strong>{NUMBER_FORMAT.format(overview.totalTokens)}</strong>
          </li>
        </ul>
      ) : null}

      <div className="floating-dashboard__sessions-header">
        <span>Recent sessions</span>
        <span>{sessionSummaryLabel}</span>
      </div>
      <ul className="floating-dashboard__sessions" aria-label="Recent sessions">
        {resolvedSessionStatus === "loading" && visibleSessions.length === 0 ? (
          <li className="floating-dashboard__empty">Loading recent sessions...</li>
        ) : resolvedSessionStatus === "error" && visibleSessions.length === 0 ? (
          <li className="floating-dashboard__empty">
            <strong>Recent sessions unavailable</strong>
            {sessionStatusMessage ? <span>{sessionStatusMessage}</span> : null}
          </li>
        ) : visibleSessions.length > 0 ? (
          visibleSessions.map((session) => (
            <li key={session.sessionId}>
              <strong>{session.workspacePath}</strong>
              <span>
                {NUMBER_FORMAT.format(session.totalTokens)} tokens /{" "}
                {NUMBER_FORMAT.format(session.turnCount)} turns
              </span>
            </li>
          ))
        ) : (
          <li className="floating-dashboard__empty">No recent sessions in this scope</li>
        )}
      </ul>
    </section>
  );
}
