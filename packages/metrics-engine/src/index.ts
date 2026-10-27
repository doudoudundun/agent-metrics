import { USAGE_SOURCE_SEMANTICS } from "@agent-metrics/event-schema";
import type { InputTokenSemantics, UsageMeasurement, UsageSource } from "@agent-metrics/event-schema";

type SessionRow = {
  session_id: string;
};

type ToolRow = {
  status: string;
  duration_ms: number | null;
};

type PromptRow = {
  prompt_id: string;
};

type ResponseRow = {
  message_id: string;
};

type CodeEditRow = {
  files_changed: string[];
  file_count: number;
  insertions: number;
  deletions: number;
  edit_operation_count: number;
};

export type OverviewMetrics = {
  sessionCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  startedOnlyExecutions: number;
  successRate: number;
  editOperationCount: number;
  turnCount: number;
  responseCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
};

export type ToolExecutionCounts = Pick<
  OverviewMetrics,
  "successfulExecutions" | "failedExecutions" | "startedOnlyExecutions"
>;

// ---------------------------------------------------------------------------
// Canonical token accounting (spec section 9.6)
// ---------------------------------------------------------------------------

/**
 * Normalized usage counters with explicit input semantics. The canonical form
 * every aggregate total is computed from. Spec section 9.6.
 */
export type NormalizedUsage = {
  inputTokenSemantics: InputTokenSemantics;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  usageMeasurement: UsageMeasurement;
};

/**
 * Thrown when a gross-semantic usage row has cache_read > input (invalid source
 * data). Spec section 9.5: such rows MUST be quarantined, not silently clamped.
 * Legacy-row defense (Math.max) is separate and emits a diagnostic counter.
 */
export class InvalidUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageError";
  }
}

/**
 * Exhaustive registry mapping (source_adapter, usage_source) to token
 * semantics + measurement. Spec section 9.5 table. Adding a new source or
 * changing a mapping requires a schema revision + numbered migration.
 */
export const USAGE_SOURCE_REGISTRY = USAGE_SOURCE_SEMANTICS;

/**
 * Convert a legacy {@link TokenUsageRow} (vendor + usage_source, no explicit
 * semantics) into {@link NormalizedUsage} via the registry. Legacy rows carry
 * `source_vendor` and `usage_source`; V2 rows carry `input_token_semantics`
 * and `usage_measurement` directly. Spec section 9.5: unknown pairs remain in
 * raw storage and are excluded from normalized aggregates.
 */
export function toNormalizedUsage(row: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  usage_source?: UsageSource | string | null;
  input_token_semantics?: InputTokenSemantics | string | null;
  usage_measurement?: UsageMeasurement | string | null;
}): NormalizedUsage | null {
  // Prefer explicit V2 fields when present (forward-compat with migrated rows).
  const semantics = resolveSemantics(row);
  const measurement = resolveMeasurement(row);
  if (semantics === null || measurement === null) {
    return null;
  }

  return {
    inputTokenSemantics: semantics,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    usageMeasurement: measurement
  };
}

function resolveSemantics(row: {
  input_token_semantics?: InputTokenSemantics | string | null;
  usage_source?: UsageSource | string | null;
}): InputTokenSemantics | null {
  if (row.input_token_semantics === "delta" || row.input_token_semantics === "gross") {
    return row.input_token_semantics;
  }
  if (typeof row.usage_source === "string" && row.usage_source in USAGE_SOURCE_REGISTRY) {
    return USAGE_SOURCE_REGISTRY[row.usage_source as UsageSource].inputTokenSemantics;
  }
  return null;
}

function resolveMeasurement(row: {
  usage_measurement?: UsageMeasurement | string | null;
  usage_source?: UsageSource | string | null;
}): UsageMeasurement | null {
  if (
    row.usage_measurement === "increment" ||
    row.usage_measurement === "session-context-snapshot"
  ) {
    return row.usage_measurement;
  }
  if (typeof row.usage_source === "string" && row.usage_source in USAGE_SOURCE_REGISTRY) {
    return USAGE_SOURCE_REGISTRY[row.usage_source as UsageSource].usageMeasurement;
  }
  return null;
}

/**
 * Displayed input tokens per the canonical policy. Spec section 9.6.
 * - delta: input_tokens as-is
 * - gross: input_tokens - cache_read_input_tokens (throws if cache_read > input)
 *
 * The legacy {@link resolveDisplayedInputTokens} below applies defensive
 * Math.max clamping for legacy rows and MUST NOT be used for V2 rows.
 */
export function displayedInputTokens(usage: NormalizedUsage): number {
  if (usage.inputTokenSemantics === "delta") {
    return usage.inputTokens;
  }
  if (usage.cacheReadInputTokens > usage.inputTokens) {
    throw new InvalidUsageError("gross input is smaller than cache-read input");
  }
  return usage.inputTokens - usage.cacheReadInputTokens;
}

/**
 * Total tokens = displayed input + output + cache read + cache creation.
 * Spec section 9.6. Never double-counts cache read.
 */
