# Claude Settings Auto-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude hook registration self-healing for local users by automatically ensuring `agent-metrics` hooks on startup and restoring them while `agent-metrics` is running if `ccswitch` or another tool rewrites the Claude user settings file.

**Architecture:** Extract the existing Claude settings merge logic into a reusable CLI-side settings module, then build two commands on top of it: `hooks ensure` for one-shot idempotent repair and `hooks watch` for runtime auto-heal. Finally, wire the startup PowerShell script to run `ensure`, keep the watcher alive beside the parser/API/dashboard, and update operator docs to reflect the new default path.

**Tech Stack:** TypeScript, Commander, Vitest, Node.js filesystem APIs, PowerShell

---

## File Structure

- Create: `apps/cli/src/hooks/settings.ts`
  - Shared settings read/merge/write/ensure logic and status reporting.
- Create: `apps/cli/src/hooks/settings.test.ts`
  - Unit coverage for ensure statuses, merge preservation, and invalid JSON handling.
- Create: `apps/cli/src/hooks/ensure.ts`
  - Commander registration for the one-shot ensure command.
- Create: `apps/cli/src/hooks/watch.ts`
  - Runtime watcher command and exported watch helper.
- Create: `apps/cli/src/hooks/watch.test.ts`
  - Integration-style tests for file rewrite healing and no-duplicate behavior.
- Modify: `apps/cli/src/hooks/install.ts`
  - Reuse shared settings ensure logic instead of owning merge code directly.
- Modify: `apps/cli/src/hooks/register.ts`
  - Register `ensure` and `watch`.
- Modify: `apps/cli/src/hooks/command.test.ts`
  - CLI coverage for `hooks ensure`.
- Modify: `apps/cli/src/index.test.ts`
  - Command registration expectations.
- Modify: `start-agent-metrics.ps1`
  - Run ensure before services and manage watcher PID/log lifecycle.
- Modify: `README.md`
  - Remove “one-time manual install” from the default path and document auto-heal behavior.

### Task 1: Extract Shared Claude Settings Ensure Logic

**Files:**
- Create: `apps/cli/src/hooks/settings.ts`
- Create: `apps/cli/src/hooks/settings.test.ts`
- Modify: `apps/cli/src/hooks/install.ts`

- [ ] **Step 1: Write the failing ensure tests**

Create `apps/cli/src/hooks/settings.test.ts` with focused coverage for the reusable engine:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "node", args: ["existing-pretool.js"] }]
            }
          ]
        }
      }, null, 2),
      "utf8"
    );

    const result = await ensureClaudeHooks({ repoRoot, settingsPath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(result.status).toBe("updated");
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PreToolUse[0].hooks[0].args).toEqual(["existing-pretool.js"]);
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
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run:

```powershell
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/settings.test.ts
```

Expected: FAIL because `./settings.js` and `ensureClaudeHooks` do not exist yet.

- [ ] **Step 3: Implement the reusable settings engine**

Create `apps/cli/src/hooks/settings.ts` with a shared ensure function and status type:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureParentDir } from "@agent-metrics/shared-utils";
import { buildClaudeHooksConfig, type ClaudeCommandHook, type ClaudeHookMatcher, type ClaudeHooksConfig } from "./sample-config.js";
import { getDefaultClaudeSettingsPath } from "./install.js";

type JsonObject = Record<string, unknown>;

export type EnsureClaudeHooksStatus = "created" | "updated" | "unchanged" | "invalid-json";

export type EnsureClaudeHooksResult = {
  status: EnsureClaudeHooksStatus;
  settingsPath: string;
};

