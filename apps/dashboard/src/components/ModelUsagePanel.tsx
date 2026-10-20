import type { TokensByModelRow } from "../api";

type ModelUsagePanelProps = {
  rows: TokensByModelRow[];
};

type RowSourceVendor = TokensByModelRow["sourceVendor"];

const SOURCE_LABELS: Record<RowSourceVendor, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  kimicode: "Kimi Code",
  mimo: "MiMo",
  zcode: "ZCode",
  dsh: "DSH",
  workbuddy: "WorkBuddy"
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
              <li className="model-usage-row" key={`${row.sourceVendor}-${row.model}`}>
                <div className="model-usage-main">
                  <strong>{formatModelLabel(row.model)}</strong>
                  <span className="model-usage-source">{SOURCE_LABELS[row.sourceVendor]}</span>
                  <span>{NUMBER_FORMAT.format(row.totalTokens)} tokens</span>
                  <span
                    className="model-usage-cost"
                    title={row.costUsd === null ? "No official pricing" : undefined}
                  >
                    {formatCost(row.costUsd)}
                  </span>
                </div>
                <div className="model-usage-meta">
                  <span>in {NUMBER_FORMAT.format(row.inputTokens)}</span>
                  <span>out {NUMBER_FORMAT.format(row.outputTokens)}</span>
                  <span>cache {NUMBER_FORMAT.format(cacheTokens)}</span>
                </div>
                <div className="model-usage-meta model-usage-timing">
                  <span title="Average output tokens per second (weighted by decode time)">
                    {formatSpeed(row.avgOutputTokensPerSecond)}
                  </span>
                  <span title="Average time to first token">
                    TTFT {formatTtft(row.avgFirstTokenLatencyMs)}
                  </span>
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

function formatCost(costUsd: number | null): string {
  if (costUsd === null) {
    return "—";
  }

  if (costUsd > 0 && costUsd < 0.01) {
    return SMALL_COST_FORMAT.format(costUsd);
  }

  return COST_FORMAT.format(costUsd);
}

function formatSpeed(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null || tokensPerSecond === undefined) {
    return "— tok/s";
  }

  return `${tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`;
}

function formatTtft(latencyMs: number | null): string {
  if (latencyMs === null || latencyMs === undefined) {
    return "—";
  }

  return latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${Math.round(latencyMs)}ms`;
}
