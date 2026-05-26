# Claude Hooks Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Claude hooks ingress from normalized event generation by introducing a raw-to-normalized parser bus, while preserving the existing dashboard and edit metrics behavior.

**Architecture:** Keep Claude hooks as the only ingress path, but stop using the collector as a direct normalized-event writer. The collector will write raw hook envelopes plus time-sensitive snapshot sidecars for known mutating tools; a new parser command will consume raw + sidecar state, dedupe and correlate events, and then write `data/events/events.jsonl` for `apps/core`.

**Tech Stack:** Node.js, TypeScript, Commander, Fastify, React, Vite, Vitest, PowerShell, JSONL, SQLite.

---

## Scope Boundary

This plan implements only the approved phase 2 bus decomposition from [`docs/superpowers/specs/2026-05-26-claude-hooks-design.md`](D:/projects/dev/agent-metrics/docs/superpowers/specs/2026-05-26-claude-hooks-design.md).

In scope:

- raw ingress and normalized pipeline decoupling
- parser checkpointing and dedupe
- parser-owned normalized event emission
- startup orchestration for a local parser worker

Out of scope:

- OTel ingestion
- transcript mining
- precise token/cost attribution
- team deployment

## File Map

### Create

- `apps/cli/src/hooks/parse.ts`
  Registers and implements `hooks parse` commands for one-shot and follow modes.
- `apps/cli/src/hooks/parse.test.ts`
  End-to-end parser tests covering raw replay, dedupe, and edit-event generation.
- `apps/cli/src/hooks/raw-envelope.ts`
  Defines the raw envelope shape written by ingress and consumed by the parser.
- `apps/cli/src/hooks/parser-state.ts`
  Persists parser checkpoints, processed raw ids, and pending mutation state.
- `apps/cli/src/hooks/parser.ts`
  Converts raw envelopes into normalized events and emits them to `data/events/events.jsonl`.
- `apps/cli/src/hooks/follow.ts`
  Small polling loop used by `hooks parse --follow`.
- `docs/manual/phase2-parser-flow.md`
  Operator notes for local parser lifecycle and recovery.

### Modify

- `apps/cli/src/hooks/register.ts`
  Add `parse` subcommands.
- `apps/cli/src/hooks/collect.ts`
  Stop writing normalized events directly; write raw envelopes and snapshot sidecars only.
- `apps/cli/src/hooks/collect.test.ts`
  Update phase 1 collector tests into raw-ingress assertions.
- `apps/cli/src/hooks/paths.ts`
  Add parser checkpoint/state paths.
- `apps/cli/src/hooks/snapshots.ts`
  Reframe snapshots as ingress sidecars consumed by the parser.
- `packages/adapters-claude/src/hooks.ts`
  Add raw-envelope builders and parser-facing helpers without changing hook payload parsing behavior.
- `packages/adapters-claude/src/hooks.test.ts`
  Cover raw-envelope metadata and stable ids.
- `apps/core/src/app.test.ts`
  Keep normalized contract stable while verifying parser-generated data is accepted unchanged.
- `apps/cli/src/index.test.ts`
  Assert `hooks parse` appears in CLI surface.
- `start-agent-metrics.ps1`
  Start the parser follow loop together with API and dashboard.
- `README.md`
  Rewrite runtime docs around ingress + parser instead of single-writer collector.

---

### Task 1: Add Parser Commands and Bus State Paths

**Files:**
- Create: `apps/cli/src/hooks/parse.ts`
- Create: `apps/cli/src/hooks/follow.ts`
- Modify: `apps/cli/src/hooks/register.ts`
- Modify: `apps/cli/src/hooks/paths.ts`
- Modify: `apps/cli/src/index.test.ts`
- Test: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Write the failing CLI test**

```ts
it("registers hooks parse commands", () => {
  const program = buildProgram();
  const hooks = program.commands.find((command) => command.name() === "hooks");

  expect(hooks?.commands.map((command) => command.name())).toContain("parse");
});
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/index.test.ts
```

Expected: FAIL because `hooks parse` does not exist.

- [ ] **Step 3: Add parser command registration and state paths**

