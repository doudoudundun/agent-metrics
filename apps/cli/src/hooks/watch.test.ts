import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ensureClaudeHooks } from "./settings.js";
import { watchClaudeSettings } from "./watch.js";

describe("watchClaudeSettings", () => {
  it("restores managed hooks after an external rewrite removes them", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-watch-"));
    const settingsPath = join(root, "settings.json");
    const controller = new AbortController();

    await ensureClaudeHooks({ repoRoot, settingsPath });

    const watchPromise = watchClaudeSettings({
      repoRoot,
      settingsPath,
      debounceMs: 50,
      signal: controller.signal,
      log: () => {}
    });

    await writeFile(settingsPath, JSON.stringify({ theme: "light" }, null, 2), "utf8");
    const repaired = await waitForHooks(settingsPath);

    expect(repaired.theme).toBe("light");
    expect(repaired.hooks?.PreToolUse).toBeDefined();

    controller.abort();
    await watchPromise;
  });

  it("does not duplicate managed hooks after repeated change events", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-repo-"));
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-watch-"));
    const settingsPath = join(root, "settings.json");
    const controller = new AbortController();

    await ensureClaudeHooks({ repoRoot, settingsPath });

    const watchPromise = watchClaudeSettings({
      repoRoot,
      settingsPath,
      debounceMs: 50,
      signal: controller.signal,
      log: () => {}
    });

    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }, null, 2), "utf8");
    const repaired = (await waitForHooks(settingsPath)) as {
      hooks: {
        PreToolUse: Array<{
          hooks: unknown[];
        }>;
      };
    };

    expect(repaired.hooks.PreToolUse).toHaveLength(1);
    expect(repaired.hooks.PreToolUse[0]?.hooks).toHaveLength(1);

    controller.abort();
    await watchPromise;
  });

  it("rewrites managed hooks to the current cli path and shared repo root", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-data-"));
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-watch-"));
    const settingsPath = join(root, "settings.json");
    const controller = new AbortController();
    const cliPath = "D:/projects/dev/agent-metrics/apps/cli/dist/index.js";

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
                      'node "C:/Users/test/AppData/Local/Programs/AgentMetrics/resources/runtime/cli/dist/index.js" hooks collect --hook-event-name "PreToolUse" --repo-root "C:/Users/test/AppData/Roaming/Agent Metrics/agent-metrics-data"'
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

    const watchPromise = watchClaudeSettings({
      repoRoot,
      cliPath,
      settingsPath,
      debounceMs: 50,
      signal: controller.signal,
      log: () => {}
    });

    const repaired = (await waitForHooksMatching(settingsPath, (settings) => {
      const hooks = settings.hooks?.PreToolUse;
      return (
        Array.isArray(hooks) &&
        hooks[0] !== undefined &&
        typeof hooks[0] === "object" &&
        hooks[0] !== null &&
        "hooks" in hooks[0] &&
        Array.isArray((hooks[0] as { hooks?: unknown[] }).hooks) &&
        typeof (hooks[0] as { hooks: Array<{ command?: string }> }).hooks[0]?.command === "string" &&
        (hooks[0] as { hooks: Array<{ command: string }> }).hooks[0].command.includes(cliPath)
      );
    })) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    };

    expect(repaired.hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              `node "${cliPath}" hooks collect --hook-event-name "PreToolUse" --repo-root "${repoRoot.replace(/\\/g, "/")}"`
          }
        ]
      }
    ]);

    controller.abort();
    await watchPromise;
  });
});

async function waitForHooks(settingsPath: string): Promise<{
  theme?: string;
  hooks?: Record<string, unknown>;
}> {
  return waitForHooksMatching(settingsPath, (settings) => settings.hooks?.PreToolUse !== undefined);
}

async function waitForHooksMatching(
  settingsPath: string,
  predicate: (settings: { theme?: string; hooks?: Record<string, unknown> }) => boolean
): Promise<{
  theme?: string;
  hooks?: Record<string, unknown>;
}> {
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const repaired = JSON.parse(await readFile(settingsPath, "utf8")) as {
      theme?: string;
      hooks?: Record<string, unknown>;
    };

    if (predicate(repaired)) {
      return repaired;
    }

    await delay(50);
  }

  return JSON.parse(await readFile(settingsPath, "utf8")) as {
    theme?: string;
    hooks?: Record<string, unknown>;
  };
}
