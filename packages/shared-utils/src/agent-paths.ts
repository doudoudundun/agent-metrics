import { join } from "node:path";

export type AgentMetricsPaths = {
  rawHookLogPath: string;
  eventLogPath: string;
  snapshotRoot: string;
  parserStatePath: string;
  parserSeenPath: string;
  transcriptManifestPath: string;
  transcriptCursorPath: string;
  transcriptLedgerPath: string;
  opencodeCursorPath: string;
  opencodeLedgerPath: string;
  codexCursorPath: string;
  codexLedgerPath: string;
};

export function getAgentMetricsPaths(repoRoot: string): AgentMetricsPaths {
  return {
    rawHookLogPath: buildAgentMetricsPath(repoRoot, "data", "hooks", "raw", "claude-code.jsonl"),
    eventLogPath: buildAgentMetricsPath(repoRoot, "data", "events", "events.jsonl"),
    snapshotRoot: buildAgentMetricsPath(repoRoot, "data", "hooks", "snapshots"),
    parserStatePath: buildAgentMetricsPath(repoRoot, "data", "hooks", "state", "parser-state.json"),
    parserSeenPath: buildAgentMetricsPath(repoRoot, "data", "hooks", "state", "seen-raw-ids.json"),
    transcriptManifestPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "hooks",
      "state",
      "transcript-manifest.json"
    ),
    transcriptCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "hooks",
      "state",
      "transcript-cursors.json"
    ),
    transcriptLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "hooks",
      "state",
      "transcript-ledger.json"
    ),
    opencodeCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "opencode-cursor.json"
    ),
    opencodeLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "opencode-ledger.json"
    ),
    codexCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "codex-cursor.json"
    ),
    codexLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "codex-ledger.json"
    )
  };
}

function buildAgentMetricsPath(repoRoot: string, ...segments: string[]): string {
  const path = join(repoRoot, ...segments);

  if (usesForwardSlashRoot(repoRoot)) {
    return path.replaceAll("\\", "/");
  }

  return path;
}

function usesForwardSlashRoot(repoRoot: string): boolean {
  return repoRoot.includes("/") && !repoRoot.includes("\\");
}
