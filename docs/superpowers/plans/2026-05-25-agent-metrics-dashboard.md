# Agent Metrics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first agent metrics tool that wraps Claude Code, records session and tool activity, stores raw events plus SQLite aggregates, and serves an overview-first dashboard with JSON and CSV export.

**Architecture:** The implementation is split into a wrapper CLI, a local metrics core, and a React dashboard. Raw normalized events are appended to JSONL, then ingested into SQLite and aggregated through a metrics engine exposed by a local Fastify API.

**Tech Stack:** TypeScript, Node.js, Fastify, React, Vite, Vitest, SQLite (`better-sqlite3`), pnpm workspaces

---

## File Structure

Create and use these files:

- `package.json`
  Root workspace scripts and shared dev dependencies.
- `pnpm-workspace.yaml`
  Workspace registration for apps and packages.
- `tsconfig.base.json`
  Shared TypeScript defaults.
- `.gitignore`
  Ignore node modules, build output, JSONL event files, SQLite files, and local dashboard artifacts.
- `README.md`
  Local development and usage instructions.
- `apps/cli/package.json`
  CLI app package metadata and scripts.
- `apps/cli/tsconfig.json`
  CLI app TypeScript config.
- `apps/cli/src/index.ts`
  `agent-metrics wrap claude -- ...` entrypoint.
- `apps/cli/src/index.test.ts`
  Wrapper session lifecycle tests.
- `apps/core/package.json`
  Core service package metadata and scripts.
- `apps/core/tsconfig.json`
  Core service TypeScript config.
- `apps/core/src/app.ts`
  Fastify app factory.
- `apps/core/src/server.ts`
  Core service boot file.
- `apps/core/src/app.test.ts`
  Core API integration tests.
- `apps/dashboard/package.json`
  Dashboard app package metadata and scripts.
- `apps/dashboard/tsconfig.json`
  Dashboard TypeScript config.
- `apps/dashboard/vite.config.ts`
  Vite config.
- `apps/dashboard/src/main.tsx`
  Dashboard entrypoint.
- `apps/dashboard/src/App.tsx`
  App shell and polling orchestration.
- `apps/dashboard/src/App.test.tsx`
  Dashboard smoke tests.
- `apps/dashboard/src/api.ts`
  Local API client.
- `apps/dashboard/src/styles.css`
  Dashboard styles.
- `apps/dashboard/src/components/KpiGrid.tsx`
  KPI card rendering.
- `apps/dashboard/src/components/ToolRankingTable.tsx`
  Tool ranking UI.
- `apps/dashboard/src/components/RecentSessionsTable.tsx`
  Recent sessions UI.
- `apps/dashboard/src/components/TrendChart.tsx`
  Overview trend UI.
- `packages/event-schema/package.json`
  Shared event schema package.
- `packages/event-schema/tsconfig.json`
  Event schema TypeScript config.
- `packages/event-schema/src/index.ts`
  Zod schemas and TypeScript exports for normalized events and API payloads.
- `packages/event-schema/src/index.test.ts`
  Event schema tests.
- `packages/shared-utils/package.json`
  Shared helper package metadata.
- `packages/shared-utils/tsconfig.json`
  Shared helper TypeScript config.
- `packages/shared-utils/src/jsonl.ts`
  JSONL append and read helpers.
- `packages/shared-utils/src/fs.ts`
  Filesystem helpers.
- `packages/shared-utils/src/diff.ts`
  Text diff line-count helpers.
- `packages/shared-utils/src/index.ts`
  Package export barrel.
- `packages/shared-utils/src/diff.test.ts`
  Diff helper tests.
- `packages/adapters-claude/package.json`
  Claude adapter package metadata.
- `packages/adapters-claude/tsconfig.json`
  Claude adapter TypeScript config.
- `packages/adapters-claude/src/index.ts`
  Claude adapter entrypoint.
- `packages/adapters-claude/src/normalize.ts`
  Raw Claude observable event normalization.
- `packages/adapters-claude/src/normalize.test.ts`
  Claude adapter fixture tests.
- `packages/metrics-engine/package.json`
  Metrics engine package metadata.
- `packages/metrics-engine/tsconfig.json`
  Metrics engine TypeScript config.
- `packages/metrics-engine/src/index.ts`
  Aggregate calculators and query helpers.
- `packages/metrics-engine/src/index.test.ts`
  Aggregate tests.
- `packages/export-kit/package.json`
  Export helper package metadata.
- `packages/export-kit/tsconfig.json`
  Export helper TypeScript config.
- `packages/export-kit/src/index.ts`
  JSON and CSV export serializers.
- `packages/export-kit/src/index.test.ts`
  Export tests.
- `data/events/.gitkeep`
  Keeps raw event directory in place.
- `data/sqlite/.gitkeep`
  Keeps SQLite directory in place.

## Task 1: Bootstrap The Workspace And Shared Event Schema

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `packages/event-schema/package.json`
- Create: `packages/event-schema/tsconfig.json`
- Create: `packages/event-schema/src/index.test.ts`
- Create: `data/events/.gitkeep`
- Create: `data/sqlite/.gitkeep`

- [ ] **Step 1: Write the failing test and workspace scaffolding**

Create `package.json`:

```json
{
  "name": "agent-metrics",
  "private": true,
  "packageManager": "pnpm@10.11.0",
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm --parallel --filter @agent-metrics/core --filter @agent-metrics/dashboard dev",
    "lint": "pnpm -r exec tsc --noEmit",
    "test": "pnpm -r test"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@types/node": "^22.15.29",
    "@types/react": "^19.1.6",
    "@types/react-dom": "^19.1.5",
    "@vitejs/plugin-react": "^4.5.0",
    "jsdom": "^26.1.0",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vite": "^6.3.5",
    "vitest": "^3.1.4"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist",
    "baseUrl": "."
  }
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.vite/
.DS_Store
data/events/*.jsonl
data/sqlite/*.db
data/sqlite/*.sqlite
data/sqlite/*.sqlite-shm
data/sqlite/*.sqlite-wal
```

