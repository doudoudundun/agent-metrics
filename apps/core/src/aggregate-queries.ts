import type { SourceVendor, UsageMeasurement } from "@agent-metrics/event-schema";
import { estimateCostUsd, isAdditiveUsage } from "@agent-metrics/metrics-engine";
import type { ToolExecutionCounts } from "@agent-metrics/metrics-engine";
import type { ResolvedTimeScope } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import {
  andWhere,
  buildTimeWindow,
  buildToolActivityWindow,
  TOOL_CALLS_SESSION_JOIN
} from "./query-support.js";
import { dropCursorGenerationShadowedByOfficial } from "./cursor-account-usage.js";

type SessionOverviewRow = {
  session_id: string;
};

type CodeEditOverviewRow = {
  files_changed: string[];
  file_count: number;
  insertions: number;
  deletions: number;
  edit_operation_count: number;
};

type PromptOverviewRow = {
  prompt_id: string;
};

type AssistantResponseOverviewRow = {
  message_id: string;
};

/**
 * Additive usage row read from the canonical usage_events table.
 *
 * `input_tokens` carries `displayed_input_tokens`: the projection already applied
 * the vendor's gross/delta policy (spec section 9.6), so the aggregate layer must
 * not re-derive it. The row is therefore tagged "delta" — metrics-engine's
 * resolvers then add the value verbatim instead of subtracting cache reads a
 * second time.
 */
export type TokenUsageOverviewRow = {
  model: string | null;
  input_token_semantics: "delta";
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  source_vendor: SourceVendor;
  usage_measurement: UsageMeasurement;
  usage_source: string;
  created_at: string;
  provider_id: string | null;
  provider_host: string | null;
  decode_duration_ms: number | null;
  first_token_latency_ms: number | null;
};

type TokensByModelRow = {
  model: string;
  sourceVendor: SourceVendor;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  avgOutputTokensPerSecond: number | null;
  avgFirstTokenLatencyMs: number | null;
};

type ModelUsageAccumulator = {
  model: string;
  sourceVendor: SourceVendor;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  decodeMs: number;
  decodedOutputTokens: number;
  ttftSumMs: number;
  ttftCount: number;
};

type ToolRankingRow = {
  toolName: string;
  count: number;
  failures: number;
  averageDurationMs: number;
};

type RawToolRankingRow = {
  sourceVendor: SourceVendor;
  toolName: string;
  count: number;
  failures: number;
  totalDurationMs: number;
};

export function selectOverviewRows(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): {
  sessions: SessionOverviewRow[];
  toolEvents: [];
  toolCounts: ToolExecutionCounts;
  prompts: PromptOverviewRow[];
  responses: AssistantResponseOverviewRow[];
  tokenUsage: TokenUsageOverviewRow[];
  codeEdits: CodeEditOverviewRow[];
} {
  const sessionWindow = buildTimeWindow("started_at", scope, sourceVendor);
  const eventWindow = buildTimeWindow("timestamp", scope, sourceVendor);

  // Legacy sessions was keyed by session_id alone while domain_sessions adds the
  // source instance, so DISTINCT keeps the V1 counting semantics when the same
  // session id is observed by more than one source instance.
  const sessions = db
    .prepare<SessionOverviewRow>(`SELECT DISTINCT session_id FROM domain_sessions${sessionWindow.whereSql}`)
    .all(...sessionWindow.params);
  const toolCounts = selectOverviewToolCounts(db, scope, sourceVendor);
  // Only the row counts are consumed (turnCount / responseCount); the event id
  // stands in for the legacy prompt_id / message_id column of the row shape.
  const prompts = db
    .prepare<PromptOverviewRow>(
      `SELECT event_id AS prompt_id FROM normalized_events${andWhere(eventWindow, "event_type = 'prompt.submitted'")}`
    )
    .all(...eventWindow.params);
  const responses = db
    .prepare<AssistantResponseOverviewRow>(
      `SELECT event_id AS message_id FROM normalized_events${andWhere(eventWindow, "event_type = 'assistant.responded'")}`
    )
    .all(...eventWindow.params);
  const tokenUsage = selectTokenUsageRows(db, scope, sourceVendor);
  const codeEdits = db
    .prepare<{ payloadJson: string }>(
      `SELECT payload_json AS payloadJson FROM normalized_events${andWhere(eventWindow, "event_type = 'code.edit.applied'")}`
    )
    .all(...eventWindow.params)
    .map((row) => readCodeEditPayload(row.payloadJson));

  return {
    sessions,
    toolEvents: [],
    toolCounts,
    prompts,
    responses,
    tokenUsage,
    codeEdits
  };
}

