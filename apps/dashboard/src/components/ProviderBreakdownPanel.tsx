import type { ProviderBreakdownRow } from "../api";

/**
 * The overview contract keeps providerId non-empty, but raw rows can still
 * arrive without an id; such rows render as "unknown".
 */
type ProviderRow = Omit<ProviderBreakdownRow, "providerId"> & { providerId: string | null };

type ProviderBreakdownPanelProps = {
  rows: ProviderRow[];
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const SHARE_FORMAT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1
});

export function ProviderBreakdownPanel({ rows }: ProviderBreakdownPanelProps) {
  const rankedRows = [...rows].sort(compareProviders);
  const totalTokens = rankedRows.reduce((sum, row) => sum + row.totalTokens, 0);

  return (
    <section className="panel provider-breakdown-panel">
      <div className="panel-heading">
        <h2>Provider Breakdown</h2>
        <span>{rankedRows.length} providers</span>
      </div>
      {rankedRows.length > 0 ? (
        <ol aria-label="Provider token breakdown" className="provider-breakdown-list">
          {rankedRows.map((row) => {
            const share = totalTokens > 0 ? row.totalTokens / totalTokens : 0;

            return (
              <li className="provider-breakdown-row" key={buildRowKey(row)}>
                <div className="provider-breakdown-main">
                  <strong>{formatProviderLabel(row.providerId)}</strong>
                  {row.providerHost ? (
                    <span className="provider-breakdown-host">{row.providerHost}</span>
                  ) : null}
                  <span>{NUMBER_FORMAT.format(row.totalTokens)} tokens</span>
                  <span className="provider-breakdown-share">{SHARE_FORMAT.format(share)}</span>
                </div>
                <div className="provider-breakdown-track" aria-hidden="true">
                  <div className="provider-breakdown-bar" style={{ width: `${(share * 100).toFixed(2)}%` }} />
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="panel-empty">No provider token usage in this scope.</p>
      )}
    </section>
  );
}

function compareProviders(left: ProviderRow, right: ProviderRow): number {
  return (
    right.totalTokens - left.totalTokens ||
    formatProviderLabel(left.providerId).localeCompare(formatProviderLabel(right.providerId)) ||
    (left.providerHost ?? "").localeCompare(right.providerHost ?? "")
  );
}

function formatProviderLabel(providerId: string | null): string {
  const normalized = providerId?.trim() ?? "";

  if (normalized.length === 0 || normalized.toLowerCase() === "unknown") {
    return "unknown";
  }

  return normalized;
}

function buildRowKey(row: ProviderRow): string {
  return `${formatProviderLabel(row.providerId)}@${row.providerHost ?? "local"}`;
}
