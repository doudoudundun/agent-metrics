import type { ReactNode } from "react";
import type { OverviewResponse } from "../api";

type KpiGridProps = {
  overview: OverviewResponse;
  scopeLabel: string;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function KpiGrid({ overview, scopeLabel }: KpiGridProps) {
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
      meta: `${NUMBER_FORMAT.format(overview.inputTokens)} in / ${NUMBER_FORMAT.format(overview.outputTokens)} out`
    },
    {
      label: "Turns",
      value: NUMBER_FORMAT.format(overview.turnCount),
      tone: "calm",
      meta: `${NUMBER_FORMAT.format(overview.responseCount)} responses`
    },
    {
      label: "Tool Calls",
      value: NUMBER_FORMAT.format(overview.totalToolCalls),
      tone: "steady",
      meta: (
        <>
          {NUMBER_FORMAT.format(overview.successfulExecutions)} ok /{" "}
          {NUMBER_FORMAT.format(overview.failedExecutions)} failed
        </>
      )
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
