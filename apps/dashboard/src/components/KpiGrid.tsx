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
  const items = [
    { label: "Tool Calls", value: NUMBER_FORMAT.format(overview.totalToolCalls), tone: "signal" },
    {
      label: "Successful Runs",
      value: NUMBER_FORMAT.format(overview.successfulExecutions),
      tone: "steady"
    },
    {
      label: "Failed Runs",
      value: NUMBER_FORMAT.format(overview.failedExecutions),
      tone: "calm"
    },
    {
      label: "Success Rate",
      value: PERCENT_FORMAT.format(overview.successRate),
      tone: "calm"
    },
    {
      label: "Edit Operations",
      value: NUMBER_FORMAT.format(overview.editOperationCount),
      tone: "steady"
    },
    {
      label: "Affected Files",
      value: NUMBER_FORMAT.format(overview.affectedFileCount),
      tone: "signal"
    },
    {
      label: "Insertions",
      value: NUMBER_FORMAT.format(overview.insertions),
      tone: "steady"
    },
    {
      label: "Deletions",
      value: NUMBER_FORMAT.format(overview.deletions),
      tone: "calm"
    }
  ] as const;

  return (
    <section className="kpi-grid" aria-label={`Overview metrics for ${scopeLabel}`}>
      {items.map((item) => (
        <article className="kpi-card" data-tone={item.tone} key={item.label}>
          <span className="kpi-label">{item.label}</span>
          <strong className="kpi-value">{item.value}</strong>
        </article>
      ))}
    </section>
  );
}
