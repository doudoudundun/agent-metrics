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
});
