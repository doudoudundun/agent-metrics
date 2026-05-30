import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getDefaultClaudeSettingsPath, installClaudeHooks } from "./install.js";

describe("getDefaultClaudeSettingsPath", () => {
  it("resolves the global Claude settings path from the current home directory", () => {
    expect(getDefaultClaudeSettingsPath()).toBe(join(homedir(), ".claude", "settings.json"));
  });
});

describe("installClaudeHooks", () => {
  it("creates a missing settings file and parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-install-"));
    const settingsPath = join(root, "nested", ".claude", "settings.json");
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));

    await installClaudeHooks({
      repoRoot,
      settingsPath
    });

    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };

    expect(installed.hooks?.SessionStart).toBeDefined();
    expect(installed.hooks?.PostToolUseFailure).toBeDefined();
  });

  it("merges agent-metrics hooks into an existing settings file idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-install-"));
    const settingsPath = join(root, "settings.json");
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const portableRepoRoot = repoRoot.replace(/\\/g, "/");

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            Notification: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: "node",
                    args: ["existing-notification.js"]
                  }
                ]
              }
            ],
            PreToolUse: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: "node",
                    args: ["existing-pretool.js"]
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await installClaudeHooks({
      repoRoot,
      settingsPath
    });

    await installClaudeHooks({
      repoRoot,
      settingsPath
    });

    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; args?: string[] }> }>>;
      theme?: string;
    };

    expect(installed.theme).toBe("dark");
    expect(installed.hooks?.Notification).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["existing-notification.js"]
          }
        ]
      }
    ]);
    expect(installed.hooks?.SessionStart).toBeDefined();
    expect(installed.hooks?.SessionEnd).toBeDefined();
    expect(installed.hooks?.PostToolUse).toBeDefined();
    expect(installed.hooks?.PostToolUseFailure).toBeDefined();
    expect(installed.hooks?.PreToolUse).toHaveLength(1);
    expect(installed.hooks?.PreToolUse?.[0]).toEqual({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: "node",
          args: ["existing-pretool.js"]
        },
        {
          type: "command",
          command:
            `node "${portableRepoRoot}/apps/cli/dist/index.js" hooks collect --hook-event-name "PreToolUse" --repo-root "${portableRepoRoot}"`
        }
      ]
    });
  });

  it("replaces a previously installed agent-metrics hook when repoRoot changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-install-"));
    const settingsPath = join(root, "settings.json");
    const firstRepoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-one-"));
    const secondRepoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-two-"));
    const portableSecondRepoRoot = secondRepoRoot.replace(/\\/g, "/");

    await installClaudeHooks({
      repoRoot: firstRepoRoot,
      settingsPath
    });

    await installClaudeHooks({
      repoRoot: secondRepoRoot,
      settingsPath
    });

    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ args?: string[] }> }>>;
    };

    expect(installed.hooks?.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              `node "${portableSecondRepoRoot}/apps/cli/dist/index.js" hooks collect --hook-event-name "PreToolUse" --repo-root "${portableSecondRepoRoot}"`
          }
        ]
      }
    ]);
  });
});
