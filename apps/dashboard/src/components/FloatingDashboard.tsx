import type { OverviewResponse } from "../api";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export type FloatingDashboardStatus = "loading" | "error" | "stale" | "ready";

type FloatingDashboardProps = {
  overview: OverviewResponse | null;
  status: FloatingDashboardStatus;
  statusMessage?: string | null;
};

export function FloatingDashboard({
  overview,
  status,
  statusMessage = null
}: FloatingDashboardProps) {
  const showMetrics = overview !== null;

  return (
    <section className="floating-dashboard" aria-label="Floating dashboard">
      <header className="floating-dashboard__header">
        <div>
          <p className="floating-dashboard__eyebrow">Desktop Floating</p>
          <h1>Agent Metrics</h1>
        </div>
        <p className="floating-dashboard__summary">Modified files at a glance</p>
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
            <span>Modified Files</span>
            <strong>{NUMBER_FORMAT.format(overview.affectedFileCount)}</strong>
            <small>
              {NUMBER_FORMAT.format(overview.editOperationCount)} edits / +
              {NUMBER_FORMAT.format(overview.insertions)} / -
              {NUMBER_FORMAT.format(overview.deletions)}
            </small>
          </li>
          <li>
            <span>Tool Calls</span>
            <strong>{NUMBER_FORMAT.format(overview.totalToolCalls)}</strong>
            <small>{NUMBER_FORMAT.format(overview.failedExecutions)} failed runs</small>
          </li>
          <li>
            <span>Total Tokens</span>
            <strong>{NUMBER_FORMAT.format(overview.totalTokens)}</strong>
            <small>{Math.round(overview.successRate * 100)}% success rate</small>
          </li>
        </ul>
      ) : null}
    </section>
  );
}
