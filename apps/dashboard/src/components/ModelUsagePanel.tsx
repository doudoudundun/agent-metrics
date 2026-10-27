import type { TokensByModelRow } from "../api";
import { SOURCE_LABELS } from "../source-labels";

type ModelUsagePanelProps = {
  rows: TokensByModelRow[];
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

type ModelUsageGroup = {
  sourceVendor: TokensByModelRow["sourceVendor"];
  /** Rows that made the visible cut, already ordered by tokens. */
  rows: TokensByModelRow[];
  /** Every model the agent ran in scope, so the header total stays honest. */
  modelCount: number;
  totalTokens: number;
  /** Agent-wide rate: the same definition as the per-model `hit`, aggregated. */
  cacheHitRate: number;
};

export function ModelUsagePanel({ rows }: ModelUsagePanelProps) {
  const visibleRows = [...rows]
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .slice(0, MODEL_USAGE_LIMIT);
  const groups = groupBySource(rows, visibleRows);

  return (
    <section className="panel model-usage-panel">
      <div className="panel-heading">
        <h2>Model Usage</h2>
        <span>{buildCountLabel(groups.length, visibleRows.length, rows.length)}</span>
      </div>
      {groups.length > 0 ? (
        <ol aria-label="Model usage rankings" className="model-usage-list">
          {groups.map((group) => {
            const label = SOURCE_LABELS[group.sourceVendor] ?? group.sourceVendor;

            return (
              <li className="model-usage-group" key={group.sourceVendor}>
                <div className="model-usage-group-head">
                  <strong>{label}</strong>
                  <span>
                    {group.modelCount} {group.modelCount === 1 ? "model" : "models"} ·{" "}
                    {NUMBER_FORMAT.format(group.totalTokens)} tokens
                  </span>
                  <span
                    className="model-usage-group-hit"
                    title="Cache read share of cacheable input across every model this agent ran"
                  >
                    hit {formatPercent(group.cacheHitRate)}
                  </span>
                </div>
                <ol aria-label={`${label} models`} className="model-usage-group-list">
                  {group.rows.map((row) => {
                    const cacheTokens = row.cacheReadTokens + row.cacheCreationTokens;
                    const tier = row.serviceTier ?? null;

                    return (
                      <li
                        className="model-usage-row"
                        key={`${row.sourceVendor}-${row.model}-${tier ?? "standard"}`}
                      >
                        <div className="model-usage-main">
                          <strong>{formatModelLabel(row.model)}</strong>
                          {tier !== null ? (
                            <span
                              className="model-usage-tier"
                              title={`Served at ${tier} speed: billed at ${formatMultiplier(
                                row.serviceTierMultiplier
                              )}x the model's standard rate`}
                            >
                              {tier} {formatMultiplier(row.serviceTierMultiplier)}x
                            </span>
                          ) : null}
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
                          <span
                            className="model-usage-hit"
                            title="Cache read share of cacheable input (input + cache read + cache write)"
                          >
                            hit {formatPercent(row.cacheHitRate)}
                          </span>
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

/**
 * Models are picked across all agents first (the same top-five cut as before),
 * then folded under the agent that ran them. A group therefore keeps its best
 * model's rank, and an agent's header numbers still cover its out-of-cut models.
 */
function groupBySource(
  rows: readonly TokensByModelRow[],
  visibleRows: readonly TokensByModelRow[]
): ModelUsageGroup[] {
  const totals = new Map<
    TokensByModelRow["sourceVendor"],
    { modelCount: number; totalTokens: number; cacheableInput: number; cacheReadTokens: number }
  >();

  for (const row of rows) {
    const current = totals.get(row.sourceVendor) ?? {
      modelCount: 0,
      totalTokens: 0,
      cacheableInput: 0,
      cacheReadTokens: 0
    };
    current.modelCount += 1;
    current.totalTokens += row.totalTokens;
    current.cacheableInput += row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    totals.set(row.sourceVendor, current);
  }

  const groups: ModelUsageGroup[] = [];
  const groupsBySource = new Map<TokensByModelRow["sourceVendor"], ModelUsageGroup>();

  for (const row of visibleRows) {
    let group = groupsBySource.get(row.sourceVendor);
    if (group === undefined) {
      const total = totals.get(row.sourceVendor);
      group = {
        sourceVendor: row.sourceVendor,
        rows: [],
        modelCount: total?.modelCount ?? 1,
        totalTokens: total?.totalTokens ?? row.totalTokens,
        cacheHitRate:
          total !== undefined && total.cacheableInput > 0
            ? total.cacheReadTokens / total.cacheableInput
            : 0
      };
      groupsBySource.set(row.sourceVendor, group);
      groups.push(group);
    }

    group.rows.push(row);
  }

  return groups;
}

function buildCountLabel(groupCount: number, visibleCount: number, totalCount: number): string {
  const agentLabel = `${groupCount} ${groupCount === 1 ? "agent" : "agents"}`;

  if (totalCount <= MODEL_USAGE_LIMIT) {
    return agentLabel;
  }

  return `${agentLabel} · top ${visibleCount} of ${totalCount} models`;
}

function formatModelLabel(model: string): string {
  if (model.trim().length === 0 || model.trim().toLowerCase() === "unknown") {
    return "Unknown model";
  }

  return model;
}

/**
 * Billing factor of a service tier. Absent multiplier means the row predates the
 * field (or is standard traffic), which is billed at 1x.
 */
function formatMultiplier(multiplier: number | undefined): string {
  if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier <= 0) {
    return "1";
  }

  return Number.isInteger(multiplier) ? String(multiplier) : String(Number(multiplier.toFixed(2)));
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

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
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
