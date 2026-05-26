import { resolve } from "node:path";
import type { Command } from "commander";

export function registerParseCommand(hooks: Command): void {
  hooks
    .command("parse")
    .description("Parse raw Claude hook events into normalized agent-metrics events.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option("--follow", "Keep polling for new raw hook events.", false)
    .option("--poll-interval-ms <ms>", "Polling interval for follow mode.", "1000")
    .action(async (options: { repoRoot: string; follow?: boolean; pollIntervalMs: string }) => {
      await runParseCommand({
        repoRoot: resolve(options.repoRoot),
        follow: options.follow === true,
        pollIntervalMs: parsePositiveInteger(options.pollIntervalMs, 1000)
      });
    });
}

export async function runParseCommand(input: {
  repoRoot: string;
  follow: boolean;
  pollIntervalMs: number;
}): Promise<void> {
  void input;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