/**
 * Additive usage rows for the window, shared by every token aggregate.
 *
 * Session-context snapshots restate a whole session context instead of an
 * increment and must never enter totals (spec sections 9.5 and 9.6), so
 * `usage_measurement = 'increment'` filters the window. Rows are ordered by
 * occurrence so callers that bucket by time (token trend) see a stable sequence.
 */
export function selectTokenUsageRows(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): TokenUsageOverviewRow[] {
  const window = buildTimeWindow("occurred_at", scope, sourceVendor);
  const rows = db
    .prepare<TokenUsageOverviewRow>(
      `SELECT
        model_id AS model,
        -- Displayed input tokens are stored already normalized by the vendor's
        -- semantics; the "delta" tag keeps metrics-engine from subtracting
        -- cache reads again (see TokenUsageOverviewRow).
        'delta' AS input_token_semantics,
        displayed_input_tokens AS input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        source_vendor,
        usage_measurement,
        usage_source,
        occurred_at AS created_at,
        provider_id,
        provider_host,
        decode_duration_ms,
        first_token_latency_ms
      FROM usage_events${andWhere(window, "usage_measurement = 'increment'")}
      ORDER BY occurred_at ASC, event_id ASC`
    )
    .all(...window.params);

  return dropCursorGenerationShadowedByOfficial(rows);
}

export function selectTokensByModel(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  tokenUsageRows?: readonly TokenUsageOverviewRow[]
): TokensByModelRow[] {
  const rows = tokenUsageRows ?? selectTokenUsageRows(db, scope, sourceVendor);
  const grouped = new Map<string, ModelUsageAccumulator>();

  for (const row of rows) {
    // The window query already excludes snapshots; rows handed in by callers are
    // re-checked so a caller cannot smuggle a snapshot into an additive total.
    if (!isAdditiveUsage(row)) {
      continue;
    }

    const model = row.model ?? "unknown";
    const groupKey = `${row.source_vendor}\0${model}`;
    const current = grouped.get(groupKey) ?? {
      model,
      sourceVendor: row.source_vendor,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      decodeMs: 0,
      decodedOutputTokens: 0,
      ttftSumMs: 0,
      ttftCount: 0
    };

    current.inputTokens += row.input_tokens;
    current.outputTokens += row.output_tokens;
    current.cacheReadTokens += row.cache_read_input_tokens;
    current.cacheCreationTokens += row.cache_creation_input_tokens;
    current.totalTokens +=
      row.input_tokens +
      row.output_tokens +
      row.cache_read_input_tokens +
      row.cache_creation_input_tokens;
    // Output tokens per second is a duration-weighted aggregate (total output /
    // total decode time), not an average of per-request rates. Rows without a
    // positive decode duration or without TTFT stay out of that statistic.
    if (row.decode_duration_ms !== null && row.decode_duration_ms > 0) {
      current.decodeMs += row.decode_duration_ms;
      current.decodedOutputTokens += row.output_tokens;
    }
    if (row.first_token_latency_ms !== null) {
      current.ttftSumMs += row.first_token_latency_ms;
      current.ttftCount += 1;
    }
    grouped.set(groupKey, current);
  }

  return [...grouped.values()]
    .map((current) => ({
      model: current.model,
      sourceVendor: current.sourceVendor,
      totalTokens: current.totalTokens,
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheReadTokens: current.cacheReadTokens,
      cacheCreationTokens: current.cacheCreationTokens,
      costUsd: estimateCostUsd({
        model: current.model === "unknown" ? null : current.model,
        inputTokens: current.inputTokens,
        outputTokens: current.outputTokens,
        cacheReadTokens: current.cacheReadTokens,
        cacheCreationTokens: current.cacheCreationTokens
      }),
      avgOutputTokensPerSecond:
        current.decodeMs > 0 ? (current.decodedOutputTokens * 1000) / current.decodeMs : null,
      avgFirstTokenLatencyMs: current.ttftCount > 0 ? current.ttftSumMs / current.ttftCount : null
    }))
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        left.model.localeCompare(right.model) ||
        left.sourceVendor.localeCompare(right.sourceVendor)
    );
}

