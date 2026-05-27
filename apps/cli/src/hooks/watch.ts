import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
  const settingsDir = dirname(settingsPath);
  const settingsName = basename(settingsPath);
  const debounceMs = input.debounceMs ?? 250;
  const log = input.log ?? ((message: string) => process.stdout.write(`${message}\n`));

  let timer: NodeJS.Timeout | null = null;
  let poller: NodeJS.Timeout | null = null;
  let lastSettledContents = await tryReadContents(settingsPath);
  let inFlight = false;

  const runEnsure = async () => {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      const currentContents = await tryReadContents(settingsPath);

      if (currentContents !== null && currentContents === lastSettledContents) {
        return;
      }

      const result = await ensureClaudeHooks({
        repoRoot: input.repoRoot,
        settingsPath
      });

      if (result.status !== "invalid-json") {
        lastSettledContents = await tryReadContents(settingsPath);
      }

      log(`hooks watch: ${result.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`hooks watch: error ${message}`);
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void runEnsure();
    }, debounceMs);
  };

  const pollForChanges = async () => {
    const currentContents = await tryReadContents(settingsPath);

    if (currentContents !== lastSettledContents) {
      schedule();
    }
  };

  if (input.signal?.aborted) {
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const watchers = [
      watch(settingsDir, { persistent: true }, (_eventType, filename) => {
        if (filename === null || filename === undefined || filename.toString() === settingsName) {
          schedule();
        }
      }),
      watch(settingsPath, { persistent: true }, () => {
        schedule();
      })
    ];

    for (const watcher of watchers) {
      watcher.on("error", reject);
    }

    poller = setInterval(() => {
      void pollForChanges();
    }, debounceMs);

    input.signal?.addEventListener(
      "abort",
      () => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        if (poller !== null) {
          clearInterval(poller);
        }

        for (const watcher of watchers) {
          watcher.close();
        }
        resolvePromise();
      },
      { once: true }
    );
  });
}

async function tryReadContents(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
