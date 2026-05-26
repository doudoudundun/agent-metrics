# Claude Hooks Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace wrapper-first collection with Claude Code official hooks, write raw + normalized local data, install hooks globally, and make the dashboard show real internal tool names for user verification.

**Architecture:** Reuse `apps/core` and `apps/dashboard` as the presentation layer, and repurpose `apps/cli` into the hook-facing utility. Claude hooks call a local collector command that writes raw JSONL and normalized event JSONL. For mutating tools, the collector keeps targeted before/after snapshots keyed by `tool_use_id` so phase 1 can preserve code-edit metrics without broad workspace scans.

**Tech Stack:** Node.js, TypeScript, Commander, Fastify, React, Vite, Vitest, better-sqlite3, PowerShell.

---

## Scope Boundary

This plan only implements **phase 1** from the approved design:

- hooks collector
- raw payload storage
- normalized event storage
- global installer
- hook-first dashboard

This plan explicitly does **not** implement phase 2 bus decomposition. Phase 2 gets a separate plan **after** the user tests and accepts phase 1.

## File Map

### Create

- `apps/cli/src/hooks/register.ts`
  Registers the `hooks` command tree under the CLI.
- `apps/cli/src/hooks/collect.ts`
  Entry point for Claude hooks payload ingestion.
- `apps/cli/src/hooks/collect.test.ts`
  Integration-style tests for raw + normalized writes and edit snapshots.
- `apps/cli/src/hooks/install.ts`
  Global Claude settings installer and idempotent merge logic.
- `apps/cli/src/hooks/install.test.ts`
  Tests for settings merge and generated command payloads.
- `apps/cli/src/hooks/sample-config.ts`
  Shared generator for hook config fragments.
- `apps/cli/src/hooks/paths.ts`
  Resolves repo-local raw/event/state paths and Claude global settings paths.
- `apps/cli/src/hooks/snapshots.ts`
  Reads/writes per-tool snapshot state for mutating tools.
- `packages/adapters-claude/src/hooks.ts`
  Claude hook payload parser, normalizer, and mutating-tool target extractor.
- `packages/adapters-claude/src/hooks.test.ts`
  Tests for hook payload parsing and normalized event mapping.
- `apps/dashboard/src/components/SessionTimelinePanel.tsx`
  Session timeline inspector for verifying real tool events.
- `docs/manual/claude-hooks-global.sample.json`
  Human-readable manual Claude settings example.
- `install-claude-hooks.ps1`
  One-click Windows installer for global Claude hooks.

### Modify

- `apps/cli/package.json`
  Update tests/build expectations for the new hook-focused CLI.
- `apps/cli/src/index.ts`
  Replace wrapper-first command registration with hook-first command registration.
- `apps/cli/src/index.test.ts`
  Replace wrapper command assertions with hook command assertions.
- `packages/adapters-claude/src/index.ts`
  Export hook parsing helpers.
- `packages/metrics-engine/src/index.ts`
  Remove token metrics from overview output.
- `packages/metrics-engine/src/index.test.ts`
  Update overview expectations.
- `apps/core/src/app.ts`
  Ingest hook-backed normalized events, drop token dependency, add session end fields, return a usable session timeline.
- `apps/core/src/app.test.ts`
  Update core ingestion and timeline tests for hook-first flows.
- `apps/dashboard/src/api.ts`
  Remove token field and add session-detail fetch types.
- `apps/dashboard/src/App.tsx`
  Load selected session detail and remove token copy.
- `apps/dashboard/src/App.test.tsx`
  Update mocked API contract and timeline rendering assertions.
- `apps/dashboard/src/components/KpiGrid.tsx`
  Remove the token KPI card.
- `apps/dashboard/src/components/RecentSessionsTable.tsx`
  Add row selection for timeline inspection.
- `apps/dashboard/src/styles.css`
  Style the selected session and timeline panel.
- `README.md`
  Rewrite setup and verification flow to be hooks-first.
- `start-agent-metrics.ps1`
  Print the next-step hint for hooks installation after startup.

---

### Task 1: Replace the CLI Surface With Hooks Commands

**Files:**
- Create: `apps/cli/src/hooks/register.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/cli/package.json`
- Test: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Write the failing CLI command registration test**

