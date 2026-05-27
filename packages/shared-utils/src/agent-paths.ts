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
};

export function getAgentMetricsPaths(repoRoot: string): AgentMetricsPaths {
  return {
    rawHookLogPath: toContractPath(repoRoot, "data", "hooks", "raw", "claude-code.jsonl"),
    eventLogPath: toContractPath(repoRoot, "data", "events", "events.jsonl"),
    snapshotRoot: toContractPath(repoRoot, "data", "hooks", "snapshots"),
    parserStatePath: toContractPath(repoRoot, "data", "hooks", "state", "parser-state.json"),
    parserSeenPath: toContractPath(repoRoot, "data", "hooks", "state", "seen-raw-ids.json"),
    transcriptManifestPath: toContractPath(
      repoRoot,
      "data",
      "hooks",
      "state",
      "transcript-manifest.json"
    ),
    transcriptCursorPath: toContractPath(
      repoRoot,
      "data",
      "hooks",
      "state",
      "transcript-cursors.json"
    ),
    transcriptLedgerPath: toContractPath(
      repoRoot,
      "data",
      "hooks",
      "state",
      "transcript-ledger.json"
    )
  };
}

function toContractPath(...segments: string[]): string {
  return join(...segments).replaceAll("\\", "/");
}