```ts
export function registerHooksCommands(program: Command): void {
  const hooks = program.command("hooks");

  registerCollectCommand(hooks);
  registerInstallCommand(hooks);
  registerPrintConfigCommand(hooks);
  registerParseCommand(hooks);
}
```

```ts
export function getHookPaths(repoRoot: string) {
  return {
    rawHookLogPath: join(repoRoot, "data", "hooks", "raw", "claude-code.jsonl"),
    eventLogPath: join(repoRoot, "data", "events", "events.jsonl"),
    snapshotRoot: join(repoRoot, "data", "hooks", "snapshots"),
    parserStatePath: join(repoRoot, "data", "hooks", "state", "parser-state.json"),
    parserSeenPath: join(repoRoot, "data", "hooks", "state", "seen-raw-ids.json")
  };
}
```

- [ ] **Step 4: Run the CLI test to verify it passes**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/index.test.ts
```

Expected: PASS with `hooks parse` visible.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/hooks/register.ts apps/cli/src/hooks/parse.ts apps/cli/src/hooks/follow.ts apps/cli/src/hooks/paths.ts apps/cli/src/index.test.ts
git commit -m "feat: add phase2 parser command surface"
```

### Task 2: Convert the Collector Into Raw Ingress Plus Snapshot Sidecars

**Files:**
- Create: `apps/cli/src/hooks/raw-envelope.ts`
- Modify: `apps/cli/src/hooks/collect.ts`
- Modify: `apps/cli/src/hooks/collect.test.ts`
- Modify: `apps/cli/src/hooks/snapshots.ts`
- Modify: `packages/adapters-claude/src/hooks.ts`
- Modify: `packages/adapters-claude/src/hooks.test.ts`
- Test: `apps/cli/src/hooks/collect.test.ts`
- Test: `packages/adapters-claude/src/hooks.test.ts`

- [ ] **Step 1: Write the failing ingress tests**

```ts
it("writes raw envelopes without appending normalized events", async () => {
  await handleHookEvent({
    repoRoot,
    payload: {
      session_id: "ses_1",
      cwd: repoRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "tool_raw_1",
      tool_input: { file_path: "README.md" }
    }
  });

  const rawLines = await readJsonLines(paths.rawHookLogPath);
  const eventFile = await tryReadFile(paths.eventLogPath);

  expect(rawLines).toHaveLength(1);
  expect(rawLines[0]).toMatchObject({
    hook_event_name: "PreToolUse",
    raw_event_id: expect.any(String)
  });
  expect(eventFile).toBeNull();
});
```

```ts
it("captures snapshot sidecars for Bash rm targets during PreToolUse", async () => {
  expect(
    extractMutationTargets({
      toolName: "Bash",
      toolInput: { command: "rm src/app.ts" }
    })
  ).toEqual(["src/app.ts"]);
});
```

- [ ] **Step 2: Run the ingress tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-claude exec vitest run src/hooks.test.ts
corepack pnpm --filter @agent-metrics/cli test
```

Expected: FAIL because the collector still appends normalized events.

- [ ] **Step 3: Build and persist a raw envelope**

```ts
export type ClaudeRawEnvelope = {
  raw_event_id: string;
  captured_at: string;
  hook_event_name: string;
  session_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  workspace_path?: string;
  transcript_path?: string;
  payload: ClaudeHookPayload;
};