export function totalTokens(usage: NormalizedUsage): number {
  return (
    displayedInputTokens(usage) +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}

// ---------------------------------------------------------------------------
// Legacy token accounting (vendor-keyed, kept for unmigrated rows)
// ---------------------------------------------------------------------------
// Spec section 9.6 forbids vendor-keyed token formulas after migration
// completion. Until Phase 2 backfills V2 semantics onto historical rows, this
// path remains the default for legacy `token_usage_events` rows that lack
// `input_token_semantics`. Once rows are backfilled, queries switch to the
// canonical `displayedInputTokens`/`totalTokens` functions and this code is
// removed.

/** Vendors whose legacy adapters record input_tokens as gross prompt size. */
const LEGACY_VENDORS_WITH_GROSS_INPUT_TOKENS = new Set(["codex", "opencode", "zcode", "mimo", "workbuddy"]);

export type TokenUsageRow = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  source_vendor?: string;
  usage_source?: string | null;
};

/**
 * Legacy displayed-input resolver. Defensive: clamps to 0 rather than throwing
 * (spec section 9.5 permits this ONLY for legacy rows, with a diagnostic).
 * Prefers the canonical path when the row already carries V2 semantics.
 */
export function resolveDisplayedInputTokens(row: TokenUsageRow): number {
  const normalized = toNormalizedUsage(row);
  if (normalized) {
    try {
      return displayedInputTokens(normalized);
    } catch {
      // Invalid gross row; fall through to legacy defensive clamp.
    }
  }
  const inputTokens = row.input_tokens;
  const cacheReadTokens = row.cache_read_input_tokens;
  if (row.source_vendor && LEGACY_VENDORS_WITH_GROSS_INPUT_TOKENS.has(row.source_vendor)) {
    return Math.max(0, inputTokens - cacheReadTokens);
  }
  return inputTokens;
}

/** Legacy total resolver; mirrors {@link resolveDisplayedInputTokens}. */
export function resolveTotalTokens(row: TokenUsageRow): number {
  return (
    resolveDisplayedInputTokens(row) +
    row.output_tokens +
    row.cache_read_input_tokens +
    row.cache_creation_input_tokens
  );
}

/**
 * True when the row is a session-context snapshot (e.g. cursor-composer-context)
 * and MUST be excluded from additive totals. Spec sections 9.5 and 9.6.
 */
export function isAdditiveUsage(row: { usage_measurement?: string | null; usage_source?: string | null }): boolean {
  if (row.usage_measurement === "session-context-snapshot") {
    return false;
  }
  if (row.usage_source === "cursor-composer-context") {
    return false;
  }
  return true;
}

export function buildOverviewMetrics(input: {
  sessions: SessionRow[];
  toolEvents: ToolRow[];
  /** Pre-aggregated logical calls, avoiding materializing the full tool history. */
  toolCounts?: ToolExecutionCounts;
  prompts: PromptRow[];
  responses: ResponseRow[];
  tokenUsage: TokenUsageRow[];
  codeEdits: CodeEditRow[];
}): OverviewMetrics {
  const successfulExecutions = input.toolCounts?.successfulExecutions ?? input.toolEvents.filter((row) => row.status === "succeeded").length;
  const failedExecutions = input.toolCounts?.failedExecutions ?? input.toolEvents.filter((row) => row.status === "failed").length;
  const startedOnlyExecutions = input.toolCounts?.startedOnlyExecutions ?? input.toolEvents.filter((row) => row.status === "started").length;
  const totalToolCalls = successfulExecutions + failedExecutions;
  const editOperationCount = input.codeEdits.reduce((sum, row) => sum + row.edit_operation_count, 0);
  const turnCount = input.prompts.length;
  const responseCount = input.responses.length;

  // Additive usage only: exclude session-context-snapshot rows from all totals.
  const additiveUsage = input.tokenUsage.filter(isAdditiveUsage);
  const inputTokens = additiveUsage.reduce(
    (sum, row) => sum + resolveDisplayedInputTokens(row),
    0
  );
  const outputTokens = additiveUsage.reduce((sum, row) => sum + row.output_tokens, 0);
  const cacheReadTokens = additiveUsage.reduce(
    (sum, row) => sum + row.cache_read_input_tokens,
    0
  );
  const cacheCreationTokens = additiveUsage.reduce(
    (sum, row) => sum + row.cache_creation_input_tokens,
    0
  );
  const dedupedFiles = new Set<string>();
  let fallbackAffectedFileCount = 0;

  for (const row of input.codeEdits) {
    if (row.files_changed.length > 0) {
      for (const filePath of row.files_changed) {
        dedupedFiles.add(filePath);
      }
      continue;
    }

    fallbackAffectedFileCount += row.file_count;
  }

  const affectedFileCount = dedupedFiles.size + fallbackAffectedFileCount;
  const insertions = input.codeEdits.reduce((sum, row) => sum + row.insertions, 0);
  const deletions = input.codeEdits.reduce((sum, row) => sum + row.deletions, 0);

  return {
    sessionCount: input.sessions.length,
    totalToolCalls,
    successfulExecutions,
    failedExecutions,
    startedOnlyExecutions,
    successRate: totalToolCalls === 0 ? 0 : successfulExecutions / totalToolCalls,
    editOperationCount,
    turnCount,
    responseCount,
    totalTokens: additiveUsage.reduce((sum, row) => sum + resolveTotalTokens(row), 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    affectedFileCount,
    insertions,
    deletions
  };
}

export {
  estimateCostUsd,
  MODEL_PRICING_USD,
  normalizeServiceTier,
  SERVICE_TIER_MULTIPLIERS,
  serviceTierMultiplier
} from "./pricing.js";
export type { ModelPricing } from "./pricing.js";