```ts
import { describe, expect, it } from "vitest";
import { buildProgram } from "./index.js";

describe("buildProgram", () => {
  it("registers hooks commands and drops the wrapper entrypoint", () => {
    const program = buildProgram();
    const topLevel = program.commands.map((command) => command.name());
    const hooks = program.commands.find((command) => command.name() === "hooks");

    expect(topLevel).toContain("hooks");
    expect(topLevel).not.toContain("wrap");
    expect(hooks?.commands.map((command) => command.name())).toEqual([
      "collect",
      "install",
      "print-config"
    ]);
  });
});
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/index.test.ts
```

Expected: FAIL because `buildProgram` is not exported and the current CLI still exposes `wrap`.

- [ ] **Step 3: Write the minimal hook-first CLI shell**

```ts
import { Command } from "commander";
import { registerHooksCommands } from "./hooks/register.js";

export function buildProgram(): Command {
  const program = new Command().name("agent-metrics");

  registerHooksCommands(program);

  return program;
}

if (process.argv[1]) {
  const program = buildProgram();
  void program.parseAsync(process.argv);
}
```

```ts
import type { Command } from "commander";
import { registerCollectCommand } from "./collect.js";
import { registerInstallCommand } from "./install.js";
import { registerPrintConfigCommand } from "./sample-config.js";

export function registerHooksCommands(program: Command): void {
  const hooks = program.command("hooks");

  registerCollectCommand(hooks);
  registerInstallCommand(hooks);
  registerPrintConfigCommand(hooks);
}
```

```json
{
  "scripts": {
    "test": "vitest run src/**/*.test.ts"
  }
}
```

- [ ] **Step 4: Run the CLI test to verify it passes**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/index.test.ts
```

Expected: PASS with one green suite asserting `hooks collect`, `hooks install`, and `hooks print-config`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/package.json apps/cli/src/index.ts apps/cli/src/index.test.ts apps/cli/src/hooks/register.ts
git commit -m "refactor: replace wrapper CLI with hooks commands"
```

### Task 2: Implement Claude Hook Parsing, Raw Writes, and Snapshot-Backed Edit Metrics

**Files:**
- Create: `packages/adapters-claude/src/hooks.ts`
- Create: `packages/adapters-claude/src/hooks.test.ts`
- Modify: `packages/adapters-claude/src/index.ts`
- Create: `apps/cli/src/hooks/collect.ts`
- Create: `apps/cli/src/hooks/collect.test.ts`
- Create: `apps/cli/src/hooks/paths.ts`
- Create: `apps/cli/src/hooks/snapshots.ts`
- Test: `packages/adapters-claude/src/hooks.test.ts`
- Test: `apps/cli/src/hooks/collect.test.ts`

- [ ] **Step 1: Write the failing hook adapter tests**

```ts
import { describe, expect, it } from "vitest";
import { extractMutationTargets, normalizeClaudeHookPayload } from "./hooks.js";

describe("normalizeClaudeHookPayload", () => {
  it("maps PreToolUse into tool.called", () => {
    const event = normalizeClaudeHookPayload({
      hookEventName: "PreToolUse",
      payload: {
        session_id: "ses_1",
        cwd: "D:/tmp/workspace",
        transcript_path: "C:/Users/me/.claude/projects/demo/session.jsonl",
        tool_name: "Read",
        tool_input: { file_path: "README.md" },
        tool_use_id: "toolu_1"
      }
    });

    expect(event?.type).toBe("tool.called");
  });

  it("maps PostToolUseFailure into tool.failed", () => {
    const event = normalizeClaudeHookPayload({
      hookEventName: "PostToolUseFailure",
      payload: {
        session_id: "ses_1",
        cwd: "D:/tmp/workspace",
        transcript_path: "session.jsonl",
        tool_name: "Bash",
        tool_use_id: "toolu_2",
        duration_ms: 19
      }
    });

    expect(event?.type).toBe("tool.failed");
  });
});

describe("extractMutationTargets", () => {
  it("extracts the edited file path for Edit", () => {
    expect(
      extractMutationTargets({
        toolName: "Edit",
        toolInput: { file_path: "src/app.ts", old_string: "a", new_string: "b" }
      })
    ).toEqual(["src/app.ts"]);
  });
});
```

- [ ] **Step 2: Run the adapter tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-claude exec vitest run src/hooks.test.ts
```

Expected: FAIL because `hooks.ts` does not exist yet.

- [ ] **Step 3: Implement the hook adapter**

```ts
import type { AnyEvent } from "@agent-metrics/event-schema";