export function buildClaudeRawEnvelope(payload: ClaudeHookPayload): ClaudeRawEnvelope {
  return {
    raw_event_id: randomUUID(),
    captured_at: new Date().toISOString(),
    hook_event_name: payload.hook_event_name ?? "unknown",
    session_id: payload.session_id,
    tool_use_id: payload.tool_use_id,
    tool_name: payload.tool_name,
    workspace_path: payload.cwd,
    transcript_path: readTranscriptPath(payload),
    payload
  };
}
```

```ts
const rawEnvelope = buildClaudeRawEnvelope(normalizedPayload);
await appendJsonLine(paths.rawHookLogPath, rawEnvelope);
```

- [ ] **Step 4: Keep snapshot capture in ingress, but remove normalized writes**

```ts
export async function handleHookEvent(input: {
  repoRoot: string;
  payload: ClaudeHookPayload;
}): Promise<void> {
  const paths = getHookPaths(input.repoRoot);
  const workspacePath = normalizeWorkspacePath(input.payload.cwd, input.repoRoot);
  const normalizedPayload = withWorkspacePath(input.payload, workspacePath);

  await appendJsonLine(paths.rawHookLogPath, buildClaudeRawEnvelope(normalizedPayload));

  if (normalizedPayload.hook_event_name === "PreToolUse") {
    await maybeCaptureBeforeSnapshots({
      payload: normalizedPayload,
      snapshotRoot: paths.snapshotRoot,
      workspacePath
    });
  }

  if (normalizedPayload.hook_event_name === "PostToolUseFailure") {
    await discardSnapshots({
      snapshotRoot: paths.snapshotRoot,
      toolUseId: normalizedPayload.tool_use_id
    });
  }
}
```

- [ ] **Step 5: Run the ingress tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-claude exec vitest run src/hooks.test.ts
corepack pnpm --filter @agent-metrics/cli test
```

Expected: PASS with collector now acting as ingress only.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/hooks/raw-envelope.ts apps/cli/src/hooks/collect.ts apps/cli/src/hooks/collect.test.ts apps/cli/src/hooks/snapshots.ts packages/adapters-claude/src/hooks.ts packages/adapters-claude/src/hooks.test.ts
git commit -m "refactor: convert hook collector into raw ingress"
```

### Task 3: Implement the Raw-to-Normalized Parser Bus

**Files:**
- Create: `apps/cli/src/hooks/parser.ts`
- Create: `apps/cli/src/hooks/parser-state.ts`
- Create: `apps/cli/src/hooks/parse.test.ts`
- Modify: `packages/adapters-claude/src/index.ts`
- Test: `apps/cli/src/hooks/parse.test.ts`
- Test: `apps/core/src/app.test.ts`

- [ ] **Step 1: Write the failing parser test**

```ts
it("replays raw envelopes into normalized events and dedupes on rerun", async () => {
  await appendJsonLine(paths.rawHookLogPath, preToolEnvelope);
  await appendJsonLine(paths.rawHookLogPath, postToolEnvelope);

  await parseRawHooksOnce({ repoRoot });
  await parseRawHooksOnce({ repoRoot });

  const eventLines = await readJsonLines(paths.eventLogPath);

  expect(eventLines.map((line) => line.type)).toEqual([
    "tool.called",
    "tool.succeeded",
    "code.edit.applied"
  ]);
});
```

- [ ] **Step 2: Run the parser test to verify it fails**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/hooks/parse.test.ts
```

Expected: FAIL because no parser exists yet.

- [ ] **Step 3: Persist parser checkpoint and seen-raw ids**

```ts
export type ParserState = {
  nextLine: number;
  seenRawEventIds: string[];
};

export async function loadParserState(statePath: string): Promise<ParserState> {
  return (await readJsonFile(statePath)) ?? { nextLine: 0, seenRawEventIds: [] };
}

export async function saveParserState(statePath: string, state: ParserState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}
```

- [ ] **Step 4: Normalize raw envelopes in parser-owned code**

```ts
export async function parseRawHooksOnce(input: { repoRoot: string }): Promise<void> {
  const paths = getHookPaths(input.repoRoot);
  const state = await loadParserState(paths.parserStatePath);
  const rawLines = await readJsonLines(paths.rawHookLogPath);
  const pending = rawLines.slice(state.nextLine);

  for (const line of pending) {
    if (state.seenRawEventIds.includes(line.raw_event_id)) {
      continue;
    }

    const normalized = normalizeClaudeHookEvent(line.payload);
    if (normalized !== null) {
      await appendJsonLine(paths.eventLogPath, normalized);
    }

    if (line.payload.hook_event_name === "PostToolUse") {
      const changedFiles = await collectChangedSnapshots({
        snapshotRoot: paths.snapshotRoot,
        toolUseId: line.payload.tool_use_id
      });

      if (changedFiles.length > 0) {
        await appendJsonLine(
          paths.eventLogPath,
          normalizeClaudeObservation({
            sessionId: line.payload.session_id ?? "unknown-session",
            workspacePath: line.payload.cwd ?? input.repoRoot,
            observation: {
              kind: "edit_applied",
              toolName: line.payload.tool_name ?? "unknown",
              files: changedFiles
            }
          })
        );
      }
    }

    state.seenRawEventIds.push(line.raw_event_id);
    state.nextLine += 1;
  }

  await saveParserState(paths.parserStatePath, state);
}
```