export function selectOverviewToolCounts(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ToolExecutionCounts {
  const window = buildToolActivityWindow(scope, sourceVendor);
  const rows = db
    .prepare<{ status: string; count: number }>(
      `SELECT tool_calls.status AS status, COUNT(*) AS count
      ${TOOL_CALLS_SESSION_JOIN}
      ${window.whereSql}
      GROUP BY tool_calls.status`
    )
    .all(...window.params);

  const counts: ToolExecutionCounts = {
    successfulExecutions: 0,
    failedExecutions: 0,
    startedOnlyExecutions: 0
  };
  for (const row of rows) {
    if (row.status === "succeeded") counts.successfulExecutions += row.count;
    else if (row.status === "failed") counts.failedExecutions += row.count;
    else if (row.status === "started") counts.startedOnlyExecutions += row.count;
  }
  return counts;
}

export function selectToolRanking(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ToolRankingRow[] {
  const window = buildToolActivityWindow(scope, sourceVendor);
  const rows = db
    .prepare<RawToolRankingRow>(
      `SELECT
        domain_sessions.source_vendor AS sourceVendor,
        tool_calls.tool_name AS toolName,
        COUNT(*) AS count,
        SUM(CASE WHEN tool_calls.status = 'failed' THEN 1 ELSE 0 END) AS failures,
        SUM(COALESCE(tool_calls.duration_ms, 0)) AS totalDurationMs
      ${TOOL_CALLS_SESSION_JOIN}
      ${window.whereSql}
      GROUP BY domain_sessions.source_vendor, tool_calls.tool_name`
    )
    .all(...window.params);

  return normalizeToolRankingRows(rows);
}

function normalizeToolRankingRows(rows: RawToolRankingRow[]): ToolRankingRow[] {
  const grouped = new Map<
    string,
    {
      count: number;
      failures: number;
      totalDurationMs: number;
    }
  >();

  for (const row of rows) {
    const toolName = normalizeToolRankingName(row.toolName, row.sourceVendor);
    if (toolName === null) {
      continue;
    }
    const current = grouped.get(toolName) ?? {
      count: 0,
      failures: 0,
      totalDurationMs: 0
    };

    current.count += row.count;
    current.failures += row.failures;
    current.totalDurationMs += row.totalDurationMs;
    grouped.set(toolName, current);
  }

  return Array.from(grouped.entries())
    .map(([toolName, value]) => ({
      toolName,
      count: value.count,
      failures: value.failures,
      averageDurationMs:
        value.count > 0 ? Math.round(value.totalDurationMs / value.count) : 0
    }))
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName));
}

/**
 * code.edit.applied carries its counters in payload_json; the overview needs the
 * same row shape the legacy edit rows exposed, including the per-file list that
 * affectedFileCount de-duplicates.
 */
function readCodeEditPayload(payloadJson: string): CodeEditOverviewRow {
  const payload = parsePayloadRecord(payloadJson);
  const filesChanged = payload?.files_changed;

  return {
    files_changed: Array.isArray(filesChanged)
      ? filesChanged.filter((entry): entry is string => typeof entry === "string")
      : [],
    file_count: readCount(payload?.file_count),
    insertions: readCount(payload?.insertions),
    deletions: readCount(payload?.deletions),
    edit_operation_count: readCount(payload?.edit_operation_count)
  };
}

