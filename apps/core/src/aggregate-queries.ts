import {
  estimateCostUsd,
  isAdditiveUsage,
  resolveDisplayedInputTokens,
  resolveTotalTokens
} from "@agent-metrics/metrics-engine";
import type { SourceVendor } from "@agent-metrics/event-schema";
import type { ToolExecutionCounts } from "@agent-metrics/metrics-engine";
import type { ResolvedTimeScope } from "./time-scope.js";
import type { MetricsDatabase, SourceVendorFilter } from "./core-types.js";
import { buildTimeWindow, parseFilesChanged } from "./query-support.js";
import { dropCursorGenerationShadowedByOfficial } from "./cursor-account-usage.js";
import { selectOverviewToolCounts, selectToolRankingRows } from "./tool-query-support.js";

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

export type TokenUsageOverviewRow = {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  source_vendor: SourceVendor;
  usage_source: string | null;
  created_at: string;
  provider_id: string | null;
  provider_host: string | null;
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
  sessionId: string;
  eventId: string;
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
  const promptWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const responseWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const tokenUsageWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const codeEditWindow = buildTimeWindow("created_at", scope, sourceVendor);
  const sessions = db
    .prepare<SessionOverviewRow>(`SELECT session_id FROM sessions${sessionWindow.whereSql}`)
    .all(...sessionWindow.params);
  const toolCounts = selectOverviewToolCounts(db, scope, sourceVendor);
  const prompts = db
    .prepare<PromptOverviewRow>(`SELECT prompt_id FROM prompt_events${promptWindow.whereSql}`)
    .all(...promptWindow.params);
  const responses = db
    .prepare<AssistantResponseOverviewRow>(
      `SELECT message_id FROM assistant_responses${responseWindow.whereSql}`
    )
    .all(...responseWindow.params);
  const tokenUsage = dropCursorGenerationShadowedByOfficial(
    db
      .prepare<TokenUsageOverviewRow>(
        `SELECT model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_vendor, usage_source, created_at, provider_id, provider_host FROM token_usage_events${tokenUsageWindow.whereSql}`
      )
      .all(...tokenUsageWindow.params)
  );
  const codeEdits = db
    .prepare<{
      filesChanged: string;
      file_count: number;
      insertions: number;
      deletions: number;
      edit_operation_count: number;
    }>(
      `SELECT files_changed AS filesChanged, file_count, insertions, deletions, edit_operation_count FROM code_edits${codeEditWindow.whereSql}`
    )
    .all(...codeEditWindow.params)
    .map((row) => ({
      files_changed: parseFilesChanged(row.filesChanged),
      file_count: row.file_count,
      insertions: row.insertions,
      deletions: row.deletions,
      edit_operation_count: row.edit_operation_count
    }));

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

export function selectTokensByModel(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all",
  tokenUsageRows?: readonly TokenUsageOverviewRow[]
): TokensByModelRow[] {
  const window = buildTimeWindow("created_at", scope, sourceVendor);
  const rows = tokenUsageRows ?? dropCursorGenerationShadowedByOfficial(db
    .prepare<{
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      source_vendor: SourceVendor;
      usage_source: string | null;
      created_at: string;
    }>(
      `SELECT
        model,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        source_vendor,
        usage_source,
        created_at
      FROM token_usage_events
      ${window.whereSql}`
    )
    .all(...window.params));

  const grouped = new Map<string, TokensByModelRow>();
  for (const row of rows) {
    if (!isAdditiveUsage(row)) {
      continue;
    }

    const model = row.model ?? "unknown";
    const groupKey = `${row.source_vendor}\0${model}`;
    const current = grouped.get(groupKey) ?? {
      model,
      sourceVendor: row.source_vendor,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null
    };
    current.inputTokens += resolveDisplayedInputTokens(row);
    current.outputTokens += row.output_tokens;
    current.cacheReadTokens += row.cache_read_input_tokens;
    current.cacheCreationTokens += row.cache_creation_input_tokens;
    current.totalTokens += resolveTotalTokens(row);
    grouped.set(groupKey, current);
  }

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      costUsd: estimateCostUsd({
        model: row.model === "unknown" ? null : row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens
      })
    }))
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        left.model.localeCompare(right.model) ||
        left.sourceVendor.localeCompare(right.sourceVendor)
    );
}

export function selectToolRanking(
  db: MetricsDatabase,
  scope?: ResolvedTimeScope,
  sourceVendor: SourceVendorFilter = "all"
): ToolRankingRow[] {
  return normalizeToolRankingRows(selectToolRankingRows(db, scope, sourceVendor));
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
