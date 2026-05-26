import { join } from "node:path";

export function getHookPaths(repoRoot: string): {
  rawHookLogPath: string;
  eventLogPath: string;
  snapshotRoot: string;
  parserStatePath: string;
  parserSeenPath: string;
} {
  return {
    rawHookLogPath: join(repoRoot, "data", "hooks", "raw", "claude-code.jsonl"),
    eventLogPath: join(repoRoot, "data", "events", "events.jsonl"),
    snapshotRoot: join(repoRoot, "data", "hooks", "snapshots"),
    parserStatePath: join(repoRoot, "data", "hooks", "state", "parser-state.json"),
    parserSeenPath: join(repoRoot, "data", "hooks", "state", "seen-raw-ids.json")
  };
}