function parsePayloadRecord(payloadJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeToolRankingName(toolName: string, sourceVendor: SourceVendor): string | null {
  if (sourceVendor === "cursor" && (toolName === "Composer" || toolName === "Composer Request")) {
    return "Composer Request";
  }

  if (OPENCODE_FAMILY_VENDORS.has(sourceVendor)) {
    return normalizeOpenCodeFamilyToolName(toolName);
  }

  if (sourceVendor !== "codex") {
    return toolName;
  }

  const normalized = normalizeCodexToolRankingToken(toolName);
  if (normalized === null) {
    return null;
  }

  if (normalized === "apply_patch") {
    return "Edit";
  }

  if (normalized === "websearch") {
    return "WebSearch";
  }

  if (["rg", "grep", "findstr", "select-string"].includes(normalized)) {
    return "Search";
  }

  if (["get-content", "cat", "type", "more", "less", "sed", "head", "tail", "nl", "bat"].includes(normalized)) {
    return "Read";
  }

  if (["get-childitem", "dir", "ls", "tree"].includes(normalized)) {
    return "List";
  }

  if (normalized === "git") {
    return "Git";
  }

  if (["corepack", "pnpm", "npm", "yarn", "bun"].includes(normalized)) {
    return "Build";
  }

  if (["invoke-restmethod", "invoke-webrequest", "curl", "wget"].includes(normalized)) {
    return "HTTP";
  }

  if (["get-process", "get-ciminstance", "get-nettcpconnection", "tasklist", "ps"].includes(normalized)) {
    return "Inspect";
  }

  if (["powershell", "bash", "cmd", "python", "node", "add-type", "start-sleep"].includes(normalized)) {
    return "Shell";
  }

  return "Shell";
}

/**
 * Vendors whose database uses the OpenCode schema. Their native tool ids are
 * lowercase, but MiMo Desktop also imports Claude Code sessions (TitleCase) into
 * the same table, so the same tool would otherwise occupy two ranking rows.
 */
const OPENCODE_FAMILY_VENDORS = new Set<SourceVendor>(["opencode", "zcode", "mimo"]);

/** Canonical labels for the OpenCode tool ids, shared across the family. */
const OPENCODE_FAMILY_TOOL_LABELS: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  task: "Task",
  skill: "Skill",
  question: "Question",
  agent: "Agent",
  powershell: "PowerShell",
  invalid: "Invalid"
};

function normalizeOpenCodeFamilyToolName(toolName: string): string {
  const key = toolName.trim().toLowerCase();
  // Unmapped ids keep their stored casing: MCP and task ids must not be rewritten.
  return OPENCODE_FAMILY_TOOL_LABELS[key] ?? toolName;
}

const IGNORED_CODEX_TOOL_RANKING_NAMES = new Set([
  "close_agent",
  "resume_agent",
  "send_input",
  "spawn_agent",
  "update_plan",
  "wait_agent"
]);

function normalizeCodexToolRankingToken(toolName: string): string | null {
  let cleaned = toolName.trim().toLowerCase();
  if (cleaned.length === 0) {
    return null;
  }

  cleaned = cleaned.replace(/^[&([{]+/u, "");
  cleaned = cleaned.replace(/^[`'"]+/u, "");
  cleaned = cleaned.replace(/[;|)\]}]+$/u, "");
  cleaned = cleaned.replace(/[`'"]+$/u, "");

  if (cleaned.length === 0 || cleaned.startsWith("$")) {
    return null;
  }

  if (IGNORED_CODEX_TOOL_RANKING_NAMES.has(cleaned)) {
    return null;
  }

  if (cleaned.includes(".ts") || cleaned.includes(".json") || cleaned.includes(".md") || cleaned.includes(".pid")) {
    return null;
  }

  return cleaned;
}