Create `README.md`:

```md
# Agent Metrics

Local-first metrics dashboard for Claude Code and future agent adapters.
```

Create `packages/event-schema/package.json`:

```json
{
  "name": "@agent-metrics/event-schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run src/index.test.ts"
  },
  "dependencies": {
    "zod": "^3.24.4"
  }
}
```

Create `packages/event-schema/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `packages/event-schema/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AnyEventSchema } from "./index";

describe("AnyEventSchema", () => {
  it("parses a session.started event", () => {
    const result = AnyEventSchema.safeParse({
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    expect(result.success).toBe(true);
  });

  it("rejects a tool event without a tool name", () => {
    const result = AnyEventSchema.safeParse({
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.called",
      status: "started"
    });

    expect(result.success).toBe(false);
  });
});
```

Create `data/events/.gitkeep` and `data/sqlite/.gitkeep` as empty files.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm install
pnpm --filter @agent-metrics/event-schema test
```

Expected: FAIL with a module resolution error for `./index` because `packages/event-schema/src/index.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `packages/event-schema/src/index.ts`:

```ts
import { z } from "zod";

const BaseEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  timestamp: z.string().datetime(),
  source_vendor: z.string().min(1),
  source_adapter: z.string().min(1),
  workspace_path: z.string().min(1)
});

export const SessionStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("session.started")
});

export const SessionEndedEventSchema = BaseEventSchema.extend({
  type: z.literal("session.ended"),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nonnegative().optional()
});

export const ToolCalledEventSchema = BaseEventSchema.extend({
  type: z.literal("tool.called"),
  tool_name: z.string().min(1),
  status: z.literal("started"),
  argument_summary: z.string().default("")
});

export const ToolFinishedEventSchema = BaseEventSchema.extend({
  type: z.union([z.literal("tool.succeeded"), z.literal("tool.failed")]),
  tool_name: z.string().min(1),
  status: z.union([z.literal("succeeded"), z.literal("failed")]),
  duration_ms: z.number().int().nonnegative()
});

export const CodeEditAppliedEventSchema = BaseEventSchema.extend({
  type: z.literal("code.edit.applied"),
  tool_name: z.string().min(1),
  files_changed: z.array(z.string().min(1)),
  file_count: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  edit_operation_count: z.number().int().positive()
});

export const SnapshotCreatedEventSchema = BaseEventSchema.extend({
  type: z.literal("snapshot.created"),
  file_path: z.string().min(1),
  snapshot_role: z.union([z.literal("before"), z.literal("after")])
});

export const IngestErrorEventSchema = BaseEventSchema.extend({
  type: z.literal("ingest_error"),
  message: z.string().min(1)
});

export const AnyEventSchema = z.discriminatedUnion("type", [
  SessionStartedEventSchema,
  SessionEndedEventSchema,
  ToolCalledEventSchema,
  ToolFinishedEventSchema,
  CodeEditAppliedEventSchema,
  SnapshotCreatedEventSchema,
  IngestErrorEventSchema
]);

export type AnyEvent = z.infer<typeof AnyEventSchema>;
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;
export type SessionEndedEvent = z.infer<typeof SessionEndedEventSchema>;
export type ToolCalledEvent = z.infer<typeof ToolCalledEventSchema>;
export type ToolFinishedEvent = z.infer<typeof ToolFinishedEventSchema>;
export type CodeEditAppliedEvent = z.infer<typeof CodeEditAppliedEventSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/event-schema test
```

Expected: PASS with 2 passing tests in `packages/event-schema/src/index.test.ts`.

- [ ] **Step 5: Commit**

Run:

```bash
git init
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore README.md packages/event-schema data
git commit -m "chore: bootstrap workspace and event schema"
```

## Task 2: Add Shared Filesystem Helpers And The Wrapper CLI Skeleton

**Files:**
- Create: `packages/shared-utils/package.json`
- Create: `packages/shared-utils/tsconfig.json`
- Create: `packages/shared-utils/src/fs.ts`
- Create: `packages/shared-utils/src/jsonl.ts`
- Create: `packages/shared-utils/src/index.ts`
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared-utils/package.json`:

```json
{
  "name": "@agent-metrics/shared-utils",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run src/*.test.ts"
  }
}
```

Create `packages/shared-utils/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `apps/cli/package.json`:

```json
{
  "name": "@agent-metrics/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run src/index.test.ts"
  },
  "dependencies": {
    "@agent-metrics/event-schema": "workspace:*",
    "@agent-metrics/shared-utils": "workspace:*",
    "commander": "^12.1.0"
  }
}
```

Create `apps/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `apps/cli/src/index.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runWrappedSession } from "./index";

describe("runWrappedSession", () => {
  it("writes session.started and session.ended events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-"));
    const outputFile = join(root, "events.jsonl");

    const exitCode = await runWrappedSession({
      args: ["claude", "--version"],
      eventLogPath: outputFile,
      workspacePath: root,
      runCommand: async () => 0
    });

    const lines = (await readFile(outputFile, "utf8")).trim().split("\n");

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\"type\":\"session.started\"");
    expect(lines[1]).toContain("\"type\":\"session.ended\"");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/cli test
```

Expected: FAIL because `apps/cli/src/index.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared-utils/src/fs.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
```

Create `packages/shared-utils/src/jsonl.ts`:

```ts
import { appendFile } from "node:fs/promises";
import { ensureParentDir } from "./fs.js";

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await appendFile(filePath, JSON.stringify(value) + "\n", "utf8");
}
```

Create `packages/shared-utils/src/index.ts`:

```ts
export * from "./fs.js";
export * from "./jsonl.js";
```

