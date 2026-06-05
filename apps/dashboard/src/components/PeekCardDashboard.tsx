const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0
});

type PeekCardMetrics = {
  totalTokens: number;
  totalToolCalls: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  successRate: number;
  failedExecutions: number;
  averageDurationMs: number;
};

type PeekCardDashboardProps = {
  status: "loading" | "ready" | "stale";
  metrics: PeekCardMetrics;
  onPin?: () => void;
  onExpand?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
};

export function PeekCardDashboard({
  status,
  metrics,
  onPin,
  onExpand,
  onPointerEnter,
  onPointerLeave
}: PeekCardDashboardProps) {
  const items = [
    {
      label: "Total Tokens",
      value: NUMBER_FORMAT.format(metrics.totalTokens),
      meta: `${NUMBER_FORMAT.format(metrics.totalToolCalls)} tool calls`
    },
    {
      label: "Edits",
      value: NUMBER_FORMAT.format(metrics.editOperationCount),
      meta: `${NUMBER_FORMAT.format(metrics.affectedFileCount)} files / +${NUMBER_FORMAT.format(metrics.insertions)} / -${NUMBER_FORMAT.format(metrics.deletions)}`
    },
    {
      label: "Success Rate",
      value: PERCENT_FORMAT.format(metrics.successRate),
      meta: `${NUMBER_FORMAT.format(metrics.failedExecutions)} failed runs`
    },
    {
      label: "Avg Duration",
      value: `${NUMBER_FORMAT.format(Math.round(metrics.averageDurationMs))} ms`,
      meta: "Weighted across tool rows"
    }
  ] as const;

  return (
    <section
      className="peek-card-dashboard"
      aria-label="Desktop peek card"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header className="peek-card-dashboard__header">
        <div>
          <p className="peek-card-dashboard__eyebrow">Desktop Peek</p>
          <h1>Agent Metrics</h1>
        </div>
        <div className="peek-card-dashboard__actions">
          <button type="button" onClick={onPin}>
            Pin
          </button>
          <button type="button" onClick={onExpand}>
            Expand
          </button>
        </div>
      </header>
      {status === "loading" ? (
        <p className="peek-card-dashboard__status">Loading compact metrics...</p>
      ) : null}
      {status === "stale" ? (
        <p className="peek-card-dashboard__status">Showing stale data</p>
      ) : null}
      <div className="peek-card-dashboard__grid">
        {items.map((item) => (
          <article className="peek-card-dashboard__metric" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.meta}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