type HookEnvelope = {
  hookEventName: string;
  payload: Record<string, unknown>;
};

export function normalizeClaudeHookPayload(input: HookEnvelope): AnyEvent | null {
  const sessionId = readString(input.payload, "session_id");
  const workspacePath = readString(input.payload, "cwd");
  const toolName = readString(input.payload, "tool_name");
  const durationMs = readNumber(input.payload, "duration_ms") ?? 0;
  const timestamp = new Date().toISOString();

  if (!sessionId || !workspacePath) {
    return null;
  }

  if (input.hookEventName === "SessionStart") {
    return buildBaseEvent({
      sessionId,
      workspacePath,
      timestamp,
      type: "session.started"
    });
  }

  if (input.hookEventName === "SessionEnd") {
    return buildBaseEvent({
      sessionId,
      workspacePath,
      timestamp,
      type: "session.ended",
      exit_code: null,
      duration_ms: durationMs
    });
  }

  if (!toolName) {
    return null;
  }

  if (input.hookEventName === "PreToolUse") {
    return buildBaseEvent({
      sessionId,
      workspacePath,
      timestamp,
      type: "tool.called",
      tool_name: toolName,
      status: "started",
      argument_summary: summarizeToolInput(input.payload.tool_input)
    });
  }

  if (input.hookEventName === "PostToolUse") {
    return buildBaseEvent({
      sessionId,
      workspacePath,
      timestamp,
      type: "tool.succeeded",
      tool_name: toolName,
      status: "succeeded",
      duration_ms: durationMs
    });
  }

  if (input.hookEventName === "PostToolUseFailure") {
    return buildBaseEvent({
      sessionId,
      workspacePath,
      timestamp,
      type: "tool.failed",
      tool_name: toolName,
      status: "failed",
      duration_ms: durationMs
    });
  }

  return null;
}

export function extractMutationTargets(input: { toolName: string; toolInput: unknown }): string[] {
  const record = isRecord(input.toolInput) ? input.toolInput : {};

  if (input.toolName === "Write" || input.toolName === "Edit") {
    return collectStringValues(record.file_path);
  }

  if (input.toolName === "MultiEdit") {
    return collectStringValues(record.file_path);
  }

  return [];
}
```

- [ ] **Step 4: Write the failing collector test**

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { handleHookEvent } from "./collect.js";

describe("handleHookEvent", () => {
  it("writes raw payloads, normalized events, and edit diffs for Edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const target = join(root, "notes.txt");

    await writeFile(target, "before\n", "utf8");

    await handleHookEvent({
      hookEventName: "PreToolUse",
      payload: {
        session_id: "ses_1",
        cwd: root,
        transcript_path: join(root, "session.jsonl"),
        tool_name: "Edit",
        tool_input: { file_path: "notes.txt", old_string: "before", new_string: "after" },
        tool_use_id: "toolu_1"
      },
      repoRoot: root
    });

    await writeFile(target, "after\n", "utf8");

    await handleHookEvent({
      hookEventName: "PostToolUse",
      payload: {
        session_id: "ses_1",
        cwd: root,
        transcript_path: join(root, "session.jsonl"),
        tool_name: "Edit",
        tool_input: { file_path: "notes.txt" },
        tool_use_id: "toolu_1",
        duration_ms: 25
      },
      repoRoot: root
    });

    const raw = await readFile(join(root, "data/hooks/raw/claude-code.jsonl"), "utf8");
    const normalized = await readFile(join(root, "data/events/events.jsonl"), "utf8");

    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(normalized).toContain("\"type\":\"tool.called\"");
    expect(normalized).toContain("\"type\":\"tool.succeeded\"");
    expect(normalized).toContain("\"type\":\"code.edit.applied\"");
  });
});
```

- [ ] **Step 5: Run the collector test to verify it fails**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/hooks/collect.test.ts
```

Expected: FAIL because `handleHookEvent` and snapshot helpers do not exist yet.

- [ ] **Step 6: Implement the collector, path resolution, and snapshots**

```ts
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { extractMutationTargets, normalizeClaudeHookPayload } from "@agent-metrics/adapters-claude";
import { loadSnapshotState, saveSnapshotState, clearSnapshotState } from "./snapshots.js";
import { resolveCollectorPaths } from "./paths.js";

