import { useState } from "react";
import type { CursorAccountUsageResponse } from "@agent-metrics/contracts";

type CursorAccountUsagePanelProps = {
  usage: CursorAccountUsageResponse | null;
  loading: boolean;
  errorMessage: string | null;
  visible: boolean;
};

const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1
});

const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const TOKEN_FORMAT = new Intl.NumberFormat("en-US");
const MODEL_USAGE_LIMIT = 8;

function formatCents(cents: number): string {
  return CURRENCY_FORMAT.format(cents / 100);
}

function formatPercent(value: number): string {
  return `${PERCENT_FORMAT.format(value)}%`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function formatTokens(value: number): string {
  return TOKEN_FORMAT.format(value);
}

export function CursorAccountUsagePanel({
  usage,
  loading,
  errorMessage,
  visible
}: CursorAccountUsagePanelProps) {
  const [modelsExpanded, setModelsExpanded] = useState(false);

  if (!visible) {
    return null;
  }

  const modelRows = [...(usage?.modelAggregations ?? [])]
    .sort((left, right) => {
      const leftTokens =
        left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens;
      const rightTokens =
        right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens;
      return rightTokens - leftTokens;
    })
    .slice(0, MODEL_USAGE_LIMIT);

  const totalModelTokens = (usage?.modelAggregations ?? []).reduce(
    (sum, row) =>
      sum + row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
    0
  );

  return (
    <section
      className="panel cursor-account-usage-panel cursor-account-usage-panel--footer"
      aria-label="Cursor official account usage"
    >
      <header className="panel__header">
        <div>
          <span className="panel__eyebrow">Cursor Usage</span>
          <h2>Official account quota</h2>
        </div>
        <span className="panel__meta">Billing-cycle reference · Synced from Cursor API</span>
      </header>

      {loading ? <p className="panel__state">Loading official usage...</p> : null}
      {!loading && errorMessage ? <p className="panel__state panel__state--error">{errorMessage}</p> : null}
      {!loading && !errorMessage && usage ? (
        <>
          <div className="cursor-account-usage-strip" aria-label="Quota summary">
            <span>
              <strong>{formatPercent(usage.totalPercentUsed)}</strong> total
            </span>
            <span>
              <strong>{formatPercent(usage.autoPercentUsed)}</strong> auto
            </span>
            <span>
              <strong>{formatPercent(usage.apiPercentUsed)}</strong> api
            </span>
            <span>{usage.planName ?? usage.planTier ?? "Unknown"}</span>
            <span>
              {formatDate(usage.billingCycleStart)} – {formatDate(usage.billingCycleEnd)}
            </span>
            {usage.displayMessage ? <span>{usage.displayMessage}</span> : null}
          </div>

          <div className="cursor-model-usage cursor-model-usage--compact">
            <button
              type="button"
              className="cursor-model-usage__toggle"
              aria-expanded={modelsExpanded}
              onClick={() => setModelsExpanded((value) => !value)}
            >
              <span>
                Cycle models · {formatTokens(totalModelTokens)} tokens ·{" "}
                {formatCents(usage.modelUsageTotalCostCents)}
              </span>
              <span>{modelsExpanded ? "Hide" : "Show"}</span>
            </button>
            {modelsExpanded && modelRows.length > 0 ? (
              <ol className="cursor-model-usage__list" aria-label="Cursor model usage this billing cycle">
                {modelRows.map((row) => {
                  const totalTokens =
                    row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
                  return (
                    <li className="cursor-model-usage__row" key={row.model}>
                      <div className="cursor-model-usage__main">
                        <strong>{row.model}</strong>
                        <span>{formatTokens(totalTokens)} tokens</span>
                      </div>
                      <div className="cursor-model-usage__meta">
                        <span>in {formatTokens(row.inputTokens)}</span>
                        <span>out {formatTokens(row.outputTokens)}</span>
                        <span>cache {formatTokens(row.cacheReadTokens + row.cacheWriteTokens)}</span>
                        <span>{formatCents(row.totalCents)}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
