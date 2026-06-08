import type { PointerEvent } from "react";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
type PeekCardMetrics = {
  totalTokens: number;
  cacheReadTokens: number;
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
  pinned?: boolean;
  onPin?: () => void;
  onExpand?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
};

function isNodeLike(value: EventTarget | null): value is Node {
  return value !== null && typeof value === "object" && "nodeType" in value;
}

export function PeekCardDashboard({
  status,
  metrics,
  pinned = false,
  onPin,
  onExpand,
  onPointerEnter,
  onPointerLeave
}: PeekCardDashboardProps) {
  const items = [
    {
      label: "Total Tokens",
      value: NUMBER_FORMAT.format(metrics.totalTokens),
      meta: `${NUMBER_FORMAT.format(metrics.cacheReadTokens)} cache read`
    },
    {
      label: "Tool Calls",
      value: NUMBER_FORMAT.format(metrics.totalToolCalls),
      meta: `${NUMBER_FORMAT.format(metrics.editOperationCount)} edits / ${NUMBER_FORMAT.format(metrics.affectedFileCount)} files / +${NUMBER_FORMAT.format(metrics.insertions)} / -${NUMBER_FORMAT.format(metrics.deletions)}`
    }
  ] as const;
  const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;

    if (isNodeLike(relatedTarget) && event.currentTarget.contains(relatedTarget)) {
      return;
    }

    onPointerLeave?.();
  };

  return (
    <section
      className="peek-card-dashboard"
      aria-label="Desktop peek card"
      onPointerEnter={onPointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <header className="peek-card-dashboard__header">
        <div>
          <p className="peek-card-dashboard__eyebrow">Desktop Peek</p>
          <h1>Agent Metrics</h1>
        </div>
        <div className="peek-card-dashboard__actions">
          <button
            type="button"
            onClick={onPin}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            onClick={onExpand}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
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