export async function ensureClaudeHooks(input: {
  repoRoot: string;
  settingsPath?: string;
}): Promise<EnsureClaudeHooksResult> {
  const settingsPath = resolve(input.settingsPath ?? getDefaultClaudeSettingsPath());
  const existing = await readSettingsJson(settingsPath);

  if (existing.status === "invalid-json") {
    return { status: "invalid-json", settingsPath };
  }

  const nextSettings = {
    ...existing.value,
    hooks: mergeHookTrees(
      existing.value.hooks,
      buildClaudeHooksConfig({ repoRoot: resolve(input.repoRoot) })
    )
  };

  const before = existing.contents?.trim() ?? "";
  const after = JSON.stringify(nextSettings, null, 2);

  if (before === after) {
    return { status: "unchanged", settingsPath };
  }

  await ensureParentDir(settingsPath);
  await writeFile(settingsPath, `${after}\n`, "utf8");

  return {
    status: existing.contents === null ? "created" : "updated",
    settingsPath
  };
}
```

Keep the current merge helpers in this file, including managed hook identification by generated command shape. The existing “repoRoot changed” replacement behavior must continue to work.

- [ ] **Step 4: Repoint install to the shared engine**

Trim `apps/cli/src/hooks/install.ts` down so it registers the install command, resolves the settings path, calls `ensureClaudeHooks`, and prints the same success line as today:

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { ensureClaudeHooks } from "./settings.js";

export function getDefaultClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function registerInstallCommand(hooks: Command): void {
  hooks
    .command("install")
    .description("Install agent-metrics Claude hooks into Claude settings.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option("--settings-path <path>", "Claude settings JSON path.", getDefaultClaudeSettingsPath())
    .option("--scope <scope>", "Settings scope to install into.", "global")
    .action(async (options: { repoRoot: string; settingsPath: string; scope: string }) => {
      if (options.scope !== "global") {
        throw new Error(`Unsupported Claude settings scope: ${options.scope}`);
      }

      const result = await ensureClaudeHooks({
        repoRoot: options.repoRoot,
        settingsPath: resolve(options.settingsPath)
      });

      process.stdout.write(`Installed Claude hooks into ${result.settingsPath}\n`);
    });
}
```

- [ ] **Step 5: Run the targeted tests and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/settings.test.ts src/hooks/install.test.ts
```

Expected: PASS, including existing repo-root replacement behavior.

- [ ] **Step 6: Commit the shared settings task**

```powershell
git add apps/cli/src/hooks/settings.ts apps/cli/src/hooks/settings.test.ts apps/cli/src/hooks/install.ts
git commit -m "refactor(hooks): extract reusable Claude settings ensure logic"
```

### Task 2: Add the `hooks ensure` CLI Command

**Files:**
- Create: `apps/cli/src/hooks/ensure.ts`
- Modify: `apps/cli/src/hooks/register.ts`
- Modify: `apps/cli/src/hooks/command.test.ts`
- Modify: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Write failing CLI tests for `hooks ensure`**

Extend `apps/cli/src/hooks/command.test.ts` with one-shot ensure expectations:

```ts
it("runs hooks ensure through Commander and reports the first-write status", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-cli-"));
  const settingsRoot = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
  const settingsPath = join(settingsRoot, "settings.json");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  await buildProgram().parseAsync([
    "node",
    "agent-metrics",
    "hooks",
    "ensure",
    "--scope",
    "global",
    "--repo-root",
    repoRoot,
    "--settings-path",
    settingsPath
  ]);

  const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");

  expect(printed).toContain("created");
  expect(printed).toContain(settingsPath);
});

it("reports unchanged when managed hooks are already present", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-cli-"));
  const settingsRoot = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
  const settingsPath = join(settingsRoot, "settings.json");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  await buildProgram().parseAsync([
    "node", "agent-metrics", "hooks", "ensure",
    "--scope", "global",
    "--repo-root", repoRoot,
    "--settings-path", settingsPath
  ]);
  await buildProgram().parseAsync([
    "node", "agent-metrics", "hooks", "ensure",
    "--scope", "global",
    "--repo-root", repoRoot,
    "--settings-path", settingsPath
  ]);

  const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");

  expect(printed).toContain("unchanged");
});
```

Update `apps/cli/src/index.test.ts` to expect the new command name:

```ts
expect(hooks?.commands.map((command) => command.name())).toEqual(
  expect.arrayContaining(["collect", "ensure", "install", "print-config", "parse"])
);
```

- [ ] **Step 2: Run the targeted CLI tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/command.test.ts src/index.test.ts
```

Expected: FAIL because `hooks ensure` is not registered.

- [ ] **Step 3: Implement the command and register it**

Create `apps/cli/src/hooks/ensure.ts`:

```ts
import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureClaudeHooks } from "./settings.js";
import { getDefaultClaudeSettingsPath } from "./install.js";

export function registerEnsureCommand(hooks: Command): void {
  hooks
    .command("ensure")
    .description("Ensure agent-metrics Claude hooks exist in Claude settings.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option("--settings-path <path>", "Claude settings JSON path.", getDefaultClaudeSettingsPath())
    .option("--scope <scope>", "Settings scope to install into.", "global")
    .action(async (options: { repoRoot: string; settingsPath: string; scope: string }) => {
      if (options.scope !== "global") {
        throw new Error(`Unsupported Claude settings scope: ${options.scope}`);
      }

      const result = await ensureClaudeHooks({
        repoRoot: options.repoRoot,
        settingsPath: resolve(options.settingsPath)
      });

      process.stdout.write(`${result.status}: ${result.settingsPath}\n`);
    });
}
```

