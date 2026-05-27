type SessionRow = {
  session_id: string;
};

type ToolRow = {
  status: string;
  duration_ms: number | null;
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
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
};

export function buildOverviewMetrics(input: {
  sessions: SessionRow[];
  toolEvents: ToolRow[];
  codeEdits: CodeEditRow[];
}): OverviewMetrics {
  const successfulExecutions = input.toolEvents.filter((row) => row.status === "succeeded").length;
  const failedExecutions = input.toolEvents.filter((row) => row.status === "failed").length;
  const totalToolCalls = input.toolEvents.length;
  const editOperationCount = input.codeEdits.reduce((sum, row) => sum + row.edit_operation_count, 0);
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
    successRate: totalToolCalls === 0 ? 0 : successfulExecutions / totalToolCalls,
    editOperationCount,
    affectedFileCount,
    insertions,
    deletions
  };
}
