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
  zcodeCursorPath: string;
  zcodeLedgerPath: string;
  kimicodeCursorPath: string;
  kimicodeLedgerPath: string;
  dshCursorPath: string;
  dshLedgerPath: string;
  workbuddyCursorPath: string;
  workbuddyLedgerPath: string;
  cursorIdeStatePath: string;
  cursorIdeLedgerPath: string;
  codexCursorPath: string;
  codexLedgerPath: string;
  mimoCursorPath: string;
  mimoLedgerPath: string;
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
    zcodeCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "zcode-cursor.json"
    ),
    zcodeLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "zcode-ledger.json"
    ),
    kimicodeCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "kimicode-cursor.json"
    ),
    kimicodeLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "kimicode-ledger.json"
    ),
    dshCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "dsh-cursor.json"
    ),
    dshLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "dsh-ledger.json"
    ),
    workbuddyCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "workbuddy-cursor.json"
    ),
    workbuddyLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "workbuddy-ledger.json"
    ),
    cursorIdeStatePath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "cursor-ide-state.json"
    ),
    cursorIdeLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "cursor-ide-ledger.json"
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
    ),
    mimoCursorPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "mimo-cursor.json"
    ),
    mimoLedgerPath: buildAgentMetricsPath(
      repoRoot,
      "data",
      "sources",
      "state",
      "mimo-ledger.json"
    )
  };
}

function buildAgentMetricsPath(repoRoot: string, ...segments: string[]): string {
  const path = join(repoRoot, ...segments);

  if (usesForwardSlashRoot(repoRoot)) {
    return path.replaceAll("\\", "/");
  }

  if (usesBackslashRoot(repoRoot)) {
    return path.replaceAll("/", "\\");
  }

  return path;
}

function usesForwardSlashRoot(repoRoot: string): boolean {
  return repoRoot.includes("/") && !repoRoot.includes("\\");
}

function usesBackslashRoot(repoRoot: string): boolean {
  return repoRoot.includes("\\") && !repoRoot.includes("/");
}
