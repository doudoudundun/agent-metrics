import { useState } from "react";
import type { CursorAccountUsageResponse } from "@agent-metrics/contracts";

type CursorQuotaCardProps = {
  usage: CursorAccountUsageResponse | null;
  loading: boolean;
  errorMessage: string | null;
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

/** Cursor official account quota as one card inside the unified key usage grid. */
export function CursorQuotaCard({ usage, loading, errorMessage }: CursorQuotaCardProps) {
  const [modelsExpanded, setModelsExpanded] = useState(false);

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

  const remainingCents = usage?.remainingCents ?? null;
  const planLabel = usage
    ? [
        usage.planName ?? usage.planTier,
        `${formatDate(usage.billingCycleStart)} – ${formatDate(usage.billingCycleEnd)}`
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" · ")
    : "Official account";

  return (
    <li className="key-usage-card key-usage-card--cursor" aria-label="Cursor official account usage">
      <div className="key-usage-card__head">
        <strong className="key-usage-card__vendor">Cursor</strong>
        <span className="key-usage-card__limit">{planLabel}</span>
        <span
          className="key-usage-card__credits"
          data-state={remainingCents !== null && remainingCents > 0 ? "available" : "none"}
        >
          {remainingCents !== null ? `${formatCents(remainingCents)} left` : "Balance unknown"}
        </span>
      </div>

      {loading ? <p className="key-usage-card__empty">Loading Cursor usage...</p> : null}
      {!loading && errorMessage ? (
        <p className="key-usage-panel__error">{errorMessage}</p>
      ) : null}
      {!loading && !errorMessage && usage ? (
        <>
          <div className="cursor-quota-grid" aria-label="Quota summary">
            <QuotaBar label="Total" percent={usage.totalPercentUsed} />
            <QuotaBar label="Auto" percent={usage.autoPercentUsed} />
            <QuotaBar label="API" percent={usage.apiPercentUsed} />
          </div>
          {usage.displayMessage ? <p className="cursor-quota-note">{usage.displayMessage}</p> : null}

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
    </li>
  );
}

function QuotaBar({ label, percent }: { label: string; percent: number }) {
  const value = Math.max(0, percent);
  const width = Math.min(100, value);
  const tone = value >= 90 ? "danger" : value >= 70 ? "warn" : "ok";
  return (
    <div className="cursor-quota-card">
      <div className="cursor-quota-card__head">
        <span className="cursor-quota-card__label">{label}</span>
        <span className="cursor-quota-card__percent">{formatPercent(value)}</span>
      </div>
      <div
        className="cursor-quota-card__bar"
        role="progressbar"
        aria-label={`${label} quota used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
      >
        <span className="cursor-quota-card__fill" data-tone={tone} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
