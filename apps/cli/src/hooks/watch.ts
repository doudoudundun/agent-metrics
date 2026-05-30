import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureClaudeHooks, getDefaultClaudeSettingsPath } from "./settings.js";

export function registerWatchCommand(hooks: Command): void {
  hooks
    .command("watch")
    .description("Watch Claude settings and restore missing agent-metrics hooks.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option("--settings-path <path>", "Claude settings JSON path.", getDefaultClaudeSettingsPath())
    .option("--scope <scope>", "Settings scope to install into.", "global")
    .action(async (options: { repoRoot: string; settingsPath: string; scope: string }) => {
      if (options.scope !== "global") {
        throw new Error(`Unsupported Claude settings scope: ${options.scope}`);
      }

      await watchClaudeSettings({
        repoRoot: options.repoRoot,
        settingsPath: options.settingsPath
      });
    });
}

export async function watchClaudeSettings(input: {
  repoRoot: string;
  settingsPath?: string;
  debounceMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<void> {
  const settingsPath = resolve(input.settingsPath ?? getDefaultClaudeSettingsPath());
  const debounceMs = input.debounceMs ?? 250;
  const log = input.log ?? ((message: string) => process.stdout.write(`${message}\n`));

  let inFlight = false;

  const runEnsure = async () => {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      const result = await ensureClaudeHooks({
        repoRoot: input.repoRoot,
        settingsPath
      });

      log(`hooks watch: ${result.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`hooks watch: error ${message}`);
    } finally {
      inFlight = false;
    }
  };

  if (input.signal?.aborted) {
    return;
  }

  while (!input.signal?.aborted) {
    await runEnsure();

    try {
      await delay(debounceMs, undefined, { signal: input.signal });
    } catch {
      break;
    }
  }
}
