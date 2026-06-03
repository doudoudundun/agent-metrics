import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureClaudeHooks, getDefaultClaudeSettingsPath, installClaudeHooks } from "./settings.js";

export function registerInstallCommand(hooks: Command): void {
  hooks
    .command("install")
    .description("Install agent-metrics Claude hooks into Claude settings.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option("--cli-path <path>", "Override the CLI path used by the generated Claude hooks.")
    .option("--settings-path <path>", "Claude settings JSON path.", getDefaultClaudeSettingsPath())
    .option("--scope <scope>", "Settings scope to install into.", "global")
    .action(async (options: { repoRoot: string; cliPath?: string; settingsPath: string; scope: string }) => {
      if (options.scope !== "global") {
        throw new Error(`Unsupported Claude settings scope: ${options.scope}`);
      }

      const settingsPath = resolve(options.settingsPath);

      const result = await ensureClaudeHooks({
        repoRoot: options.repoRoot,
        cliPath: options.cliPath,
        settingsPath
      });

      process.stdout.write(`Installed Claude hooks into ${settingsPath} (${result.status})\n`);
    });
}

export { getDefaultClaudeSettingsPath, installClaudeHooks } from "./settings.js";
