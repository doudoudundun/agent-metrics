import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildClaudeHooksConfig, buildClaudeHooksSettingsPatch } from "./sample-config.js";

describe("buildClaudeHooksConfig", () => {
  it("builds command hooks for the phase-1 Claude hook events", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-config-"));
    const portableRepoRoot = repoRoot.replace(/\\/g, "/");
    const config = buildClaudeHooksConfig({ repoRoot });

    expect(Object.keys(config)).toEqual([
      "SessionStart",
      "SessionEnd",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure"
    ]);

    for (const eventName of Object.keys(config)) {
      expect(config[eventName]).toEqual([
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: "node",
              args: [
                `${portableRepoRoot}/apps/cli/dist/index.js`,
                "hooks",
                "collect",
                "--hook-event-name",
                eventName,
                "--repo-root",
                portableRepoRoot
              ]
            }
          ]
        }
      ]);
    }

    expect(buildClaudeHooksSettingsPatch({ repoRoot })).toEqual({
      hooks: config
    });
  });
});
