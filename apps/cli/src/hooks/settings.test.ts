import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureClaudeHooks } from "./settings.js";

describe("ensureClaudeHooks", () => {
  it("returns created when the settings file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const settingsPath = join(root, ".claude", "settings.json");

    const result = await ensureClaudeHooks({ repoRoot, settingsPath });

    expect(result.status).toBe("created");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).hooks.SessionStart).toBeDefined();
  });

  it("returns unchanged when managed hooks are already present", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const settingsPath = join(root, "settings.json");

    await ensureClaudeHooks({ repoRoot, settingsPath });

    const result = await ensureClaudeHooks({ repoRoot, settingsPath });

    expect(result.status).toBe("unchanged");
  });

  it("preserves foreign hooks while filling missing managed hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const settingsPath = join(root, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "node", args: ["existing-pretool.js"] }]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await ensureClaudeHooks({ repoRoot, settingsPath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      theme?: string;
      hooks: {
        PreToolUse: Array<{
          hooks: Array<{ args?: string[] }>;
        }>;
      };
    };

    expect(result.status).toBe("updated");
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.args).toEqual(["existing-pretool.js"]);
  });

  it("returns invalid-json and leaves the file untouched when parsing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const settingsPath = join(root, "settings.json");

    await writeFile(settingsPath, "{ invalid", "utf8");

    const result = await ensureClaudeHooks({ repoRoot, settingsPath });

    expect(result.status).toBe("invalid-json");
    expect(await readFile(settingsPath, "utf8")).toBe("{ invalid");
  });

  it("replaces duplicate managed hooks from different runtimes with the current one", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-data-"));
    const settingsPath = join(root, "settings.json");
    const portableRepoRoot = repoRoot.replace(/\\/g, "/");
    const packagedCliPath =
      "C:/Users/test/AppData/Local/Programs/AgentMetrics/resources/runtime/cli/dist/index.js";
    const devCliPath = "D:/projects/dev/agent-metrics/apps/cli/dist/index.js";

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command:
                      `node "${packagedCliPath}" hooks collect --hook-event-name "PreToolUse" --repo-root "${portableRepoRoot}"`
                  },
                  {
                    type: "command",
                    command: "node",
                    args: [
                      devCliPath,
                      "hooks",
                      "collect",
                      "--hook-event-name",
                      "PreToolUse",
                      "--repo-root",
                      portableRepoRoot
                    ]
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

    const result = await ensureClaudeHooks({
      repoRoot,
      cliPath: devCliPath,
      settingsPath
    });
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ command: string; args?: string[] }>;
        }>;
      };
    };

    expect(result.status).toBe("updated");
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              `node "${devCliPath}" hooks collect --hook-event-name "PreToolUse" --repo-root "${portableRepoRoot}"`
          }
        ]
      }
    ]);
  });

  it("rewrites malformed managed command strings that still point at the agent-metrics cli", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-data-"));
    const settingsPath = join(root, "settings.json");
    const portableRepoRoot = repoRoot.replace(/\\/g, "/");
    const devCliPath = "D:/projects/dev/agent-metrics/apps/cli/dist/index.js";

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command:
                      'node "D:/projects/dev/agent-metrics/apps//cli/dist//index.js" hooks collect --hook-event-name "PreToolUse" --repo-root "C:/Users/test/AppData/Roaming/Agent"'
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

    const result = await ensureClaudeHooks({
      repoRoot,
      cliPath: devCliPath,
      settingsPath
    });
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    };

    expect(result.status).toBe("updated");
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              `node "${devCliPath}" hooks collect --hook-event-name "PreToolUse" --repo-root "${portableRepoRoot}"`
          }
        ]
      }
    ]);
  });
});
