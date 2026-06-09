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

type TokenUsageRow = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  source_vendor?: string;
};

function resolveDisplayedInputTokens(row: TokenUsageRow): number {
  const inputTokens = row.input_tokens;
  const cacheReadTokens = row.cache_read_input_tokens;

  if (row.source_vendor === "codex") {
    return Math.max(0, inputTokens - cacheReadTokens);
  }

  return inputTokens;
}

function resolveTotalTokens(row: TokenUsageRow): number {
  if (row.source_vendor === "codex") {
    return (
      row.input_tokens + row.output_tokens + row.cache_creation_input_tokens
    );
  }

  return (
    row.input_tokens +
    row.output_tokens +
    row.cache_read_input_tokens +
    row.cache_creation_input_tokens
  );
}

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

export function buildOverviewMetrics(input: {
  sessions: SessionRow[];
  toolEvents: ToolRow[];
  prompts: PromptRow[];
  responses: ResponseRow[];
  tokenUsage: TokenUsageRow[];
  codeEdits: CodeEditRow[];
}): OverviewMetrics {
  const successfulExecutions = input.toolEvents.filter((row) => row.status === "succeeded").length;
  const failedExecutions = input.toolEvents.filter((row) => row.status === "failed").length;
  const startedOnlyExecutions = input.toolEvents.filter((row) => row.status === "started").length;
  const totalToolCalls = successfulExecutions + failedExecutions;
  const editOperationCount = input.codeEdits.reduce((sum, row) => sum + row.edit_operation_count, 0);
  const turnCount = input.prompts.length;
  const responseCount = input.responses.length;
  const inputTokens = input.tokenUsage.reduce(
    (sum, row) => sum + resolveDisplayedInputTokens(row),
    0
  );
  const outputTokens = input.tokenUsage.reduce((sum, row) => sum + row.output_tokens, 0);
  const cacheReadTokens = input.tokenUsage.reduce(
    (sum, row) => sum + row.cache_read_input_tokens,
    0
  );
  const cacheCreationTokens = input.tokenUsage.reduce(
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
    totalTokens: input.tokenUsage.reduce((sum, row) => sum + resolveTotalTokens(row), 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    affectedFileCount,
    insertions,
    deletions
  };
}