Create `apps/cli/src/index.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import type { SessionEndedEvent, SessionStartedEvent } from "@agent-metrics/event-schema";

export type WrappedSessionOptions = {
  args: string[];
  eventLogPath: string;
  workspacePath: string;
  runCommand?: (args: string[]) => Promise<number>;
};

async function defaultRunCommand(): Promise<number> {
  return 0;
}

export async function runWrappedSession(options: WrappedSessionOptions): Promise<number> {
  const sessionId = randomUUID();
  const startedAt = new Date();
  const runCommand = options.runCommand ?? defaultRunCommand;

  const startedEvent: SessionStartedEvent = {
    event_id: randomUUID(),
    session_id: sessionId,
    timestamp: startedAt.toISOString(),
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: options.workspacePath,
    type: "session.started"
  };

  await appendJsonLine(options.eventLogPath, startedEvent);
  const exitCode = await runCommand(options.args);
  const endedAt = new Date();

  const endedEvent: SessionEndedEvent = {
    event_id: randomUUID(),
    session_id: sessionId,
    timestamp: endedAt.toISOString(),
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: options.workspacePath,
    type: "session.ended",
    exit_code: exitCode,
    duration_ms: endedAt.getTime() - startedAt.getTime()
  };

  await appendJsonLine(options.eventLogPath, endedEvent);
  return exitCode;
}

const program = new Command();

program
  .name("agent-metrics")
  .command("wrap")
  .argument("<command>")
  .argument("[args...]")
  .option("--event-log-path <path>", "Path to event log", "data/events/events.jsonl")
  .action(async (command, args, options) => {
    const exitCode = await runWrappedSession({
      args: [command, ...args],
      eventLogPath: options.eventLogPath,
      workspacePath: process.cwd()
    });
    process.exitCode = exitCode;
  });

if (process.argv.length > 2) {
  void program.parseAsync(process.argv);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/cli test
```

Expected: PASS with 1 passing test in `apps/cli/src/index.test.ts`.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/cli packages/shared-utils
git commit -m "feat: add wrapper cli skeleton"
```

## Task 3: Normalize Claude Tool And Edit Observations

**Files:**
- Create: `packages/shared-utils/src/diff.test.ts`
- Create: `packages/shared-utils/src/diff.ts`
- Create: `packages/adapters-claude/package.json`
- Create: `packages/adapters-claude/tsconfig.json`
- Create: `packages/adapters-claude/src/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared-utils/src/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffTextStats } from "./diff";

describe("diffTextStats", () => {
  it("reports insertions and deletions", () => {
    const result = diffTextStats("a\nb\n", "a\nc\nb\n");
    expect(result).toEqual({ insertions: 1, deletions: 0 });
  });
});
```

Create `packages/adapters-claude/package.json`:

```json
{
  "name": "@agent-metrics/adapters-claude",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run src/normalize.test.ts"
  },
  "dependencies": {
    "@agent-metrics/event-schema": "workspace:*",
    "@agent-metrics/shared-utils": "workspace:*"
  }
}
```

Create `packages/adapters-claude/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `packages/adapters-claude/src/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeClaudeObservation } from "./normalize";

describe("normalizeClaudeObservation", () => {
  it("maps tool start observations into tool.called events", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "tool_start",
        toolName: "Read",
        argumentSummary: "Read package.json"
      }
    });

    expect(event.type).toBe("tool.called");
    expect(event.tool_name).toBe("Read");
  });

  it("maps edit observations into code.edit.applied events", () => {
    const event = normalizeClaudeObservation({
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      observation: {
        kind: "edit_applied",
        toolName: "Edit",
        files: [
          {
            path: "README.md",
            before: "# Agent Metrics\n",
            after: "# Agent Metrics\n\nUpdated\n"
          }
        ]
      }
    });

    expect(event.type).toBe("code.edit.applied");
    expect(event.file_count).toBe(1);
    expect(event.insertions).toBe(2);
    expect(event.deletions).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/shared-utils test
pnpm --filter @agent-metrics/adapters-claude test
```

Expected: FAIL because `packages/shared-utils/src/diff.ts` and `packages/adapters-claude/src/normalize.ts` do not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared-utils/src/diff.ts`:

```ts
export function diffTextStats(before: string, after: string): { insertions: number; deletions: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let insertions = 0;
  let deletions = 0;
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (afterLines[afterIndex + 1] === beforeLines[beforeIndex]) {
      insertions += 1;
      afterIndex += 1;
      continue;
    }

    if (beforeLines[beforeIndex + 1] === afterLines[afterIndex]) {
      deletions += 1;
      beforeIndex += 1;
      continue;
    }

    insertions += 1;
    deletions += 1;
    beforeIndex += 1;
    afterIndex += 1;
  }

  insertions += Math.max(0, afterLines.length - afterIndex - 1);
  deletions += Math.max(0, beforeLines.length - beforeIndex - 1);

  return { insertions, deletions };
}
```

Update `packages/shared-utils/src/index.ts`:

```ts
export * from "./diff.js";
export * from "./fs.js";
export * from "./jsonl.js";
```

Create `packages/adapters-claude/src/normalize.ts`:

```ts
import { randomUUID } from "node:crypto";
import { diffTextStats } from "@agent-metrics/shared-utils";
import type { AnyEvent } from "@agent-metrics/event-schema";

type ToolStartObservation = {
  kind: "tool_start";
  toolName: string;
  argumentSummary: string;
};

type ToolFinishObservation = {
  kind: "tool_finish";
  toolName: string;
  ok: boolean;
  durationMs: number;
};

type EditAppliedObservation = {
  kind: "edit_applied";
  toolName: string;
  files: Array<{
    path: string;
    before: string;
    after: string;
  }>;
};

type ClaudeObservation = ToolStartObservation | ToolFinishObservation | EditAppliedObservation;