- [ ] **Step 5: Add follow mode for local runtime**

```ts
export async function followRawHooks(input: {
  repoRoot: string;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  while (!input.signal?.aborted) {
    await parseRawHooksOnce({ repoRoot: input.repoRoot });
    await delay(input.pollIntervalMs);
  }
}
```

- [ ] **Step 6: Run parser and core tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/cli exec vitest run src/hooks/parse.test.ts
corepack pnpm --filter @agent-metrics/core exec vitest run src/app.test.ts
```

Expected: PASS with parser-generated normalized events accepted by core unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/hooks/parser.ts apps/cli/src/hooks/parser-state.ts apps/cli/src/hooks/parse.ts apps/cli/src/hooks/parse.test.ts apps/cli/src/hooks/follow.ts packages/adapters-claude/src/index.ts
git commit -m "feat: add raw-to-normalized parser bus"
```

### Task 4: Orchestrate Local Runtime, Docs, and Recovery

**Files:**
- Create: `docs/manual/phase2-parser-flow.md`
- Modify: `start-agent-metrics.ps1`
- Modify: `README.md`
- Test: full workspace verification

- [ ] **Step 1: Write the failing startup expectation**

```md
When `.\start-agent-metrics.ps1` completes, three local processes should exist:
1. parser follow loop
2. API server
3. dashboard dev server
```

- [ ] **Step 2: Start parser follow mode from the local startup script**

```powershell
$parser = Start-Process `
  -FilePath "node" `
  -ArgumentList @(".\apps\cli\dist\index.js", "hooks", "parse", "--follow", "--repo-root", $repoRoot) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -PassThru
```

```powershell
Write-Host "Parser:  running raw hook bus -> normalized events"
Write-Host "API:     http://127.0.0.1:4318/api/overview"
Write-Host "UI:      http://127.0.0.1:4173"
```

- [ ] **Step 3: Update README and operator notes**

```md
## Runtime model

- Claude hooks append raw envelopes to `data/hooks/raw/claude-code.jsonl`
- `agent-metrics hooks parse --follow` converts raw envelopes into normalized events
- `apps/core` ingests `data/events/events.jsonl`
- `apps/dashboard` reads the API

## Recovery

If normalized output lags behind raw hooks:

1. Stop the parser
2. Delete `data/hooks/state/parser-state.json`
3. Re-run `agent-metrics hooks parse --repo-root <repo>`
4. Restart `.\start-agent-metrics.ps1`
```

- [ ] **Step 4: Run full project verification**

Run:

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm lint
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1 -NoBrowser
```

Expected:

- `test`: PASS for CLI, adapters, core, dashboard, metrics-engine, export-kit, event-schema, shared-utils
- `build`: PASS for all workspaces
- `lint`: PASS with no TypeScript errors
- startup script: prints parser/API/UI status and keeps all local services running

- [ ] **Step 5: Commit**

```bash
git add start-agent-metrics.ps1 README.md docs/manual/phase2-parser-flow.md
git commit -m "docs: document and start the phase2 hook bus"
```

## Self-Review

- Spec coverage:
  - raw ingress vs normalized pipeline split: Tasks 2-3
  - parser as standardization entrypoint: Task 3
  - keep phase 1 behavior visible in dashboard/core: Task 3 and Task 4
  - local runtime and recovery: Task 4
- Placeholder scan:
  - no `TODO`, `TBD`, or "similar to Task N" shortcuts
  - each task names exact files and exact verification commands
- Type consistency:
  - ingress owns `ClaudeRawEnvelope`
  - parser owns normalized emission
  - `apps/core` and `apps/dashboard` continue consuming the same normalized contract