export async function handleHookEvent(input: {
  hookEventName: string;
  payload: Record<string, unknown>;
  repoRoot: string;
}): Promise<void> {
  const paths = resolveCollectorPaths(input.repoRoot);

  await appendJsonLine(paths.rawHookLogPath, {
    captured_at: new Date().toISOString(),
    hook_event_name: input.hookEventName,
    payload: input.payload
  });

  const normalized = normalizeClaudeHookPayload({
    hookEventName: input.hookEventName,
    payload: input.payload
  });

  if (normalized) {
    await appendJsonLine(paths.eventLogPath, normalized);
  }

  const toolName = typeof input.payload.tool_name === "string" ? input.payload.tool_name : "";
  const toolUseId = typeof input.payload.tool_use_id === "string" ? input.payload.tool_use_id : "";
  const targets = extractMutationTargets({ toolName, toolInput: input.payload.tool_input });

  if (!toolUseId || targets.length === 0) {
    return;
  }

  if (input.hookEventName === "PreToolUse") {
    await saveSnapshotState(paths, {
      toolUseId,
      workspacePath: String(input.payload.cwd ?? input.repoRoot),
      targets
    });
    return;
  }

  if (input.hookEventName !== "PostToolUse") {
    return;
  }

  const snapshot = await loadSnapshotState(paths, toolUseId);

  if (!snapshot) {
    return;
  }

  const editEvent = await snapshot.toCodeEditEvent();

  if (editEvent) {
    await appendJsonLine(paths.eventLogPath, editEvent);
  }

  await clearSnapshotState(paths, toolUseId);
}
```

- [ ] **Step 7: Run the adapter and collector tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-claude exec vitest run src/hooks.test.ts
corepack pnpm --filter @agent-metrics/cli exec vitest run src/hooks/collect.test.ts
```

Expected: PASS with green suites for hook normalization, raw writes, and `code.edit.applied` generation for known mutating tools.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters-claude/src/index.ts packages/adapters-claude/src/hooks.ts packages/adapters-claude/src/hooks.test.ts apps/cli/src/hooks/collect.ts apps/cli/src/hooks/collect.test.ts apps/cli/src/hooks/paths.ts apps/cli/src/hooks/snapshots.ts
git commit -m "feat: collect Claude hooks into raw and normalized logs"
```

### Task 3: Add Global Claude Hooks Installation and a Manual Sample

**Files:**
- Create: `apps/cli/src/hooks/install.ts`
- Create: `apps/cli/src/hooks/install.test.ts`
- Create: `apps/cli/src/hooks/sample-config.ts`
- Create: `docs/manual/claude-hooks-global.sample.json`
- Create: `install-claude-hooks.ps1`
- Modify: `apps/cli/src/hooks/register.ts`
- Test: `apps/cli/src/hooks/install.test.ts`

- [ ] **Step 1: Write the failing installer test**

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { installClaudeHooks } from "./install.js";

describe("installClaudeHooks", () => {
  it("merges agent-metrics hooks into an existing global settings file idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-install-"));
    const settingsPath = join(root, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify({ theme: "dark", hooks: { Notification: [] } }, null, 2),
      "utf8"
    );

    await installClaudeHooks({
      repoRoot: "D:/projects/dev/agent-metrics",
      settingsPath
    });

    await installClaudeHooks({
      repoRoot: "D:/projects/dev/agent-metrics",
      settingsPath
    });

    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, unknown>;
      theme?: string;
    };

    expect(installed.theme).toBe("dark");
    expect(installed.hooks?.PreToolUse).toBeDefined();
    expect(installed.hooks?.PostToolUse).toBeDefined();
    expect(installed.hooks?.SessionStart).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the installer test to verify it fails**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/hooks/install.test.ts
```

Expected: FAIL because the installer module does not exist yet.

- [ ] **Step 3: Implement hook config generation and settings merge**