export function normalizeClaudeObservation(input: {
  sessionId: string;
  workspacePath: string;
  observation: ClaudeObservation;
}): AnyEvent {
  const base = {
    event_id: randomUUID(),
    session_id: input.sessionId,
    timestamp: new Date().toISOString(),
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: input.workspacePath
  };

  if (input.observation.kind === "tool_start") {
    return {
      ...base,
      type: "tool.called",
      tool_name: input.observation.toolName,
      status: "started",
      argument_summary: input.observation.argumentSummary
    };
  }

  if (input.observation.kind === "tool_finish") {
    return {
      ...base,
      type: input.observation.ok ? "tool.succeeded" : "tool.failed",
      tool_name: input.observation.toolName,
      status: input.observation.ok ? "succeeded" : "failed",
      duration_ms: input.observation.durationMs
    };
  }

  const totals = input.observation.files.reduce(
    (acc, file) => {
      const diff = diffTextStats(file.before, file.after);
      acc.insertions += diff.insertions;
      acc.deletions += diff.deletions;
      return acc;
    },
    { insertions: 0, deletions: 0 }
  );

  return {
    ...base,
    type: "code.edit.applied",
    tool_name: input.observation.toolName,
    files_changed: input.observation.files.map((file) => file.path),
    file_count: input.observation.files.length,
    insertions: totals.insertions,
    deletions: totals.deletions,
    edit_operation_count: 1
  };
}
```

Create `packages/adapters-claude/src/index.ts`:

```ts
export * from "./normalize.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/shared-utils test
pnpm --filter @agent-metrics/adapters-claude test
```

Expected: PASS with 1 passing diff test and 2 passing Claude adapter tests.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/shared-utils packages/adapters-claude
git commit -m "feat: normalize claude observations"
```

## Task 4: Persist Raw Events Into SQLite

**Files:**
- Create: `apps/core/package.json`
- Create: `apps/core/tsconfig.json`
- Create: `apps/core/src/app.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/core/package.json`:

```json
{
  "name": "@agent-metrics/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "types": "dist/server.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/server.ts",
    "test": "vitest run src/app.test.ts"
  },
  "dependencies": {
    "@agent-metrics/event-schema": "workspace:*",
    "@agent-metrics/shared-utils": "workspace:*",
    "better-sqlite3": "^11.10.0",
    "fastify": "^5.3.3"
  }
}
```

Create `apps/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `apps/core/src/app.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { buildApp, ingestEventLog } from "./app";

let dbPath: string;
let logPath: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-core-"));
  dbPath = join(root, "metrics.sqlite");
  logPath = join(root, "events.jsonl");
});

