import { resolve } from "node:path";
import type { Command } from "commander";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
] as const;

export type ClaudeHookEventName = (typeof CLAUDE_HOOK_EVENTS)[number];

export type ClaudeCommandHook = {
  type: "command";
  command: "node";
  args: string[];
};

export type ClaudeHookMatcher = {
  matcher: string;
  hooks: ClaudeCommandHook[];
};

export type ClaudeHooksConfig = Record<ClaudeHookEventName, ClaudeHookMatcher[]>;

export function buildClaudeHooksConfig(input: { repoRoot: string }): ClaudeHooksConfig {
  const repoRoot = toPortablePath(resolve(input.repoRoot));
  const cliPath = toPortablePath(resolve(repoRoot, "apps", "cli", "dist", "index.js"));

  return Object.fromEntries(
    CLAUDE_HOOK_EVENTS.map((eventName) => [
      eventName,
      [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: "node",
              args: [
                cliPath,
                "hooks",
                "collect",
                "--hook-event-name",
                eventName,
                "--repo-root",
                repoRoot
              ]
            }
          ]
        }
      ]
    ])
  ) as ClaudeHooksConfig;
}

export function buildClaudeHooksSettingsPatch(input: { repoRoot: string }): { hooks: ClaudeHooksConfig } {
  return {
    hooks: buildClaudeHooksConfig(input)
  };
}

export function registerPrintConfigCommand(hooks: Command): void {
  hooks
    .command("print-config")
    .description("Print the Claude hook settings patch JSON for manual review.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .action((options: { repoRoot: string }) => {
      process.stdout.write(
        `${JSON.stringify(buildClaudeHooksSettingsPatch({ repoRoot: options.repoRoot }), null, 2)}\n`
      );
    });
}

function toPortablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