```ts
export function buildClaudeHooksConfig(input: { repoRoot: string }): Record<string, unknown> {
  const cli = `${input.repoRoot.replace(/\\/g, "/")}/apps/cli/dist/index.js`;

  return {
    SessionStart: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [cli, "hooks", "collect", "--hook-event-name", "SessionStart", "--repo-root", input.repoRoot]
          }
        ]
      }
    ],
    SessionEnd: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [cli, "hooks", "collect", "--hook-event-name", "SessionEnd", "--repo-root", input.repoRoot]
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
            args: [cli, "hooks", "collect", "--hook-event-name", "PreToolUse", "--repo-root", input.repoRoot]
          }
        ]
      }
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [cli, "hooks", "collect", "--hook-event-name", "PostToolUse", "--repo-root", input.repoRoot]
          }
        ]
      }
    ],
    PostToolUseFailure: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [cli, "hooks", "collect", "--hook-event-name", "PostToolUseFailure", "--repo-root", input.repoRoot]
          }
        ]
      }
    ]
  };
}

export async function installClaudeHooks(input: { repoRoot: string; settingsPath: string }): Promise<void> {
  const existing = await readSettingsJson(input.settingsPath);
  const next = {
    ...existing,
    hooks: mergeHookTrees(existing.hooks ?? {}, buildClaudeHooksConfig({ repoRoot: input.repoRoot }))
  };

  await writeFile(input.settingsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}
```

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $repoRoot
try {
  corepack pnpm build
  node .\apps\cli\dist\index.js hooks install --scope global --repo-root $repoRoot
} finally {
  Pop-Location
}
```

- [ ] **Step 4: Add a manual sample config artifact**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "D:/projects/dev/agent-metrics/apps/cli/dist/index.js",
              "hooks",
              "collect",
              "--hook-event-name",
              "PreToolUse",
              "--repo-root",
              "D:/projects/dev/agent-metrics"
            ]
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 5: Run the installer test to verify it passes**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/hooks/install.test.ts
```

Expected: PASS with a green suite proving global settings merges are idempotent and preserve unrelated settings.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/hooks/install.ts apps/cli/src/hooks/install.test.ts apps/cli/src/hooks/sample-config.ts apps/cli/src/hooks/register.ts docs/manual/claude-hooks-global.sample.json install-claude-hooks.ps1
git commit -m "feat: add global Claude hooks installer"
```

### Task 4: Update Core Ingestion and Overview Models for Hook-First Events

**Files:**
- Modify: `packages/metrics-engine/src/index.ts`
- Modify: `packages/metrics-engine/src/index.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`
- Test: `packages/metrics-engine/src/index.test.ts`
- Test: `apps/core/src/app.test.ts`

- [ ] **Step 1: Write the failing overview and timeline tests**

```ts
it("drops estimatedTokens from the overview response", () => {
  const overview = buildOverviewMetrics({
    sessions: [{ session_id: "ses_1" }],
    toolEvents: [{ status: "succeeded", duration_ms: 20 }],
    codeEdits: [],
    estimatedTokens: 0
  });

  expect(overview).toEqual({
    sessionCount: 1,
    totalToolCalls: 1,
    successfulExecutions: 1,
    failedExecutions: 0,
    successRate: 1,
    editOperationCount: 0,
    affectedFileCount: 0,
    insertions: 0,
    deletions: 0
  });
});

it("returns session start and end boundaries in the session detail timeline", async () => {
  const response = await app.inject({ method: "GET", url: "/api/sessions/ses_1" });
  const body = response.json() as {
    timeline: Array<{ type: string }>;
  };

  expect(body.timeline[0]?.type).toBe("session.started");
  expect(body.timeline.at(-1)?.type).toBe("session.ended");
});
```

- [ ] **Step 2: Run the metrics-engine and core tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/metrics-engine exec vitest run src/index.test.ts
corepack pnpm --filter @agent-metrics/core exec vitest run src/app.test.ts
```

Expected: FAIL because the overview still includes `estimatedTokens` and the session detail timeline does not include session boundaries.

- [ ] **Step 3: Remove token dependence and track ended sessions**

```ts
export type OverviewMetrics = {
  sessionCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
};
```

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    workspace_path TEXT NOT NULL,
    exit_code INTEGER
  );
`);

if (!sessionColumns.some((column) => column.name === "ended_at")) {
  db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
}

if (!sessionColumns.some((column) => column.name === "exit_code")) {
  db.exec("ALTER TABLE sessions ADD COLUMN exit_code INTEGER");
}
```

```ts
if (parsed.type === "session.ended") {
  db.prepare("UPDATE sessions SET ended_at = ?, exit_code = ? WHERE session_id = ?").run(
    parsed.timestamp,
    parsed.exit_code ?? null,
    parsed.session_id
  );
}
```