Register it in `apps/cli/src/hooks/register.ts` before `install`, so related settings commands stay grouped:

```ts
import { registerEnsureCommand } from "./ensure.js";
import { registerInstallCommand } from "./install.js";
import { registerWatchCommand } from "./watch.js";

registerCollectCommand(hooks);
registerEnsureCommand(hooks);
registerInstallCommand(hooks);
registerParseCommand(hooks);
registerPrintConfigCommand(hooks);
registerWatchCommand(hooks);
```

- [ ] **Step 4: Run the CLI tests again and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/command.test.ts src/index.test.ts
```

Expected: PASS with `created` on first ensure and `unchanged` on the second.

- [ ] **Step 5: Commit the CLI ensure task**

```powershell
git add apps/cli/src/hooks/ensure.ts apps/cli/src/hooks/register.ts apps/cli/src/hooks/command.test.ts apps/cli/src/index.test.ts
git commit -m "feat(cli): add one-shot Claude hooks ensure command"
```

### Task 3: Add the Runtime Settings Watcher

**Files:**
- Create: `apps/cli/src/hooks/watch.ts`
- Create: `apps/cli/src/hooks/watch.test.ts`
- Modify: `apps/cli/src/hooks/register.ts`
- Modify: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Write failing watcher tests**

Create `apps/cli/src/hooks/watch.test.ts` with an exported helper-focused integration test:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ensureClaudeHooks } from "./settings.js";
import { watchClaudeSettings } from "./watch.js";

describe("watchClaudeSettings", () => {
  afterEach(() => {
    // no-op placeholder for abort cleanup in each test body
  });

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
      signal: controller.signal
    });

    await writeFile(settingsPath, JSON.stringify({ theme: "light" }, null, 2), "utf8");
    await delay(300);

    const repaired = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(repaired.theme).toBe("light");
    expect(repaired.hooks.PreToolUse).toBeDefined();

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
      signal: controller.signal
    });

    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }, null, 2), "utf8");
    await delay(500);

    const repaired = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(repaired.hooks.PreToolUse).toHaveLength(1);
    expect(repaired.hooks.PreToolUse[0].hooks).toHaveLength(1);

    controller.abort();
    await watchPromise;
  });
});
```

Update `apps/cli/src/index.test.ts` to include `watch`:

```ts
expect(hooks?.commands.map((command) => command.name())).toEqual(
  expect.arrayContaining(["collect", "ensure", "install", "print-config", "parse", "watch"])
);
```

- [ ] **Step 2: Run the watcher tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/watch.test.ts src/index.test.ts
```

Expected: FAIL because `watch.ts` and the `watch` command do not exist yet.

- [ ] **Step 3: Implement the watcher with debounce and self-write suppression**

Create `apps/cli/src/hooks/watch.ts` around an exported helper plus Commander registration:

```ts
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Command } from "commander";
import { getDefaultClaudeSettingsPath } from "./install.js";
import { ensureClaudeHooks } from "./settings.js";

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
  const log = input.log ?? ((message) => process.stdout.write(`${message}\n`));

  let timer: NodeJS.Timeout | null = null;
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

      const result = await ensureClaudeHooks({ repoRoot: input.repoRoot, settingsPath });
      if (result.status !== "invalid-json") {
        lastSettledContents = await tryReadContents(settingsPath);
      }

      log(`hooks watch: ${result.status}`);
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

  await new Promise<void>((resolvePromise, reject) => {
    const watcher = watch(settingsDir, { persistent: true }, (_eventType, filename) => {
      if (filename && filename.toString() === settingsName) {
        schedule();
      }
    });

    watcher.on("error", reject);

    input.signal?.addEventListener("abort", () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      watcher.close();
      resolvePromise();
    }, { once: true });
  });
}

