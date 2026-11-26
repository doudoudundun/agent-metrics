import { resolveUsageMode } from "@agent-metrics/event-schema";
import { useState } from "react";
import type { TokensByModelRow } from "../api";
import { SOURCE_LABELS } from "../source-labels";

type ModelUsagePanelProps = {
  rows: TokensByModelRow[];
};

type RowSourceVendor = TokensByModelRow["sourceVendor"];
type RowUsageMode = Exclude<TokensByModelRow["usageMode"], undefined>;

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
/** Agents are paged instead of truncated, so every agent stays reachable. */
const AGENTS_PER_PAGE = 5;

type ModelUsageGroup = {
  sourceVendor: RowSourceVendor;
  rows: TokensByModelRow[];
  modelCount: number;
  totalTokens: number;
  cacheableInput: number;
  cacheReadTokens: number;
};

export function ModelUsagePanel({ rows }: ModelUsagePanelProps) {
  const [page, setPage] = useState(0);
  const sortedRows = [...rows].sort((left, right) => right.totalTokens - left.totalTokens);
  const groups = groupBySource(sortedRows);
  const pageCount = Math.max(1, Math.ceil(groups.length / AGENTS_PER_PAGE));
  // The scope can change under an older page index, so clamp instead of resetting
  // from an effect and rendering one frame with nothing selected.
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * AGENTS_PER_PAGE;
  const pageGroups = groups.slice(pageStart, pageStart + AGENTS_PER_PAGE);

  return (
    <section className="panel model-usage-panel">
      <div className="panel-heading">
        <h2>Model Usage</h2>
        <span>{buildCountLabel(groups.length, currentPage, pageCount)}</span>
      </div>
      {pageGroups.length > 0 ? (
        <ol aria-label="Model usage rankings" className="model-usage-list">
          {pageGroups.map((group) => {
            const label = SOURCE_LABELS[group.sourceVendor] ?? group.sourceVendor;
            const cacheHitRate = group.cacheableInput > 0
              ? group.cacheReadTokens / group.cacheableInput
              : 0;

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
                    hit {formatPercent(cacheHitRate)}
                  </span>
                </div>
                <ol aria-label={`${label} models`} className="model-usage-group-list">
                  {group.rows.map((row) => {
                    const cacheTokens = row.cacheReadTokens + row.cacheCreationTokens;
                    const tier = row.serviceTier ?? null;
                    const usageMode = row.usageMode ?? resolveUsageMode(row.model, tier);

                    return (
                      <li
                        className="model-usage-row"
                        data-mode={usageMode}
                        key={`${row.sourceVendor}-${row.model}-${usageMode}-${tier ?? "standard"}`}
                      >
                        <div className="model-usage-main">
                          <strong>{formatModelUsageLabel(row.model, usageMode, tier)}</strong>
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
                            title={formatCostTooltip(row.costUsd, usageMode, tier)}
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
                          <span title={formatSpeedTooltip(row.sourceVendor)}>
                            {formatSpeed(
                              row.avgOutputTokensPerSecond,
                              row.speedSampleCount,
                              isEstimatedSpeed(row.sourceVendor)
                            )}
                          </span>
                          <span title={formatTtftTooltip(row.sourceVendor)}>
                            {formatTtft(
                              row.avgFirstTokenLatencyMs,
                              row.ttftSampleCount,
                              row.sourceVendor === "codex"
                            )}
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
      {pageCount > 1 ? (
        <div className="model-usage-pager">
          <button
            type="button"
            className="time-scope-button"
            aria-label="Previous agents"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Prev
          </button>
          <span aria-live="polite">
            {pageGroups.length === 1
              ? `Agent ${pageStart + 1} of ${groups.length}`
              : `Agents ${pageStart + 1}–${pageStart + pageGroups.length} of ${groups.length}`}
          </span>
          <button
            type="button"
            className="time-scope-button"
            aria-label="Next agents"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Group every row by agent; agent totals always cover all of that agent's models. */
function groupBySource(rows: readonly TokensByModelRow[]): ModelUsageGroup[] {
  const groups = new Map<RowSourceVendor, ModelUsageGroup>();
  for (const row of rows) {
    let group = groups.get(row.sourceVendor);
    if (group === undefined) {
      group = {
        sourceVendor: row.sourceVendor,
        rows: [],
        modelCount: 0,
        totalTokens: 0,
        cacheableInput: 0,
        cacheReadTokens: 0
      };
      groups.set(row.sourceVendor, group);
    }
    group.rows.push(row);
    group.modelCount += 1;
    group.totalTokens += row.totalTokens;
    group.cacheableInput += row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    group.cacheReadTokens += row.cacheReadTokens;
  }
  return [...groups.values()];
}

function buildCountLabel(agentCount: number, page: number, pageCount: number): string {
  const agentLabel = `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`;
  return pageCount > 1 ? `${agentLabel} · page ${page + 1}/${pageCount}` : agentLabel;
}

function formatModelUsageLabel(model: string, usageMode: RowUsageMode, tier: string | null): string {
  const modelLabel = formatModelLabel(model);

  // The tier badge already displays the same mode and its multiplier.
  if (tier?.toLowerCase() === usageMode) {
    return modelLabel;
  }
  if (usageMode === "fast") {
    return hasExplicitFastSuffix(modelLabel) ? modelLabel : `${modelLabel} (Fast)`;
  }
  if (usageMode === "ultrafast") {
    return hasExplicitUltrafastSuffix(modelLabel) ? modelLabel : `${modelLabel} (Ultrafast)`;
  }
  if (usageMode === "unknown") {
    return `${modelLabel} (mode unknown)`;
  }
  return modelLabel;
}

function hasExplicitFastSuffix(model: string): boolean {
  return /(?:fast|high[-_]?speed|ultra[-_]?speed)(?:\)|$)/i.test(model);
}

function hasExplicitUltrafastSuffix(model: string): boolean {
  return /(?:ultrafast|ultra[-_]?speed)(?:\)|$)/i.test(model);
}

function formatModelLabel(model: string): string {
  if (model.trim().length === 0 || model.trim().toLowerCase() === "unknown") {
    return "Unknown model";
  }
  return model;
}

/** An absent tier multiplier means standard traffic, billed at 1x. */
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

function formatCostTooltip(costUsd: number | null, usageMode: RowUsageMode, tier: string | null): string {
  if (costUsd === null) {
    return "No reference estimate is available. Reference estimates use published model and speed rates; subscription credits, long-context and regional modifiers are excluded.";
  }
  if (usageMode === "unknown" && tier === null) {
    return "Usage mode is unknown; this estimate uses the standard model reference rate because no speed-tier evidence is available. Fast/Ultrafast pricing is not inferred; subscription credits, long-context and regional modifiers are excluded.";
  }
  return "Reference estimate at published model and speed rates; excludes subscription credits, long-context and regional modifiers.";
}

function formatSpeedTooltip(sourceVendor: RowSourceVendor): string {
  if (sourceVendor === "codex") {
    return "Estimated Codex output speed from usage-report intervals, excluding known tool overlaps. Request and network overhead may remain. Sample count is usage rows with a valid interval, not requests.";
  }
  if (sourceVendor === "workbuddy") {
    return "WorkBuddy output speed uses matched provider timing when available, and otherwise a step wall-clock estimate that includes request overhead. The aggregate may combine both. Sample count is usage rows with a duration, not requests.";
  }
  return "Output tokens divided by summed decode durations (duration-weighted). Sample count is usage rows with a positive decode duration, not requests.";
}

/** Sources that estimate speed from wall-clock records rather than provider timing. */
function isEstimatedSpeed(sourceVendor: RowSourceVendor): boolean {
  return sourceVendor === "codex" || sourceVendor === "workbuddy";
}

function formatTtftTooltip(sourceVendor: RowSourceVendor): string {
  if (sourceVendor === "codex") {
    return "For Codex, TTFT is an upper bound measured to the first usage report, not the exact first token time. Sample count is usage rows, not requests.";
  }
  return "Average time to first token as reported by the source. Sample count is usage rows, not requests.";
}

function formatSpeed(
  tokensPerSecond: number | null,
  sampleCount: number | undefined,
  isEstimate: boolean
): string {
  if (tokensPerSecond === null || tokensPerSecond === undefined) {
    return `— tok/s${isEstimate ? " est." : ""}${formatSampleCount(sampleCount)}`;
  }
  const estimate = isEstimate ? " est." : "";
  const formattedSpeed =
    tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1);
  return `${formattedSpeed} tok/s${estimate}${formatSampleCount(sampleCount)}`;
}

function formatTtft(
  latencyMs: number | null,
  sampleCount: number | undefined,
  isCodex: boolean
): string {
  if (latencyMs === null || latencyMs === undefined) {
    return `TTFT —${formatSampleCount(sampleCount)}`;
  }
  const value =
    latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${Math.round(latencyMs)}ms`;
  return `TTFT ${isCodex ? "≤ " : ""}${value}${formatSampleCount(sampleCount)}`;
}

function formatSampleCount(sampleCount: number | undefined): string {
  if (sampleCount === undefined) {
    return "";
  }
  return ` · ${NUMBER_FORMAT.format(sampleCount)} sample${sampleCount === 1 ? "" : "s"}`;
}
