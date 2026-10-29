import type { ReactNode } from "react";

type OverviewResponse = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnCount: number;
  responseCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  startedOnlyExecutions: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  totalCostUsd: number | null;
};

type KpiGridProps = {
  overview: OverviewResponse;
  scopeLabel: string;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const SMALL_COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

function formatCost(costUsd: number | null): string {
  if (costUsd === null) {
    return "—";
  }
  if (costUsd > 0 && costUsd < 0.01) {
    return SMALL_COST_FORMAT.format(costUsd);
  }

  return COST_FORMAT.format(costUsd);
}

function resolveDisplayedToolCalls(overview: OverviewResponse): number {
  const closedToolCalls = overview.successfulExecutions + overview.failedExecutions;

  if (overview.startedOnlyExecutions > 0) {
    return overview.totalToolCalls;
  }

  if (closedToolCalls > 0 && overview.totalToolCalls !== closedToolCalls) {
    return closedToolCalls;
  }

  return overview.totalToolCalls;
}

function formatToolCallMeta(overview: OverviewResponse): ReactNode {
  const startedOnlyExecutions = Math.max(0, overview.startedOnlyExecutions);

  if (startedOnlyExecutions === 0) {
    return (
      <>
        {NUMBER_FORMAT.format(overview.successfulExecutions)} ok /{" "}
        {NUMBER_FORMAT.format(overview.failedExecutions)} failed
      </>
    );
  }

  return (
    <>
      {NUMBER_FORMAT.format(overview.successfulExecutions)} ok /{" "}
      {NUMBER_FORMAT.format(overview.failedExecutions)} failed /{" "}
      {NUMBER_FORMAT.format(startedOnlyExecutions)} started-only
    </>
  );
}

export function KpiGrid({ overview, scopeLabel }: KpiGridProps) {
  const cacheTokens = overview.cacheReadTokens + overview.cacheCreationTokens;
  // Cacheable input only: output tokens are never cacheable, so counting them
  // would understate the hit rate.
  const cacheableInput = overview.inputTokens + cacheTokens;
  const cacheHitRate = cacheableInput > 0 ? overview.cacheReadTokens / cacheableInput : 0;
  const displayedToolCalls = resolveDisplayedToolCalls(overview);
  const primaryItems: Array<{
    label: string;
    value: string;
    tone: string;
    meta: ReactNode;
  }> = [
    {
      label: "Total Tokens",
      value: NUMBER_FORMAT.format(overview.totalTokens),
      tone: "signal",
      meta: `${NUMBER_FORMAT.format(overview.inputTokens)} in / ${NUMBER_FORMAT.format(overview.outputTokens)} out / ${NUMBER_FORMAT.format(cacheTokens)} cache`
    },
    {
      label: "Est. Cost",
      value: formatCost(overview.totalCostUsd),
      tone: "calm",
      meta: `${NUMBER_FORMAT.format(overview.turnCount)} turns / ${NUMBER_FORMAT.format(overview.responseCount)} responses`
    },
    {
      label: "Tool Calls",
      value: NUMBER_FORMAT.format(displayedToolCalls),
      tone: "steady",
      meta: formatToolCallMeta(overview)
    },
    {
      label: "Edit Operations",
      value: NUMBER_FORMAT.format(overview.editOperationCount),
      tone: "signal",
      meta: `${NUMBER_FORMAT.format(overview.affectedFileCount)} files, +${NUMBER_FORMAT.format(overview.insertions)} / -${NUMBER_FORMAT.format(overview.deletions)}`
    }
  ] as const;

  const secondaryItems = [
    {
      label: "Cache Read",
      value: NUMBER_FORMAT.format(overview.cacheReadTokens)
    },
    {
      label: "Cache Creation",
      value: NUMBER_FORMAT.format(overview.cacheCreationTokens)
    },
    {
      label: "Cache Hit",
      value: `${(cacheHitRate * 100).toFixed(1)}%`
    },
    {
      label: "Successful Runs",
      value: NUMBER_FORMAT.format(overview.successfulExecutions)
    },
    {
      label: "Scope",
      value: scopeLabel
    }
  ] as const;

  return (
    <section className="kpi-band" aria-label={`Overview metrics for ${scopeLabel}`}>
      <div className="kpi-grid">
        <article className="kpi-card" data-tone={primaryItems[0].tone}>
          <span className="kpi-label">{primaryItems[0].label}</span>
          <strong className="kpi-value">{primaryItems[0].value}</strong>
          <span className="kpi-meta">{primaryItems[0].meta}</span>
        </article>
        <div className="kpi-summary">
          {primaryItems.slice(1).map((item) => (
            <article className="kpi-card" data-tone={item.tone} key={item.label}>
              <span className="kpi-label">{item.label}</span>
              <strong className="kpi-value">{item.value}</strong>
              <span className="kpi-meta">{item.meta}</span>
            </article>
          ))}
          <article className="kpi-card" data-tone="calm">
            <span className="kpi-label">Successful Runs</span>
            <strong className="kpi-value">{NUMBER_FORMAT.format(overview.successfulExecutions)}</strong>
            <span className="kpi-meta">Completed without failures</span>
          </article>
        </div>
      </div>
      <div className="kpi-secondary-row">
        {secondaryItems.filter((item) => item.label !== "Successful Runs").map((item) => (
          <article className="kpi-chip" key={item.label}>
            <span className="kpi-chip-label">{item.label}</span>
            <strong className="kpi-chip-value">{item.value}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}
