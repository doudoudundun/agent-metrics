export type OverviewMetrics = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnCount: number;
  responseCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  startedOnlyExecutions: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  totalCostUsd: number | null;
};

export type CardViewModel = {
  status: "loading" | "ready" | "unavailable" | "error";
  statusMessage: string;
  scopeLabel: string;
  alwaysOnTop: boolean;
  totalTokens: string;
  tokenMeta: string;
  cost: string;
  costMeta: string;
  toolCalls: string;
  toolMeta: string;
  edits: string;
  editMeta: string;
  successfulRuns: string;
  successfulMeta: string;
};

export const SCOPE_LABEL = "Today";
export const DEFAULT_SCOPE = {
  mode: "calendar",
  range: "day"
} as const;

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

export function formatCost(costUsd: number | null): string {
  if (costUsd === null) {
    return "—";
  }
  if (costUsd > 0 && costUsd < 0.01) {
    return SMALL_COST_FORMAT.format(costUsd);
  }
  return COST_FORMAT.format(costUsd);
}

export function resolveDisplayedToolCalls(overview: OverviewMetrics): number {
  const closedToolCalls = overview.successfulExecutions + overview.failedExecutions;
  if (overview.startedOnlyExecutions > 0) {
    return overview.totalToolCalls;
  }
  if (closedToolCalls > 0 && overview.totalToolCalls !== closedToolCalls) {
    return closedToolCalls;
  }
  return overview.totalToolCalls;
}

export function formatToolCallMeta(overview: OverviewMetrics): string {
  const startedOnlyExecutions = Math.max(0, overview.startedOnlyExecutions);
  const ok = NUMBER_FORMAT.format(overview.successfulExecutions);
  const failed = NUMBER_FORMAT.format(overview.failedExecutions);
  if (startedOnlyExecutions === 0) {
    return `${ok} ok / ${failed} failed`;
  }
  return `${ok} ok / ${failed} failed / ${NUMBER_FORMAT.format(startedOnlyExecutions)} started-only`;
}

export function emptyCardView(status: CardViewModel["status"], statusMessage: string, alwaysOnTop: boolean): CardViewModel {
  return {
    status,
    statusMessage,
    scopeLabel: SCOPE_LABEL,
    alwaysOnTop,
    totalTokens: "—",
    tokenMeta: statusMessage,
    cost: "—",
    costMeta: "",
    toolCalls: "—",
    toolMeta: "",
    edits: "—",
    editMeta: "",
    successfulRuns: "—",
    successfulMeta: ""
  };
}

export function toCardViewModel(overview: OverviewMetrics, alwaysOnTop: boolean): CardViewModel {
  const cacheTokens = overview.cacheReadTokens + overview.cacheCreationTokens;
  return {
    status: "ready",
    statusMessage: "",
    scopeLabel: SCOPE_LABEL,
    alwaysOnTop,
    totalTokens: NUMBER_FORMAT.format(overview.totalTokens),
    tokenMeta: `${NUMBER_FORMAT.format(overview.inputTokens)} in / ${NUMBER_FORMAT.format(overview.outputTokens)} out / ${NUMBER_FORMAT.format(cacheTokens)} cache`,
    cost: formatCost(overview.totalCostUsd),
    costMeta: `${NUMBER_FORMAT.format(overview.turnCount)} turns / ${NUMBER_FORMAT.format(overview.responseCount)} responses`,
    toolCalls: NUMBER_FORMAT.format(resolveDisplayedToolCalls(overview)),
    toolMeta: formatToolCallMeta(overview),
    edits: NUMBER_FORMAT.format(overview.editOperationCount),
    editMeta: `${NUMBER_FORMAT.format(overview.affectedFileCount)} files, +${NUMBER_FORMAT.format(overview.insertions)} / -${NUMBER_FORMAT.format(overview.deletions)}`,
    successfulRuns: NUMBER_FORMAT.format(overview.successfulExecutions),
    successfulMeta: "Completed without failures"
  };
}
