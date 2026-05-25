import type { OverviewResponse } from "../api";

type KpiGridProps = {
  overview: OverviewResponse;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent"
});

export function KpiGrid({ overview }: KpiGridProps) {
  const items = [
    { label: "Tool Calls", value: NUMBER_FORMAT.format(overview.totalToolCalls), tone: "signal" },
    {
      label: "Successful Runs",
      value: NUMBER_FORMAT.format(overview.successfulExecutions),
      tone: "steady"
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
      label: "Estimated Tokens",
      value: NUMBER_FORMAT.format(overview.estimatedTokens),
      tone: "signal"
    }
  ] as const;

  return (
    <section className="kpi-grid" aria-label="Overview metrics">
      {items.map((item) => (
        <article className="kpi-card" data-tone={item.tone} key={item.label}>
          <span className="kpi-label">{item.label}</span>
          <strong className="kpi-value">{item.value}</strong>
        </article>
      ))}
    </section>
  );
}