```ts
const timeline = [
  { createdAt: session.startedAt, type: "session.started", toolName: "", status: "started", durationMs: 0, filesChanged: [], insertions: 0, deletions: 0 },
  ...toolRows.map(/* existing mapping */),
  ...codeEditRows.map(/* existing mapping */),
  ...(session.endedAt
    ? [{ createdAt: session.endedAt, type: "session.ended", toolName: "", status: "ended", durationMs: 0, filesChanged: [], insertions: 0, deletions: 0 }]
    : [])
].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
```

- [ ] **Step 4: Run the metrics-engine and core tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/metrics-engine exec vitest run src/index.test.ts
corepack pnpm --filter @agent-metrics/core exec vitest run src/app.test.ts
```

Expected: PASS with the token field removed from overview expectations and session detail timelines including `session.started` / `session.ended`.

- [ ] **Step 5: Commit**

```bash
git add packages/metrics-engine/src/index.ts packages/metrics-engine/src/index.test.ts apps/core/src/app.ts apps/core/src/app.test.ts
git commit -m "feat: ingest hook-first session metrics"
```

### Task 5: Update the Dashboard to Surface Real Tool Names and a Session Timeline

**Files:**
- Create: `apps/dashboard/src/components/SessionTimelinePanel.tsx`
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`
- Modify: `apps/dashboard/src/components/RecentSessionsTable.tsx`
- Modify: `apps/dashboard/src/styles.css`
- Test: `apps/dashboard/src/App.test.tsx`

- [ ] **Step 1: Write the failing dashboard test**

```ts
vi.mock("./api", () => ({
  fetchOverview: async () => ({
    sessionCount: 1,
    totalToolCalls: 4,
    successfulExecutions: 4,
    failedExecutions: 0,
    successRate: 1,
    editOperationCount: 1,
    affectedFileCount: 1,
    insertions: 2,
    deletions: 0
  }),
  fetchTools: async () => [{ toolName: "Read", count: 2, failures: 0, averageDurationMs: 12 }],
  fetchSessions: async () => [{ sessionId: "ses_1", workspacePath: "D:/tmp/workspace" }],
  fetchSessionDetail: async () => ({
    sessionId: "ses_1",
    timeline: [
      { type: "session.started", toolName: "", status: "started", durationMs: 0, filesChanged: [], insertions: 0, deletions: 0 },
      { type: "tool.succeeded", toolName: "Read", status: "succeeded", durationMs: 12, filesChanged: [], insertions: 0, deletions: 0 }
    ]
  }),
  buildExportUrl: (format: "csv" | "json") => `/api/exports/${format}`
}));

it("renders a selected session timeline and hides the token KPI", async () => {
  render(<App />);

  expect(await screen.findByText("Read")).toBeInTheDocument();
  expect(screen.queryByText("Estimated Tokens")).not.toBeInTheDocument();
  expect(await screen.findByText("Session Timeline")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the dashboard test to verify it fails**

Run:

```bash
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/App.test.tsx
```

Expected: FAIL because the API types still require `estimatedTokens` and the UI has no session timeline panel.

- [ ] **Step 3: Implement the hook-first dashboard API contract**

```ts
export type OverviewResponse = {
  sessionCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
};

export type SessionDetailResponse = {
  sessionId: string;
  timeline: Array<{
    type: string;
    toolName: string;
    status: string;
    durationMs: number;
    filesChanged: string[];
    insertions: number;
    deletions: number;
  }>;
};

export async function fetchSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  return fetchJson<SessionDetailResponse>(`/api/sessions/${sessionId}`);
}
```

- [ ] **Step 4: Add selected-session timeline UI**

```tsx
type RecentSessionsTableProps = {
  rows: SessionRow[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
};

<tbody>
  {rows.map((row) => (
    <tr
      key={row.sessionId}
      data-selected={row.sessionId === selectedSessionId}
      onClick={() => onSelect(row.sessionId)}
    >
      <td>{row.sessionId}</td>
      <td className="workspace-cell">{row.workspacePath}</td>
    </tr>
  ))}
</tbody>
```

```tsx
export function SessionTimelinePanel({ detail }: { detail: SessionDetailResponse | null }) {
  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <h2>Session Timeline</h2>
        <span>{detail ? detail.timeline.length : 0} events</span>
      </div>
      <div className="timeline-list">
        {detail?.timeline.map((entry, index) => (
          <article className="timeline-row" key={`${entry.type}-${entry.toolName}-${index}`}>
            <strong>{entry.type}</strong>
            <span>{entry.toolName || "Session"}</span>
            <span>{entry.durationMs} ms</span>
          </article>
        ))}
      </div>
    </section>
  );
}
```

```tsx
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
const [selectedSession, setSelectedSession] = useState<SessionDetailResponse | null>(null);

