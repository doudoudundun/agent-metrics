import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureClaudeHooks, getDefaultClaudeSettingsPath } from "./settings.js";

export function registerEnsureCommand(hooks: Command): void {
  hooks
    .command("ensure")
    .description("Ensure agent-metrics Claude hooks exist in Claude settings.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option("--cli-path <path>", "Override the CLI path used by the generated Claude hooks.")
    .option("--settings-path <path>", "Claude settings JSON path.", getDefaultClaudeSettingsPath())
    .option("--scope <scope>", "Settings scope to install into.", "global")
    .action(async (options: { repoRoot: string; cliPath?: string; settingsPath: string; scope: string }) => {
      if (options.scope !== "global") {
        throw new Error(`Unsupported Claude settings scope: ${options.scope}`);
      }

      const result = await ensureClaudeHooks({
        repoRoot: options.repoRoot,
        cliPath: options.cliPath,
        settingsPath: resolve(options.settingsPath)
      });

      process.stdout.write(`Claude hooks ensure: ${result.status} ${result.settingsPath}\n`);
    });
}