async function tryReadContents(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
```

Then register the long-running command:

```ts
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
```

- [ ] **Step 4: Run the watcher tests and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/watch.test.ts src/index.test.ts
```

Expected: PASS with repaired hooks and no duplicate managed entries.

- [ ] **Step 5: Commit the watcher task**

```powershell
git add apps/cli/src/hooks/watch.ts apps/cli/src/hooks/watch.test.ts apps/cli/src/hooks/register.ts apps/cli/src/index.test.ts
git commit -m "feat(hooks): add runtime Claude settings auto-heal watcher"
```

### Task 4: Wire Startup Orchestration and Docs

**Files:**
- Modify: `start-agent-metrics.ps1`
- Modify: `README.md`

- [ ] **Step 1: Add startup orchestration expectations as a manual verification checklist**

Before changing the script, note the exact behavior to implement:

```text
1. Ensure bootstrap/build still happens first.
2. Run `node dist/index.js hooks ensure --repo-root <repo>`.
3. Start `node dist/index.js hooks watch --repo-root <repo>` if not already running.
4. Keep parser/API/dashboard startup behavior unchanged.
5. Record watcher PID and logs in `.runtime`.
6. Do not require `.\install-claude-hooks.ps1` in the normal path anymore.
```

This task has no dedicated automated PowerShell test. Verification relies on the CLI tests above plus a startup smoke run at the end.

- [ ] **Step 2: Update the startup script to ensure hooks and manage watcher lifecycle**

Add new runtime paths near the other managed services in `start-agent-metrics.ps1`:

```powershell
$SettingsWatchOutLog = Join-Path $RuntimeDir "settings-watch.out.log"
$SettingsWatchErrLog = Join-Path $RuntimeDir "settings-watch.err.log"
$SettingsWatchPidPath = Join-Path $RuntimeDir "settings-watch.pid"
```

Add a one-shot ensure helper:

```powershell
function Ensure-ClaudeHooks() {
  Write-Step "Ensuring Claude hooks"
  Push-Location $CliWorkingDir
  try {
    & node "dist/index.js" "hooks" "ensure" "--scope" "global" "--repo-root" $RepoRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Claude hook ensure failed."
    }
  } finally {
    Pop-Location
  }
}
```

Add watcher process detection and startup helpers modeled after the parser:

```powershell
function Get-ManagedSettingsWatchPid() {
  if (-not (Test-Path $SettingsWatchPidPath)) {
    return $null
  }

  $rawPid = (Get-Content $SettingsWatchPidPath -Raw).Trim()
  if ($rawPid -notmatch '^\d+$') {
    Remove-Item $SettingsWatchPidPath -ErrorAction SilentlyContinue
    return $null
  }

  $managedPid = [int]$rawPid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

  if (
    $null -eq $process -or
    $process.Name -ne "node.exe" -or
    $process.CommandLine -notmatch "hooks\s+watch" -or
    $process.CommandLine -notlike "*$RepoRoot*"
  ) {
    Remove-Item $SettingsWatchPidPath -ErrorAction SilentlyContinue
    return $null
  }

  return $managedPid
}
```

Then insert the orchestration in order:

```powershell
Ensure-Bootstrap
Ensure-ClaudeHooks
Start-SettingsWatchIfNeeded
Start-ParserIfNeeded
Start-CoreIfNeeded
Start-DashboardIfNeeded
```

- [ ] **Step 3: Update README to make auto-heal the default path**

Rewrite the quick start and verification sections so the normal flow is:

```md
## Quick Start

```powershell
cd D:\projects\dev\agent-metrics
corepack pnpm install
.\start-agent-metrics.ps1
```

`start-agent-metrics.ps1` now:

- ensures Claude hooks in `~/.claude/settings.json`
- starts a runtime settings watcher that restores missing `agent-metrics` hooks
- starts the parser, API, and dashboard
```

Keep `.\install-claude-hooks.ps1` documented as a manual fallback, not the primary requirement.

- [ ] **Step 4: Run full verification and smoke the startup flow**

Run:

```powershell
corepack pnpm test
corepack pnpm build
corepack pnpm lint
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1 -NoBrowser
```

Expected:

- all tests pass
- build and lint pass
- startup script reports hook ensure, settings watcher, parser, API, and dashboard
- `.runtime\settings-watch.pid` exists
- `.runtime\settings-watch.out.log` or `.runtime\settings-watch.err.log` is created

Then do the manual hot-switch acceptance:

1. Open `~/.claude/settings.json` and confirm managed hooks are present.
2. While `agent-metrics` is running, trigger a `ccswitch` hot switch.
3. Confirm the watcher restores missing `agent-metrics` hooks automatically.
4. Confirm foreign hooks remain intact.

- [ ] **Step 5: Commit the orchestration and docs task**

```powershell
git add start-agent-metrics.ps1 README.md
git commit -m "feat(runtime): auto-heal Claude hooks during agent-metrics sessions"
```

## Self-Review

- Spec coverage:
  - startup ensure: Task 2 and Task 4
  - runtime watcher: Task 3 and Task 4
  - structural merge preservation: Task 1
  - `ccswitch` hot-switch repair: Task 3 and Task 4 manual acceptance
  - invalid JSON non-destructive behavior: Task 1
- Placeholder scan:
  - no `TODO` or `TBD` markers remain
  - each code-bearing step includes exact file targets and concrete code/commands
- Type consistency:
  - shared engine name: `ensureClaudeHooks`
  - watcher helper name: `watchClaudeSettings`
  - startup command names: `hooks ensure`, `hooks watch`
