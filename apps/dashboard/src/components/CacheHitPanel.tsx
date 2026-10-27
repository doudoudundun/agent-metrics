import type { SourceBreakdownRow } from "../api";
import { SOURCE_LABELS } from "../source-labels";

type CacheHitPanelProps = {
  rows: SourceBreakdownRow[];
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1
});
const AGENT_LIMIT = 6;

/**
 * Cache hit rate per agent. Prompt caching is the single biggest lever on input
 * cost, so the same rate the token trend shows over time is shown here broken
 * down by source vendor, ranked by how effective each agent's caching is.
 */
export function CacheHitPanel({ rows }: CacheHitPanelProps) {
  const rankedRows = rows
    // Agents with no usage in scope would render a meaningless 0%; they stay out
    // of the ranking entirely.
    .filter((row) => row.totalTokens > 0)
    .sort(
      (left, right) =>
        right.cacheHitRate - left.cacheHitRate ||
        right.totalTokens - left.totalTokens ||
        left.sourceVendor.localeCompare(right.sourceVendor)
    );
  const visibleRows = rankedRows.slice(0, AGENT_LIMIT);

  return (
    <section className="panel cache-hit-panel">
      <div className="panel-heading">
        <h2>Cache Hit Rate</h2>
        <span>{buildCountLabel(visibleRows.length, rankedRows.length)}</span>
      </div>
      {visibleRows.length > 0 ? (
        <ol aria-label="Cache hit rate by agent" className="cache-hit-list">
          {visibleRows.map((row) => (
            <li className="cache-hit-row" key={row.sourceVendor}>
              <div className="cache-hit-main">
                <strong>{SOURCE_LABELS[row.sourceVendor] ?? row.sourceVendor}</strong>
                <span>{NUMBER_FORMAT.format(row.totalTokens)} tokens</span>
                <span className="cache-hit-value">{PERCENT_FORMAT.format(row.cacheHitRate)}</span>
              </div>
              <div className="cache-hit-track" aria-hidden="true">
                <div
                  className="cache-hit-bar"
                  style={{ width: `${(row.cacheHitRate * 100).toFixed(2)}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="panel-empty">No cacheable input in this scope.</p>
      )}
    </section>
  );
}

function buildCountLabel(visibleCount: number, totalCount: number): string {
  if (totalCount <= AGENT_LIMIT) {
    return `${visibleCount} ${visibleCount === 1 ? "agent" : "agents"}`;
  }

  return `Top ${visibleCount} of ${totalCount}`;
}
