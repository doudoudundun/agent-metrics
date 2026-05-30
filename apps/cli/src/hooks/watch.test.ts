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
});

async function waitForHooks(settingsPath: string): Promise<{
  theme?: string;
  hooks?: Record<string, unknown>;
}> {
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const repaired = JSON.parse(await readFile(settingsPath, "utf8")) as {
      theme?: string;
      hooks?: Record<string, unknown>;
    };

    if (repaired.hooks?.PreToolUse !== undefined) {
      return repaired;
    }

    await delay(50);
  }

  return JSON.parse(await readFile(settingsPath, "utf8")) as {
    theme?: string;
    hooks?: Record<string, unknown>;
  };
}