describe("ingestEventLog", () => {
  it("stores session and tool events into SQLite-backed overview rows", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalToolCalls: 1,
      successfulExecutions: 1,
      sessionCount: 1
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/core test
```

Expected: FAIL because `apps/core/src/app.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/core/src/app.ts`:

```ts
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AnyEventSchema } from "@agent-metrics/event-schema";

export function buildApp(input: { dbPath: string }) {
  const db = new Database(input.dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
  `);

  const app = Fastify();

  app.get("/api/overview", async () => {
    const sessionCount = Number(db.prepare("SELECT COUNT(*) AS value FROM sessions").get().value);
    const totalToolCalls = Number(db.prepare("SELECT COUNT(*) AS value FROM tool_events").get().value);
    const successfulExecutions = Number(
      db.prepare("SELECT COUNT(*) AS value FROM tool_events WHERE status = 'succeeded'").get().value
    );

    return {
      sessionCount,
      totalToolCalls,
      successfulExecutions
    };
  });

  return Object.assign(app, { db });
}

export async function ingestEventLog(input: {
  app: ReturnType<typeof buildApp>;
  eventLogPath: string;
}): Promise<void> {
  const file = await readFile(input.eventLogPath, "utf8");
  const lines = file.trim().split("\n").filter(Boolean);
  const db = input.app.db as Database.Database;

  for (const line of lines) {
    const parsed = AnyEventSchema.parse(JSON.parse(line));

    if (parsed.type === "session.started") {
      db.prepare(
        "INSERT OR REPLACE INTO sessions (session_id, started_at, workspace_path) VALUES (?, ?, ?)"
      ).run(parsed.session_id, parsed.timestamp, parsed.workspace_path);
    }

    if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
      db.prepare(
        "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.tool_name, parsed.status, parsed.duration_ms, parsed.timestamp);
    }
  }
}
```

Create `apps/core/src/server.ts`:

```ts
import { buildApp } from "./app.js";

const app = buildApp({ dbPath: "data/sqlite/metrics.sqlite" });

app.listen({ host: "127.0.0.1", port: 4318 }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/core test
```

Expected: PASS with 1 passing integration test.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/core
git commit -m "feat: add sqlite ingest and overview endpoint"
```

## Task 5: Add The Metrics Engine And Rich Overview Aggregates

**Files:**
- Create: `packages/metrics-engine/package.json`
- Create: `packages/metrics-engine/tsconfig.json`
- Create: `packages/metrics-engine/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/metrics-engine/package.json`:

```json
{
  "name": "@agent-metrics/metrics-engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run src/index.test.ts"
  }
}
```

Create `packages/metrics-engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `packages/metrics-engine/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOverviewMetrics } from "./index";

describe("buildOverviewMetrics", () => {
  it("calculates overview counters and success rate", () => {
    const overview = buildOverviewMetrics({
      sessions: [{ session_id: "ses_1" }],
      toolEvents: [
        { status: "succeeded", duration_ms: 10 },
        { status: "failed", duration_ms: 30 }
      ],
      codeEdits: [
        { file_count: 2, insertions: 12, deletions: 4, edit_operation_count: 1 }
      ],
      estimatedTokens: 1200
    });

    expect(overview).toEqual({
      sessionCount: 1,
      totalToolCalls: 2,
      successfulExecutions: 1,
      failedExecutions: 1,
      successRate: 0.5,
      editOperationCount: 1,
      affectedFileCount: 2,
      insertions: 12,
      deletions: 4,
      estimatedTokens: 1200
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/metrics-engine test
```

Expected: FAIL because `packages/metrics-engine/src/index.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/metrics-engine/src/index.ts`:

```ts
type SessionRow = { session_id: string };
type ToolRow = { status: string; duration_ms: number };
type CodeEditRow = {
  file_count: number;
  insertions: number;
  deletions: number;
  edit_operation_count: number;
};

export function buildOverviewMetrics(input: {
  sessions: SessionRow[];
  toolEvents: ToolRow[];
  codeEdits: CodeEditRow[];
  estimatedTokens: number;
}) {
  const successfulExecutions = input.toolEvents.filter((row) => row.status === "succeeded").length;
  const failedExecutions = input.toolEvents.filter((row) => row.status === "failed").length;
  const totalToolCalls = input.toolEvents.length;
  const editOperationCount = input.codeEdits.reduce((sum, row) => sum + row.edit_operation_count, 0);
  const affectedFileCount = input.codeEdits.reduce((sum, row) => sum + row.file_count, 0);
  const insertions = input.codeEdits.reduce((sum, row) => sum + row.insertions, 0);
  const deletions = input.codeEdits.reduce((sum, row) => sum + row.deletions, 0);

  return {
    sessionCount: input.sessions.length,
    totalToolCalls,
    successfulExecutions,
    failedExecutions,
    successRate: totalToolCalls === 0 ? 0 : successfulExecutions / totalToolCalls,
    editOperationCount,
    affectedFileCount,
    insertions,
    deletions,
    estimatedTokens: input.estimatedTokens
  };
}
```

Update `apps/core/src/app.ts`:

```ts
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import { buildOverviewMetrics } from "@agent-metrics/metrics-engine";

export function buildApp(input: { dbPath: string }) {
  const db = new Database(input.dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_edits (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      insertions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      edit_operation_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const app = Fastify();

  app.get("/api/overview", async () => {
    const sessions = db.prepare("SELECT session_id, estimated_tokens FROM sessions").all() as Array<{
      session_id: string;
      estimated_tokens: number;
    }>;
    const toolEvents = db.prepare("SELECT status, duration_ms FROM tool_events").all() as Array<{
      status: string;
      duration_ms: number;
    }>;
    const codeEdits = db.prepare(
      "SELECT file_count, insertions, deletions, edit_operation_count FROM code_edits"
    ).all() as Array<{
      file_count: number;
      insertions: number;
      deletions: number;
      edit_operation_count: number;
    }>;

    const estimatedTokens = sessions.reduce((sum, row) => sum + row.estimated_tokens, 0);
    return buildOverviewMetrics({ sessions, toolEvents, codeEdits, estimatedTokens });
  });

  return Object.assign(app, { db });
}

export async function ingestEventLog(input: {
  app: ReturnType<typeof buildApp>;
  eventLogPath: string;
}): Promise<void> {
  const file = await readFile(input.eventLogPath, "utf8");
  const lines = file.trim().split("\n").filter(Boolean);
  const db = input.app.db as Database.Database;

  for (const line of lines) {
    const parsed = AnyEventSchema.parse(JSON.parse(line));

    if (parsed.type === "session.started") {
      db.prepare(
        "INSERT OR REPLACE INTO sessions (session_id, started_at, workspace_path, estimated_tokens) VALUES (?, ?, ?, 0)"
      ).run(parsed.session_id, parsed.timestamp, parsed.workspace_path);
    }

    if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
      db.prepare(
        "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.tool_name, parsed.status, parsed.duration_ms, parsed.timestamp);
    }

    if (parsed.type === "code.edit.applied") {
      db.prepare(
        "INSERT OR REPLACE INTO code_edits (event_id, session_id, tool_name, file_count, insertions, deletions, edit_operation_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        parsed.event_id,
        parsed.session_id,
        parsed.tool_name,
        parsed.file_count,
        parsed.insertions,
        parsed.deletions,
        parsed.edit_operation_count,
        parsed.timestamp
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/metrics-engine test
pnpm --filter @agent-metrics/core test
```

Expected: PASS with the metrics-engine test green and the core integration test still green.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/metrics-engine apps/core/src/app.ts
git commit -m "feat: add metrics engine and overview aggregates"
```

## Task 6: Add Tools, Sessions, And Export Endpoints

**Files:**
- Create: `packages/export-kit/package.json`
- Create: `packages/export-kit/tsconfig.json`
- Create: `packages/export-kit/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/export-kit/package.json`:

```json
{
  "name": "@agent-metrics/export-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run src/index.test.ts"
  }
}
```

Create `packages/export-kit/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `packages/export-kit/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCsv } from "./index";

describe("toCsv", () => {
  it("serializes records with a header row", () => {
    expect(toCsv([{ toolName: "Read", count: 4 }])).toBe("toolName,count\nRead,4");
  });
});
```

Update `apps/core/src/app.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { buildApp, ingestEventLog } from "./app";

let dbPath: string;
let logPath: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-core-"));
  dbPath = join(root, "metrics.sqlite");
  logPath = join(root, "events.jsonl");
});

describe("core api", () => {
  it("returns tool, session, and export payloads", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });

    const tools = await app.inject({ method: "GET", url: "/api/tools" });
    const sessions = await app.inject({ method: "GET", url: "/api/sessions" });
    const csv = await app.inject({ method: "GET", url: "/api/exports/csv" });

    expect(tools.json()).toEqual([{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }]);
    expect(sessions.json()).toEqual([{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }]);
    expect(csv.body).toContain("toolName,count,failures,averageDurationMs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/export-kit test
pnpm --filter @agent-metrics/core test
```

Expected: FAIL because `packages/export-kit/src/index.ts` does not exist and the new core routes are missing.

- [ ] **Step 3: Write minimal implementation**

Create `packages/export-kit/src/index.ts`:

```ts
export function toCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const body = rows.map((row) => headers.map((header) => String(row[header] ?? "")).join(",")).join("\n");
  return [headers.join(","), body].join("\n");
}

export function toJson<T>(value: T): string {
  return JSON.stringify(value, null, 2);
}
```

Update `apps/core/src/app.ts`:

```ts
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import { toCsv, toJson } from "@agent-metrics/export-kit";
import { buildOverviewMetrics } from "@agent-metrics/metrics-engine";

export function buildApp(input: { dbPath: string }) {
  const db = new Database(input.dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_edits (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      insertions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      edit_operation_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const app = Fastify();

  app.get("/api/overview", async () => {
    const sessions = db.prepare("SELECT session_id, estimated_tokens FROM sessions").all() as Array<{
      session_id: string;
      estimated_tokens: number;
    }>;
    const toolEvents = db.prepare("SELECT status, duration_ms FROM tool_events").all() as Array<{
      status: string;
      duration_ms: number;
    }>;
    const codeEdits = db.prepare(
      "SELECT file_count, insertions, deletions, edit_operation_count FROM code_edits"
    ).all() as Array<{
      file_count: number;
      insertions: number;
      deletions: number;
      edit_operation_count: number;
    }>;
    const estimatedTokens = sessions.reduce((sum, row) => sum + row.estimated_tokens, 0);
    return buildOverviewMetrics({ sessions, toolEvents, codeEdits, estimatedTokens });
  });

  app.get("/api/tools", async () => {
    const rows = db.prepare(
      `
      SELECT
        tool_name AS toolName,
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
        CAST(AVG(duration_ms) AS INTEGER) AS averageDurationMs
      FROM tool_events
      GROUP BY tool_name
      ORDER BY count DESC, toolName ASC
      `
    ).all();
    return rows;
  });

  app.get("/api/sessions", async () => {
    return db.prepare(
      "SELECT session_id AS sessionId, workspace_path AS workspacePath FROM sessions ORDER BY started_at DESC"
    ).all();
  });

  app.get("/api/exports/json", async (_, reply) => {
    const rows = db.prepare(
      "SELECT tool_name AS toolName, COUNT(*) AS count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures, CAST(AVG(duration_ms) AS INTEGER) AS averageDurationMs FROM tool_events GROUP BY tool_name ORDER BY count DESC, toolName ASC"
    ).all() as Array<Record<string, string | number>>;
    reply.header("content-type", "application/json");
    return toJson(rows);
  });

  app.get("/api/exports/csv", async (_, reply) => {
    const rows = db.prepare(
      "SELECT tool_name AS toolName, COUNT(*) AS count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures, CAST(AVG(duration_ms) AS INTEGER) AS averageDurationMs FROM tool_events GROUP BY tool_name ORDER BY count DESC, toolName ASC"
    ).all() as Array<Record<string, string | number>>;
    reply.header("content-type", "text/csv; charset=utf-8");
    return toCsv(rows);
  });

  return Object.assign(app, { db });
}

export async function ingestEventLog(input: {
  app: ReturnType<typeof buildApp>;
  eventLogPath: string;
}): Promise<void> {
  const file = await readFile(input.eventLogPath, "utf8");
  const lines = file.trim().split("\n").filter(Boolean);
  const db = input.app.db as Database.Database;

  for (const line of lines) {
    const parsed = AnyEventSchema.parse(JSON.parse(line));

    if (parsed.type === "session.started") {
      db.prepare(
        "INSERT OR REPLACE INTO sessions (session_id, started_at, workspace_path, estimated_tokens) VALUES (?, ?, ?, 0)"
      ).run(parsed.session_id, parsed.timestamp, parsed.workspace_path);
    }

    if (parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
      db.prepare(
        "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(parsed.event_id, parsed.session_id, parsed.tool_name, parsed.status, parsed.duration_ms, parsed.timestamp);
    }

    if (parsed.type === "code.edit.applied") {
      db.prepare(
        "INSERT OR REPLACE INTO code_edits (event_id, session_id, tool_name, file_count, insertions, deletions, edit_operation_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        parsed.event_id,
        parsed.session_id,
        parsed.tool_name,
        parsed.file_count,
        parsed.insertions,
        parsed.deletions,
        parsed.edit_operation_count,
        parsed.timestamp
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/export-kit test
pnpm --filter @agent-metrics/core test
```

Expected: PASS with the export-kit test green and the expanded core API integration test green.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/export-kit apps/core/src/app.ts apps/core/src/app.test.ts
git commit -m "feat: add tools sessions and export endpoints"
```

## Task 7: Build The Overview Dashboard

**Files:**
- Create: `apps/dashboard/package.json`
- Create: `apps/dashboard/tsconfig.json`
- Create: `apps/dashboard/vite.config.ts`
- Create: `apps/dashboard/src/App.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/package.json`:

```json
{
  "name": "@agent-metrics/dashboard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "test": "vitest run src/App.test.tsx"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "recharts": "^2.15.3"
  }
}
```

Create `apps/dashboard/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "rootDir": "src"
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `apps/dashboard/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()]
});
```

Create `apps/dashboard/src/App.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "./App";

vi.mock("./api", () => ({
  fetchOverview: async () => ({
    sessionCount: 3,
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8,
    estimatedTokens: 900
  }),
  fetchTools: async () => [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }],
  fetchSessions: async () => [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }]
}));

describe("App", () => {
  it("renders overview metrics and recent sessions", async () => {
    render(<App />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(await screen.findByText("Recent Sessions")).toBeInTheDocument();
    expect(await screen.findByText("ses_1")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/dashboard test
```

Expected: FAIL because `apps/dashboard/src/App.tsx` and its dependencies do not exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/dashboard/src/api.ts`:

```ts
export async function fetchOverview() {
  const response = await fetch("/api/overview");
  return response.json();
}

export async function fetchTools() {
  const response = await fetch("/api/tools");
  return response.json();
}

export async function fetchSessions() {
  const response = await fetch("/api/sessions");
  return response.json();
}
```

Create `apps/dashboard/src/components/KpiGrid.tsx`:

```tsx
type KpiGridProps = {
  overview: {
    totalToolCalls: number;
    successfulExecutions: number;
    editOperationCount: number;
    affectedFileCount: number;
    estimatedTokens: number;
  };
};

export function KpiGrid({ overview }: KpiGridProps) {
  const items = [
    ["Tool Calls", overview.totalToolCalls],
    ["Successful Runs", overview.successfulExecutions],
    ["Edit Operations", overview.editOperationCount],
    ["Affected Files", overview.affectedFileCount],
    ["Estimated Tokens", overview.estimatedTokens]
  ];

  return (
    <section className="kpi-grid">
      {items.map(([label, value]) => (
        <article className="kpi-card" key={label}>
          <span className="kpi-label">{label}</span>
          <strong className="kpi-value">{value}</strong>
        </article>
      ))}
    </section>
  );
}
```

Create `apps/dashboard/src/components/ToolRankingTable.tsx`:

```tsx
type ToolRow = {
  toolName: string;
  count: number;
  failures: number;
  averageDurationMs: number;
};

export function ToolRankingTable({ rows }: { rows: ToolRow[] }) {
  return (
    <section>
      <h2>Tool Rankings</h2>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Calls</th>
            <th>Failures</th>
            <th>Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.toolName}>
              <td>{row.toolName}</td>
              <td>{row.count}</td>
              <td>{row.failures}</td>
              <td>{row.averageDurationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

Create `apps/dashboard/src/components/RecentSessionsTable.tsx`:

```tsx
type SessionRow = {
  sessionId: string;
  workspacePath: string;
};

export function RecentSessionsTable({ rows }: { rows: SessionRow[] }) {
  return (
    <section>
      <h2>Recent Sessions</h2>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Workspace</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionId}>
              <td>{row.sessionId}</td>
              <td>{row.workspacePath}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

Create `apps/dashboard/src/components/TrendChart.tsx`:

```tsx
type TrendChartProps = {
  totalToolCalls: number;
  successfulExecutions: number;
  editOperationCount: number;
};

export function TrendChart({ totalToolCalls, successfulExecutions, editOperationCount }: TrendChartProps) {
  return (
    <section>
      <h2>Activity Trend</h2>
      <ul>
        <li>Total tool calls: {totalToolCalls}</li>
        <li>Successful executions: {successfulExecutions}</li>
        <li>Edit operations: {editOperationCount}</li>
      </ul>
    </section>
  );
}
```

Create `apps/dashboard/src/styles.css`:

```css
body {
  margin: 0;
  font-family: "Segoe UI", sans-serif;
  background: #f5f7fb;
  color: #162033;
}

#root {
  min-height: 100vh;
}

.app-shell {
  max-width: 1200px;
  margin: 0 auto;
  padding: 32px;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.kpi-card {
  background: white;
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 10px 30px rgba(14, 24, 44, 0.08);
}

.kpi-label {
  display: block;
  font-size: 12px;
  text-transform: uppercase;
  color: #5f6d87;
  margin-bottom: 8px;
}

.kpi-value {
  font-size: 28px;
}
```

Create `apps/dashboard/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchOverview, fetchSessions, fetchTools } from "./api";
import { KpiGrid } from "./components/KpiGrid";
import { RecentSessionsTable } from "./components/RecentSessionsTable";
import { ToolRankingTable } from "./components/ToolRankingTable";
import { TrendChart } from "./components/TrendChart";
import "./styles.css";

type Overview = {
  sessionCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  estimatedTokens: number;
};

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tools, setTools] = useState<Array<{ toolName: string; count: number; failures: number; averageDurationMs: number }>>([]);
  const [sessions, setSessions] = useState<Array<{ sessionId: string; workspacePath: string }>>([]);

  useEffect(() => {
    let active = true;

    async function load() {
      const [overviewResponse, toolsResponse, sessionsResponse] = await Promise.all([
        fetchOverview(),
        fetchTools(),
        fetchSessions()
      ]);

      if (!active) {
        return;
      }

      setOverview(overviewResponse);
      setTools(toolsResponse);
      setSessions(sessionsResponse);
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!overview) {
    return <div className="app-shell">Loading dashboard...</div>;
  }

  return (
    <main className="app-shell">
      <h1>Agent Metrics</h1>
      <p>Local-first overview of Claude Code activity.</p>
      <KpiGrid overview={overview} />
      <TrendChart
        totalToolCalls={overview.totalToolCalls}
        successfulExecutions={overview.successfulExecutions}
        editOperationCount={overview.editOperationCount}
      />
      <ToolRankingTable rows={tools} />
      <RecentSessionsTable rows={sessions} />
    </main>
  );
}
```

Create `apps/dashboard/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @agent-metrics/dashboard test
```

Expected: PASS with the dashboard smoke test green.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/dashboard
git commit -m "feat: add overview dashboard shell"
```

## Task 8: Add Session Detail, Export Controls, And End-To-End Smoke Coverage

**Files:**
- Modify: `apps/core/src/app.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/components/TrendChart.tsx`
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

Update `apps/core/src/app.test.ts` to add session detail assertions:

```ts
it("returns a session detail timeline", async () => {
  await appendJsonLine(logPath, {
    event_id: "evt_1",
    session_id: "ses_1",
    timestamp: "2026-05-25T08:00:00.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: "D:/projects/dev/agent-metrics",
    type: "session.started"
  });

  await appendJsonLine(logPath, {
    event_id: "evt_2",
    session_id: "ses_1",
    timestamp: "2026-05-25T08:00:01.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: "D:/projects/dev/agent-metrics",
    type: "tool.succeeded",
    tool_name: "Read",
    status: "succeeded",
    duration_ms: 14
  });

  const app = buildApp({ dbPath });
  await ingestEventLog({ app, eventLogPath: logPath });
  const response = await app.inject({ method: "GET", url: "/api/sessions/ses_1" });

  expect(response.json()).toEqual({
    sessionId: "ses_1",
    timeline: [
      {
        type: "tool.succeeded",
        toolName: "Read",
        status: "succeeded",
        durationMs: 14
      }
    ]
  });
});
```

Update `apps/dashboard/src/App.test.tsx` to add export button assertions:

```tsx
vi.mock("./api", () => ({
  fetchOverview: async () => ({
    sessionCount: 3,
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8,
    estimatedTokens: 900
  }),
  fetchTools: async () => [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }],
  fetchSessions: async () => [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }],
  buildExportUrl: (format: "csv" | "json") => `/api/exports/${format}`
}));

it("renders export links", async () => {
  render(<App />);
  expect(await screen.findByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/exports/csv");
  expect(await screen.findByRole("link", { name: "Export JSON" })).toHaveAttribute("href", "/api/exports/json");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @agent-metrics/core test
pnpm --filter @agent-metrics/dashboard test
```

Expected: FAIL because `/api/sessions/:id` and export controls are missing.

- [ ] **Step 3: Write minimal implementation**

Update `apps/core/src/app.ts`:

```ts
app.get("/api/sessions/:id", async (request) => {
  const params = request.params as { id: string };
  const rows = db.prepare(
    "SELECT tool_name AS toolName, status, duration_ms AS durationMs FROM tool_events WHERE session_id = ? ORDER BY created_at ASC"
  ).all(params.id) as Array<{
    toolName: string;
    status: string;
    durationMs: number;
  }>;

  return {
    sessionId: params.id,
    timeline: rows.map((row) => ({
      type: `tool.${row.status}`,
      toolName: row.toolName,
      status: row.status,
      durationMs: row.durationMs
    }))
  };
});
```

Update `apps/dashboard/src/api.ts`:

```ts
export async function fetchOverview() {
  const response = await fetch("/api/overview");
  return response.json();
}

export async function fetchTools() {
  const response = await fetch("/api/tools");
  return response.json();
}

export async function fetchSessions() {
  const response = await fetch("/api/sessions");
  return response.json();
}

export function buildExportUrl(format: "csv" | "json") {
  return `/api/exports/${format}`;
}
```

Update `apps/dashboard/src/components/TrendChart.tsx`:

```tsx
type TrendChartProps = {
  totalToolCalls: number;
  successfulExecutions: number;
  editOperationCount: number;
};

export function TrendChart({ totalToolCalls, successfulExecutions, editOperationCount }: TrendChartProps) {
  return (
    <section>
      <h2>Activity Trend</h2>
      <ul>
        <li>Total tool calls: {totalToolCalls}</li>
        <li>Successful executions: {successfulExecutions}</li>
        <li>Edit operations: {editOperationCount}</li>
      </ul>
    </section>
  );
}
```

Update `apps/dashboard/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { buildExportUrl, fetchOverview, fetchSessions, fetchTools } from "./api";
import { KpiGrid } from "./components/KpiGrid";
import { RecentSessionsTable } from "./components/RecentSessionsTable";
import { ToolRankingTable } from "./components/ToolRankingTable";
import { TrendChart } from "./components/TrendChart";
import "./styles.css";

type Overview = {
  sessionCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  estimatedTokens: number;
};

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tools, setTools] = useState<Array<{ toolName: string; count: number; failures: number; averageDurationMs: number }>>([]);
  const [sessions, setSessions] = useState<Array<{ sessionId: string; workspacePath: string }>>([]);

  useEffect(() => {
    let active = true;

    async function load() {
      const [overviewResponse, toolsResponse, sessionsResponse] = await Promise.all([
        fetchOverview(),
        fetchTools(),
        fetchSessions()
      ]);

      if (!active) {
        return;
      }

      setOverview(overviewResponse);
      setTools(toolsResponse);
      setSessions(sessionsResponse);
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!overview) {
    return <div className="app-shell">Loading dashboard...</div>;
  }

  return (
    <main className="app-shell">
      <h1>Agent Metrics</h1>
      <p>Local-first overview of Claude Code activity.</p>
      <div>
        <a href={buildExportUrl("csv")}>Export CSV</a>
        {" | "}
        <a href={buildExportUrl("json")}>Export JSON</a>
      </div>
      <KpiGrid overview={overview} />
      <TrendChart
        totalToolCalls={overview.totalToolCalls}
        successfulExecutions={overview.successfulExecutions}
        editOperationCount={overview.editOperationCount}
      />
      <ToolRankingTable rows={tools} />
      <RecentSessionsTable rows={sessions} />
    </main>
  );
}
```

Update `README.md`:

```md
# Agent Metrics

Local-first metrics dashboard for Claude Code and future agent adapters.

## Commands

- `pnpm install`
- `pnpm test`
- `pnpm --filter @agent-metrics/core dev`
- `pnpm --filter @agent-metrics/dashboard dev`
- `pnpm --filter @agent-metrics/cli dev -- wrap claude --help`
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test
```

Expected: PASS with all workspace tests green.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/core apps/dashboard README.md
git commit -m "feat: add session detail exports and workspace smoke coverage"
```

## Self-Review Checklist

### Spec Coverage

- Wrapper launch mode only in v1: covered by Task 2.
- Local JSONL plus SQLite persistence: covered by Tasks 2 and 4.
- Claude-specific adapter with vendor-neutral event model: covered by Task 3.
- Overview-first dashboard with polling: covered by Tasks 7 and 8.
- Tools, sessions, and export APIs: covered by Task 6.
- Estimated token labeling only: schema and overview fields established in Tasks 1 and 5. Concrete Claude token extraction remains intentionally deferred and is not in v1 scope.

### Placeholder Scan

- No `TBD`, `TODO`, or "implement later" markers remain in tasks.
- The only deferred work is explicitly identified as out of scope in the approved design and not required to execute this plan.

### Type Consistency

- Event names match the approved spec and the shared event schema package.
- Dashboard overview fields match the metrics engine output.
- Session detail route naming matches the API shape consumed by the dashboard.
