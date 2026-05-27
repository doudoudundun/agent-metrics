import type { OverviewResponse } from "../api";

type KpiGridProps = {
  overview: OverviewResponse;
  scopeLabel: string;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent"
});

export function KpiGrid({ overview, scopeLabel }: KpiGridProps) {
  const primaryItems = [
    {
      label: "Tool Calls",
      value: NUMBER_FORMAT.format(overview.totalToolCalls),
      tone: "signal",
      meta: `${NUMBER_FORMAT.format(overview.successfulExecutions)} ok / ${NUMBER_FORMAT.format(overview.failedExecutions)} failed`
    },
    {
      label: "Success Rate",
      value: PERCENT_FORMAT.format(overview.successRate),
      tone: "calm",
      meta: `${NUMBER_FORMAT.format(overview.successfulExecutions)} successful runs`
    },
    {
      label: "Edit Operations",
      value: NUMBER_FORMAT.format(overview.editOperationCount),
      tone: "steady",
      meta: `+${NUMBER_FORMAT.format(overview.insertions)} / -${NUMBER_FORMAT.format(overview.deletions)}`
    },
    {
      label: "Affected Files",
      value: NUMBER_FORMAT.format(overview.affectedFileCount),
      tone: "signal",
      meta: `${scopeLabel} footprint`
    }
  ] as const;

  const secondaryItems = [
    {
      label: "Successful Runs",
      value: NUMBER_FORMAT.format(overview.successfulExecutions)
    },
    {
      label: "Failed Runs",
      value: NUMBER_FORMAT.format(overview.failedExecutions)
    },
    {
      label: "Insertions",
      value: NUMBER_FORMAT.format(overview.insertions)
    },
    {
      label: "Deletions",
      value: NUMBER_FORMAT.format(overview.deletions)
    }
  ] as const;

  return (
    <section className="kpi-band" aria-label={`Overview metrics for ${scopeLabel}`}>
      <div className="kpi-grid">
        {primaryItems.map((item) => (
          <article className="kpi-card" data-tone={item.tone} key={item.label}>
            <span className="kpi-label">{item.label}</span>
            <strong className="kpi-value">{item.value}</strong>
            <span className="kpi-meta">{item.meta}</span>
          </article>
        ))}
      </div>
      <div className="kpi-secondary-row">
        {secondaryItems.map((item) => (
          <article className="kpi-chip" key={item.label}>
            <span className="kpi-chip-label">{item.label}</span>
            <strong className="kpi-chip-value">{item.value}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}