useEffect(() => {
  if (!selectedSessionId) {
    return;
  }

  void fetchSessionDetail(selectedSessionId).then(setSelectedSession);
}, [selectedSessionId]);
```

- [ ] **Step 5: Run the dashboard test to verify it passes**

Run:

```bash
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/App.test.tsx
```

Expected: PASS with the token KPI removed and a visible `Session Timeline` panel rendering real tool names such as `Read` and `Bash`.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/api.ts apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/components/KpiGrid.tsx apps/dashboard/src/components/RecentSessionsTable.tsx apps/dashboard/src/components/SessionTimelinePanel.tsx apps/dashboard/src/styles.css
git commit -m "feat: surface hook-first activity in dashboard"
```

### Task 6: Rewrite Scripts, Docs, and Verification Around Hooks

**Files:**
- Modify: `README.md`
- Modify: `start-agent-metrics.ps1`
- Modify: `apps/cli/src/index.test.ts` if CLI help text snapshots are used
- Test: `README.md` manual verification checklist

- [ ] **Step 1: Write the failing verification checklist into the README plan notes**

```md
## Hooks-first verification

1. Run `.\install-claude-hooks.ps1`
2. Start the dashboard with `.\start-agent-metrics.ps1`
3. Open a test repo in Claude Code
4. Trigger `Read`, `Grep`, `Edit`, and `Bash`
5. Confirm:
   - `data/hooks/raw/claude-code.jsonl` grows
   - `data/events/events.jsonl` grows
   - dashboard shows real tool names
   - session timeline matches the actions you took
```

- [ ] **Step 2: Update the startup script to point users at hooks installation**

```powershell
Write-Host ""
Write-Host "Next step: run .\\install-claude-hooks.ps1 once to register global Claude hooks."
Write-Host "Then open Claude Code in any workspace and verify data appears in the dashboard."
```

- [ ] **Step 3: Rewrite README to remove wrapper-first guidance**

~~~md
# Agent Metrics

Local-first metrics dashboard for Claude Code hooks.

## Quick start

```powershell
cd D:\projects\dev\agent-metrics
.\start-agent-metrics.ps1
.\install-claude-hooks.ps1
```

## How collection works

- Claude Code hooks call the local collector in `apps/cli`
- Raw hook payloads append to `data/hooks/raw/claude-code.jsonl`
- Normalized product events append to `data/events/events.jsonl`
- Core ingests normalized events and dashboard renders them
~~~

- [ ] **Step 4: Run full project verification**

Run:

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm lint
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1 -NoBrowser
```

Expected:

- `test`: PASS across CLI, core, dashboard, adapters, metrics-engine
- `build`: PASS for all workspaces
- `lint`: PASS with no TypeScript errors
- `start-agent-metrics.ps1 -NoBrowser`: prints dashboard/API URLs and the hooks installation hint

- [ ] **Step 5: Notify the user to perform phase 1 manual testing**

```md
Phase 1 is ready for your test.

Please run:

1. `.\install-claude-hooks.ps1`
2. Open Claude Code in a test workspace
3. Trigger `Read`, `Search/Grep`, `Edit`, `Bash`
4. Check the dashboard and raw logs
```

- [ ] **Step 6: Commit**

```bash
git add README.md start-agent-metrics.ps1 install-claude-hooks.ps1
git commit -m "docs: switch setup and verification to Claude hooks"
```

## Self-Review

- Spec coverage:
  - hooks collector: covered by Tasks 1-2
  - global install + manual sample: covered by Task 3
  - hook-first core model: covered by Task 4
  - dashboard token removal + timeline: covered by Task 5
  - user test notification: covered by Task 6
- Placeholder scan:
  - no `TBD`, `TODO`, or “implement later”
  - no task says “similar to previous task”
- Type consistency:
  - `OverviewResponse` no longer includes `estimatedTokens`
  - CLI command family remains `hooks collect/install/print-config`
  - phase 1 keeps `data/events/events.jsonl` as the normalized event file
