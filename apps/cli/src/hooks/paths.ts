import { join } from "node:path";

export function getHookPaths(repoRoot: string): {
  rawHookLogPath: string;
  eventLogPath: string;
  snapshotRoot: string;
} {
  return {
    rawHookLogPath: join(repoRoot, "data", "hooks", "raw", "claude-code.jsonl"),
    eventLogPath: join(repoRoot, "data", "events", "events.jsonl"),
    snapshotRoot: join(repoRoot, "data", "hooks", "snapshots")
  };
}
