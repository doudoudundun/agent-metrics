import type { TokensByModelRow } from "../api";

type ModelUsagePanelProps = {
  rows: TokensByModelRow[];
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const MODEL_USAGE_LIMIT = 5;

export function ModelUsagePanel({ rows }: ModelUsagePanelProps) {
  const visibleRows = [...rows]
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .slice(0, MODEL_USAGE_LIMIT);

  return (
    <section className="panel model-usage-panel">
      <div className="panel-heading">
        <h2>Model Usage</h2>
        <span>{buildCountLabel(visibleRows.length, rows.length)}</span>
      </div>
      {visibleRows.length > 0 ? (
        <ol aria-label="Model usage rankings" className="model-usage-list">
          {visibleRows.map((row) => {
            const cacheTokens = row.cacheReadTokens + row.cacheCreationTokens;

            return (
              <li className="model-usage-row" key={`${row.model}-${row.totalTokens}`}>
                <div className="model-usage-main">
                  <strong>{formatModelLabel(row.model)}</strong>
                  <span>{NUMBER_FORMAT.format(row.totalTokens)} tokens</span>
                </div>
                <div className="model-usage-meta">
                  <span>in {NUMBER_FORMAT.format(row.inputTokens)}</span>
                  <span>out {NUMBER_FORMAT.format(row.outputTokens)}</span>
                  <span>cache {NUMBER_FORMAT.format(cacheTokens)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="panel-empty">No model token usage in this scope.</p>
      )}
    </section>
  );
}

function buildCountLabel(visibleCount: number, totalCount: number): string {
  if (totalCount <= MODEL_USAGE_LIMIT) {
    return `${visibleCount} tracked`;
  }

  return `Top ${visibleCount} of ${totalCount}`;
}

function formatModelLabel(model: string): string {
  if (model.trim().length === 0 || model.trim().toLowerCase() === "unknown") {
    return "Unknown model";
  }

  return model;
}
