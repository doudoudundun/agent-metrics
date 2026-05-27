# Claude Transcript Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local Claude Code transcript ingestion so `agent-metrics` can report token usage and surface pure chat sessions that contain no tool calls or code edits.

**Architecture:** Keep the existing hooks pipeline for session, tool, and edit telemetry, then add a second transcript ingestion path that incrementally reads Claude JSONL transcripts, deduplicates prompt/assistant/usage records, and appends normalized events into the existing event log. Extend the SQLite-backed core API to aggregate prompt, response, and token data, then update the dashboard to show total tokens, turn counts, richer session summaries, and a turn-aware session timeline.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Fastify, better-sqlite3, React 19, Vitest, Testing Library, PowerShell

---

## File Structure

- Create: `packages/shared-utils/src/agent-paths.ts`
  - Shared path resolver for `data/hooks/*` and `data/events/*` so CLI and core agree on transcript manifest, cursor, and ledger locations.
- Create: `packages/shared-utils/src/agent-paths.test.ts`
  - Verifies the shared repo-relative data path contract.
- Modify: `packages/shared-utils/src/index.ts`
  - Re-export the shared path helper.
- Modify: `apps/cli/src/hooks/paths.ts`
  - Delegate to the shared path helper instead of owning the path contract locally.
- Modify: `packages/event-schema/src/index.ts`
  - Add `prompt.submitted`, `assistant.responded`, and `token.usage.recorded` schemas and types.
- Modify: `packages/event-schema/src/index.test.ts`
  - Validate the new event types.
- Create: `packages/adapters-claude/src/transcript.ts`
  - Stateless Claude transcript row parsing and normalization helpers.
- Create: `packages/adapters-claude/src/transcript.test.ts`
  - Coverage for user prompt, assistant response, and token usage normalization.
- Create: `packages/adapters-claude/src/transcript-sync.ts`
  - Incremental transcript manifest/cursor/ledger sync helpers that append normalized events into `data/events/events.jsonl`.
- Create: `packages/adapters-claude/src/transcript-sync.test.ts`
  - Coverage for manifest registration, byte-offset catch-up, duplicate assistant messages, and rerun idempotence.
- Modify: `packages/adapters-claude/src/index.ts`
  - Export the transcript helpers.
- Modify: `apps/cli/src/hooks/collect.ts`
  - Record known transcript paths when hook payloads expose `transcript_path`.
- Modify: `apps/cli/src/hooks/collect.test.ts`
  - Verify transcript manifest registration from hook ingestion.
- Modify: `apps/cli/src/hooks/parser.ts`
  - Trigger transcript catch-up for hook-driven low-latency updates.
- Modify: `apps/cli/src/hooks/parse.test.ts`
  - Verify parse flow appends prompt/assistant/token events only once.
- Modify: `packages/metrics-engine/src/index.ts`
  - Extend overview aggregation to include turn and token totals.
- Modify: `packages/metrics-engine/src/index.test.ts`
  - Validate token math and zero-tool success-rate behavior after new counters are added.
- Modify: `apps/core/package.json`
  - Add `@agent-metrics/adapters-claude` dependency for API-read transcript catch-up.
- Modify: `apps/core/src/app.ts`
  - Create new SQLite tables, ingest the new events, run transcript catch-up before aggregate reads, and expose token-aware overview/session APIs.
- Modify: `apps/core/src/app.test.ts`
  - End-to-end API coverage for pure chat sessions, token totals, session summaries, and mixed timelines.
- Modify: `apps/core/src/server.ts`
  - Pass the repo root into `buildApp` so API-read catch-up can find manifest/cursor files.
- Modify: `apps/dashboard/src/api.ts`
  - Add token-aware overview and session types, plus model usage payloads.
- Modify: `apps/dashboard/src/api.test.ts`
  - Validate the expanded aggregate contract.
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`
  - Show `Total Tokens` and `Turns` without adding cost fields.
- Create: `apps/dashboard/src/components/RecentSessionsTable.test.tsx`
  - Verify tokens, turns, and last model columns render.
- Modify: `apps/dashboard/src/components/RecentSessionsTable.tsx`
  - Add token/turn/model summary columns.
- Modify: `apps/dashboard/src/components/SessionTimelinePanel.tsx`
  - Render prompt, assistant, token, and tool rows in one paginated timeline.
- Modify: `apps/dashboard/src/components/SessionTimelinePanel.test.tsx`
  - Verify token and model metadata display in the timeline.
- Create: `apps/dashboard/src/components/ModelUsagePanel.tsx`
  - Secondary model-level token breakdown for the second delivery slice.
- Create: `apps/dashboard/src/components/ModelUsagePanel.test.tsx`
  - Verify descending token totals and unknown-model fallback.
- Modify: `apps/dashboard/src/App.tsx`
  - Load token-rich overview/session data and render the secondary model panel.
- Modify: `apps/dashboard/src/App.test.tsx`
  - Verify total token KPI, pure chat visibility, and model breakdown rendering.
- Modify: `apps/dashboard/src/styles.css`
  - Support the denser KPI and table/timeline layouts.
- Modify: `README.md`
  - Document transcript-reported usage, the no-cost scope, and how pure chat sessions appear.

### Task 1: Share the Repo Data Path Contract

**Files:**
- Create: `packages/shared-utils/src/agent-paths.ts`
- Create: `packages/shared-utils/src/agent-paths.test.ts`
- Modify: `packages/shared-utils/src/index.ts`
- Modify: `apps/cli/src/hooks/paths.ts`

- [ ] **Step 1: Write the failing shared path tests**

Create `packages/shared-utils/src/agent-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getAgentMetricsPaths } from "./agent-paths.js";

describe("getAgentMetricsPaths", () => {
  it("returns the full hook, event, and transcript state layout", () => {
    const paths = getAgentMetricsPaths("D:/projects/dev/agent-metrics");

    expect(paths.rawHookLogPath).toBe("D:/projects/dev/agent-metrics/data/hooks/raw/claude-code.jsonl");
    expect(paths.eventLogPath).toBe("D:/projects/dev/agent-metrics/data/events/events.jsonl");
    expect(paths.transcriptManifestPath).toBe(
      "D:/projects/dev/agent-metrics/data/hooks/state/transcript-manifest.json"
    );
    expect(paths.transcriptCursorPath).toBe(
      "D:/projects/dev/agent-metrics/data/hooks/state/transcript-cursors.json"
    );
    expect(paths.transcriptLedgerPath).toBe(
      "D:/projects/dev/agent-metrics/data/hooks/state/transcript-ledger.json"
    );
  });
});
```

- [ ] **Step 2: Run the shared-utils tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/shared-utils test
```

Expected: FAIL because `src/agent-paths.ts` does not exist yet.

- [ ] **Step 3: Implement the shared path helper and re-export it**

Create `packages/shared-utils/src/agent-paths.ts`:

```ts
import { join } from "node:path";

export type AgentMetricsPaths = {
  rawHookLogPath: string;
  eventLogPath: string;
  snapshotRoot: string;
  parserStatePath: string;
  parserSeenPath: string;
  transcriptManifestPath: string;
  transcriptCursorPath: string;
  transcriptLedgerPath: string;
};

export function getAgentMetricsPaths(repoRoot: string): AgentMetricsPaths {
  return {
    rawHookLogPath: join(repoRoot, "data", "hooks", "raw", "claude-code.jsonl"),
    eventLogPath: join(repoRoot, "data", "events", "events.jsonl"),
    snapshotRoot: join(repoRoot, "data", "hooks", "snapshots"),
    parserStatePath: join(repoRoot, "data", "hooks", "state", "parser-state.json"),
    parserSeenPath: join(repoRoot, "data", "hooks", "state", "seen-raw-ids.json"),
    transcriptManifestPath: join(repoRoot, "data", "hooks", "state", "transcript-manifest.json"),
    transcriptCursorPath: join(repoRoot, "data", "hooks", "state", "transcript-cursors.json"),
    transcriptLedgerPath: join(repoRoot, "data", "hooks", "state", "transcript-ledger.json")
  };
}
```

Update `packages/shared-utils/src/index.ts` to export `./agent-paths.js`.

Replace the body of `apps/cli/src/hooks/paths.ts` with:

```ts
export { getAgentMetricsPaths as getHookPaths } from "@agent-metrics/shared-utils";
```

- [ ] **Step 4: Run the shared-utils and CLI hook tests again**

Run:

```powershell
corepack pnpm --filter @agent-metrics/shared-utils test
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/collect.test.ts src/hooks/parse.test.ts
```

Expected: PASS, with the CLI continuing to resolve the same raw hook and snapshot paths while gaining the transcript state paths.

- [ ] **Step 5: Commit the shared path contract**

```powershell
git add packages/shared-utils/src/agent-paths.ts packages/shared-utils/src/agent-paths.test.ts packages/shared-utils/src/index.ts apps/cli/src/hooks/paths.ts
git commit -m "refactor(shared): centralize agent metrics data paths"
```

### Task 2: Add Transcript Event Schemas and Stateless Claude Transcript Normalization

**Files:**
- Modify: `packages/event-schema/src/index.ts`
- Modify: `packages/event-schema/src/index.test.ts`
- Create: `packages/adapters-claude/src/transcript.ts`
- Create: `packages/adapters-claude/src/transcript.test.ts`
- Modify: `packages/adapters-claude/src/index.ts`

- [ ] **Step 1: Write failing schema and transcript-normalizer tests**

Append to `packages/event-schema/src/index.test.ts`:

```ts
it("parses a prompt.submitted event", () => {
  const result = AnyEventSchema.safeParse({
    event_id: "evt_prompt",
    session_id: "ses_1",
    timestamp: "2026-05-27T10:00:00.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: "D:/projects/dev/agent-metrics",
    type: "prompt.submitted",
    prompt_id: "prompt_1",
    prompt_chars: 42
  });

  expect(result.success).toBe(true);
});

it("parses a token.usage.recorded event", () => {
  const result = AnyEventSchema.safeParse({
    event_id: "evt_usage",
    session_id: "ses_1",
    timestamp: "2026-05-27T10:00:10.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: "D:/projects/dev/agent-metrics",
    type: "token.usage.recorded",
    message_id: "msg_1",
    model: "sonnet-test",
    input_tokens: 120,
    output_tokens: 48,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 16,
    server_tool_use: "{\"web_search_requests\":0}",
    usage_source: "claude-transcript"
  });

  expect(result.success).toBe(true);
});
```

Create `packages/adapters-claude/src/transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractClaudeTranscriptObservations } from "./transcript.js";

describe("extractClaudeTranscriptObservations", () => {
  it("maps a user transcript row into one prompt observation", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "user",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      promptId: "prompt_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      message: {
        role: "user",
        content: "Explain why this build failed"
      }
    });

    expect(observations).toEqual([
      expect.objectContaining({
        kind: "prompt_submitted",
        sessionId: "ses_1",
        promptId: "prompt_1",
        promptChars: 27
      })
    ]);
  });

  it("emits assistant response and usage observations for a terminal assistant row", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "assistant",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "sonnet-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Here is the fix." }],
        usage: {
          input_tokens: 120,
          output_tokens: 48,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 16,
          server_tool_use: { web_search_requests: 0 }
        }
      }
    });

    expect(observations.map((entry) => entry.kind)).toEqual([
      "assistant_responded",
      "token_usage_recorded"
    ]);
  });
});
```

- [ ] **Step 2: Run the package tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/event-schema test
corepack pnpm --filter @agent-metrics/adapters-claude test
```

Expected: FAIL because the new event types and transcript helpers are not implemented yet.

- [ ] **Step 3: Implement the new event schemas and transcript normalization helpers**

Extend `packages/event-schema/src/index.ts` with:

```ts
export const PromptSubmittedEventSchema = BaseEventSchema.extend({
  type: z.literal("prompt.submitted"),
  prompt_id: z.string().min(1),
  prompt_chars: z.number().int().nonnegative()
});

export const AssistantRespondedEventSchema = BaseEventSchema.extend({
  type: z.literal("assistant.responded"),
  message_id: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  stop_reason: z.string().min(1).nullable().optional(),
  response_chars: z.number().int().nonnegative()
});

export const TokenUsageRecordedEventSchema = BaseEventSchema.extend({
  type: z.literal("token.usage.recorded"),
  message_id: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  server_tool_use: z.string().default("{}"),
  usage_source: z.literal("claude-transcript")
});
```

Create `packages/adapters-claude/src/transcript.ts` with three pieces:

```ts
import { randomUUID } from "node:crypto";
import type { AnyEvent } from "@agent-metrics/event-schema";

export type ClaudeTranscriptObservation =
  | { kind: "prompt_submitted"; sessionId: string; workspacePath: string; timestamp: string; promptId: string; promptChars: number }
  | { kind: "assistant_responded"; sessionId: string; workspacePath: string; timestamp: string; messageId: string; model: string | null; stopReason: string | null; responseChars: number }
  | { kind: "token_usage_recorded"; sessionId: string; workspacePath: string; timestamp: string; messageId: string; model: string | null; inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; serverToolUse: string };

export function extractClaudeTranscriptObservations(record: unknown): ClaudeTranscriptObservation[] {
  // Normalize one raw JSONL row into zero, one, or two observations.
}

export function normalizeClaudeTranscriptObservation(observation: ClaudeTranscriptObservation): AnyEvent {
  // Build BaseEvent fields and map each observation kind to the new schemas.
}
```

Implementation rules:

- user rows emit `prompt_submitted`
- assistant rows emit `assistant_responded` only when they have a stable message id and a terminal-style message body
- assistant rows emit `token_usage_recorded` when `message.usage` exists
- convert structured content arrays into plain text before counting `prompt_chars` or `response_chars`
- serialize `server_tool_use` as a compact JSON string so the event log stays line-oriented

Update `packages/adapters-claude/src/index.ts` to export `./transcript.js`.

- [ ] **Step 4: Run the schema and adapter tests again**

Run:

```powershell
corepack pnpm --filter @agent-metrics/event-schema test
corepack pnpm --filter @agent-metrics/adapters-claude test
```

Expected: PASS, with the new event types accepted by Zod and transcript rows mapping into normalized observations.

- [ ] **Step 5: Commit the schema and stateless transcript adapter**

```powershell
git add packages/event-schema/src/index.ts packages/event-schema/src/index.test.ts packages/adapters-claude/src/transcript.ts packages/adapters-claude/src/transcript.test.ts packages/adapters-claude/src/index.ts
git commit -m "feat(claude): add transcript usage event normalization"
```

### Task 3: Build Incremental Transcript Sync and Wire It Into the Hook Parser

**Files:**
- Create: `packages/adapters-claude/src/transcript-sync.ts`
- Create: `packages/adapters-claude/src/transcript-sync.test.ts`
- Modify: `packages/adapters-claude/src/index.ts`
- Modify: `apps/cli/src/hooks/collect.ts`
- Modify: `apps/cli/src/hooks/collect.test.ts`
- Modify: `apps/cli/src/hooks/parser.ts`
- Modify: `apps/cli/src/hooks/parse.test.ts`

- [ ] **Step 1: Write failing transcript-sync tests**

Create `packages/adapters-claude/src/transcript-sync.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getAgentMetricsPaths } from "@agent-metrics/shared-utils";
import { recordClaudeTranscriptReference, syncKnownClaudeTranscripts } from "./transcript-sync.js";

describe("syncKnownClaudeTranscripts", () => {
  it("appends prompt, assistant, and token events once for one transcript message", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-"));
    const paths = getAgentMetricsPaths(repoRoot);
    const transcriptPath = join(repoRoot, "session.jsonl");

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          sessionId: "ses_1",
          cwd: repoRoot,
          promptId: "prompt_1",
          timestamp: "2026-05-27T10:00:00.000Z",
          message: { role: "user", content: "hello" }
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "ses_1",
          cwd: repoRoot,
          timestamp: "2026-05-27T10:00:01.000Z",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "sonnet-test",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "world" }],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 1,
              server_tool_use: { web_search_requests: 0 }
            }
          }
        })
      ].join("\n") + "\n",
      "utf8"
    );

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_1"
    });

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath
    });
    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath
    });

    const lines = (await readFile(paths.eventLogPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
  });
});
```

Extend `apps/cli/src/hooks/collect.test.ts` with one assertion that `handleHookEvent()` registers `transcript_path` into the manifest when present.

Extend `apps/cli/src/hooks/parse.test.ts` so the event log contains:

```ts
expect(eventLines.map((line) => line.type)).toEqual([
  "tool.called",
  "tool.succeeded",
  "code.edit.applied",
  "prompt.submitted",
  "assistant.responded",
  "token.usage.recorded"
]);
```

- [ ] **Step 2: Run the adapter and CLI tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/adapters-claude test
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/collect.test.ts src/hooks/parse.test.ts
```

Expected: FAIL because the manifest, cursor, ledger, and transcript catch-up flow do not exist yet.

- [ ] **Step 3: Implement manifest registration and byte-offset transcript catch-up**

Create `packages/adapters-claude/src/transcript-sync.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { extractClaudeTranscriptObservations, normalizeClaudeTranscriptObservation } from "./transcript.js";

export async function recordClaudeTranscriptReference(input: {
  manifestPath: string;
  transcriptPath: string;
  workspacePath: string;
  sessionId: string;
}): Promise<void> {
  // Upsert transcriptPath by absolute path so API-read catch-up knows which files to scan.
}

export async function syncKnownClaudeTranscripts(input: {
  manifestPath: string;
  eventLogPath: string;
  transcriptCursorPath: string;
  transcriptLedgerPath: string;
}): Promise<void> {
  // Load all known transcript references and call syncClaudeTranscriptPath for each.
}
```

Implementation rules:

- manifest key is the absolute `transcriptPath`
- cursor file stores last consumed byte offset per transcript
- ledger file stores:
  - seen prompt keys
  - seen assistant message ids
  - seen token usage message ids
- when a transcript ends with a partial line, keep the cursor at the start of that partial line
- append new normalized events with `appendJsonLine()` only after dedupe passes

Update `apps/cli/src/hooks/collect.ts` so `handleHookEvent()` calls `recordClaudeTranscriptReference()` whenever `payload.transcript_path` is a non-empty string.

Update `apps/cli/src/hooks/parser.ts` so each parsed raw hook envelope with `transcript_path` also triggers `syncKnownClaudeTranscripts()` after raw hook normalization. Keep the existing tool/edit flow intact.

- [ ] **Step 4: Run the adapter and CLI tests again**

Run:

```powershell
corepack pnpm --filter @agent-metrics/adapters-claude test
corepack pnpm --filter @agent-metrics/cli test -- src/hooks/collect.test.ts src/hooks/parse.test.ts
```

Expected: PASS, with manifest registration, transcript catch-up, and rerun idempotence verified.

- [ ] **Step 5: Commit transcript sync and CLI wiring**

```powershell
git add packages/adapters-claude/src/transcript-sync.ts packages/adapters-claude/src/transcript-sync.test.ts packages/adapters-claude/src/index.ts apps/cli/src/hooks/collect.ts apps/cli/src/hooks/collect.test.ts apps/cli/src/hooks/parser.ts apps/cli/src/hooks/parse.test.ts
git commit -m "feat(cli): sync Claude transcripts into normalized events"
```

### Task 4: Extend Core Storage, Ingestion, and Aggregate APIs for Tokens and Turns

**Files:**
- Modify: `packages/metrics-engine/src/index.ts`
- Modify: `packages/metrics-engine/src/index.test.ts`
- Modify: `apps/core/package.json`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`
- Modify: `apps/core/src/server.ts`

- [ ] **Step 1: Write failing metrics-engine and core API tests**

Replace the metrics-engine expectation in `packages/metrics-engine/src/index.test.ts` with:

```ts
expect(
  buildOverviewMetrics({
    sessions: [{ session_id: "ses_1" }],
    toolEvents: [{ status: "succeeded", duration_ms: 12 }],
    codeEdits: [],
    prompts: [{ prompt_id: "prompt_1" }],
    responses: [{ message_id: "msg_1" }],
    tokenUsage: [
      {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1
      }
    ]
  })
).toMatchObject({
  turnCount: 1,
  responseCount: 1,
  totalTokens: 15,
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: 1,
  cacheCreationTokens: 0
});
```

Add one pure-chat API test to `apps/core/src/app.test.ts`:

```ts
it("returns token and turn totals for a session with no tool events", async () => {
  await appendJsonLine(logPath, {
    event_id: "evt_prompt",
    session_id: "ses_chat",
    timestamp: "2026-05-27T10:00:00.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: repoRoot,
    type: "prompt.submitted",
    prompt_id: "prompt_1",
    prompt_chars: 5
  });
  await appendJsonLine(logPath, {
    event_id: "evt_resp",
    session_id: "ses_chat",
    timestamp: "2026-05-27T10:00:01.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: repoRoot,
    type: "assistant.responded",
    message_id: "msg_1",
    model: "sonnet-test",
    stop_reason: "end_turn",
    response_chars: 5
  });
  await appendJsonLine(logPath, {
    event_id: "evt_usage",
    session_id: "ses_chat",
    timestamp: "2026-05-27T10:00:01.000Z",
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: repoRoot,
    type: "token.usage.recorded",
    message_id: "msg_1",
    model: "sonnet-test",
    input_tokens: 10,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1,
    server_tool_use: "{}",
    usage_source: "claude-transcript"
  });

  const response = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });
  expect(response.json()).toMatchObject({
    totalToolCalls: 0,
    turnCount: 1,
    responseCount: 1,
    totalTokens: 15
  });
});
```

- [ ] **Step 2: Run the metrics-engine and core tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/metrics-engine test
corepack pnpm --filter @agent-metrics/core test -- src/app.test.ts
```

Expected: FAIL because the core does not yet ingest or aggregate prompt/response/token rows.

- [ ] **Step 3: Implement the new tables, ingest paths, and aggregate API fields**

Update `packages/metrics-engine/src/index.ts` so `OverviewMetrics` adds:

```ts
turnCount: number;
responseCount: number;
totalTokens: number;
inputTokens: number;
outputTokens: number;
cacheReadTokens: number;
cacheCreationTokens: number;
```

Extend `apps/core/src/app.ts`:

```ts
CREATE TABLE IF NOT EXISTS prompt_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_responses (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT,
  stop_reason TEXT,
  response_chars INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, message_id)
);

CREATE TABLE IF NOT EXISTS token_usage_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  server_tool_use TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, message_id)
);
```

Then:

- add prompt/response/token queries to `selectOverviewRows()`
- insert new rows inside `ingestEventLog()`
- extend `/api/overview`
- extend `/api/sessions` with:
  - `turnCount`
  - `totalTokens`
  - `lastModel`
- extend `/api/sessions/:id` so it can later return prompt/assistant/token rows in timeline order

Update `apps/core/package.json` to depend on `@agent-metrics/adapters-claude`.

Update `apps/core/src/server.ts` so `buildApp()` receives:

```ts
repoRoot: fileURLToPath(new URL("../../..", import.meta.url))
```

and update `buildApp()` to run `syncKnownClaudeTranscripts()` before the existing event-log sync whenever `repoRoot` is available.

- [ ] **Step 4: Run the metrics-engine and core tests again**

Run:

```powershell
corepack pnpm --filter @agent-metrics/metrics-engine test
corepack pnpm --filter @agent-metrics/core test -- src/app.test.ts
```

Expected: PASS, with pure chat sessions contributing turns and tokens even when tool counts stay at zero.

- [ ] **Step 5: Commit the core token and turn aggregation slice**

```powershell
git add packages/metrics-engine/src/index.ts packages/metrics-engine/src/index.test.ts apps/core/package.json apps/core/src/app.ts apps/core/src/app.test.ts apps/core/src/server.ts
git commit -m "feat(core): aggregate transcript turns and token usage"
```

### Task 5: Update the Dashboard Homepage and Session List for Token Usage

**Files:**
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/api.test.ts`
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`
- Create: `apps/dashboard/src/components/RecentSessionsTable.test.tsx`
- Modify: `apps/dashboard/src/components/RecentSessionsTable.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/styles.css`

- [ ] **Step 1: Write failing dashboard API and rendering tests**

Append to `apps/dashboard/src/api.test.ts`:

```ts
it("accepts token-aware overview payloads", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionCount: 1,
        totalToolCalls: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        successRate: 0,
        editOperationCount: 0,
        affectedFileCount: 0,
        insertions: 0,
        deletions: 0,
        turnCount: 1,
        responseCount: 1,
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 1,
        cacheCreationTokens: 0,
        mode: "calendar",
        range: "day",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-26T16:00:00.000Z",
        windowEnd: "2026-05-27T10:00:00.000Z",
        updatedAt: "2026-05-27T10:00:05.000Z"
      })
    })
  );

  const response = await fetchOverview();
  expect(response.totalTokens).toBe(15);
});
```

Create `apps/dashboard/src/components/RecentSessionsTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { RecentSessionsTable } from "./RecentSessionsTable";

it("renders turns, tokens, and last model columns", () => {
  render(
    <RecentSessionsTable
      rows={[
        {
          sessionId: "ses_chat",
          workspacePath: "D:/projects/dev/agent-metrics",
          turnCount: 2,
          totalTokens: 153,
          lastModel: "sonnet-test"
        }
      ]}
      selectedSessionId={null}
      onSelect={() => {}}
    />
  );

  expect(screen.getByText("Turns")).toBeInTheDocument();
  expect(screen.getByText("153")).toBeInTheDocument();
  expect(screen.getByText("sonnet-test")).toBeInTheDocument();
});
```

Extend `apps/dashboard/src/App.test.tsx` so the mocked overview contains `totalTokens: 15` and assert:

```tsx
expect(await screen.findByText("Total Tokens")).toBeInTheDocument();
expect(screen.getByText("15")).toBeInTheDocument();
expect(screen.getByText("Turns")).toBeInTheDocument();
```

- [ ] **Step 2: Run the dashboard tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/dashboard test -- src/api.test.ts src/App.test.tsx src/components/RecentSessionsTable.test.tsx
```

Expected: FAIL because the API types and components do not yet know about tokens or turns.

- [ ] **Step 3: Implement the token-aware overview and session list UI**

Update `apps/dashboard/src/api.ts`:

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
  turnCount: number;
  responseCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} & AggregateMeta;

export type SessionRow = {
  sessionId: string;
  workspacePath: string;
  turnCount: number;
  totalTokens: number;
  lastModel: string | null;
};
```

Update `apps/dashboard/src/components/KpiGrid.tsx` so the first four cards become:

```ts
[
  { label: "Total Tokens", value: NUMBER_FORMAT.format(overview.totalTokens), tone: "signal", meta: "Claude transcript reported usage" },
  { label: "Turns", value: NUMBER_FORMAT.format(overview.turnCount), tone: "calm", meta: `${NUMBER_FORMAT.format(overview.responseCount)} responses` },
  { label: "Tool Calls", value: NUMBER_FORMAT.format(overview.totalToolCalls), tone: "steady", meta: `${NUMBER_FORMAT.format(overview.successfulExecutions)} ok / ${NUMBER_FORMAT.format(overview.failedExecutions)} failed` },
  { label: "Edit Operations", value: NUMBER_FORMAT.format(overview.editOperationCount), tone: "signal", meta: `+${NUMBER_FORMAT.format(overview.insertions)} / -${NUMBER_FORMAT.format(overview.deletions)}` }
]
```

Update `apps/dashboard/src/components/RecentSessionsTable.tsx` to add `Turns`, `Tokens`, and `Model` columns, formatting `lastModel ?? "unknown"`.

Update `apps/dashboard/src/App.tsx` so the table and KPI layout consume the new fields without introducing any cost UI.

- [ ] **Step 4: Run the dashboard tests again**

Run:

```powershell
corepack pnpm --filter @agent-metrics/dashboard test -- src/api.test.ts src/App.test.tsx src/components/RecentSessionsTable.test.tsx
```

Expected: PASS, with the homepage showing total tokens and the session table surfacing turn/token/model summaries.

- [ ] **Step 5: Commit the dashboard homepage slice**

```powershell
git add apps/dashboard/src/api.ts apps/dashboard/src/api.test.ts apps/dashboard/src/components/KpiGrid.tsx apps/dashboard/src/components/RecentSessionsTable.tsx apps/dashboard/src/components/RecentSessionsTable.test.tsx apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/styles.css
git commit -m "feat(dashboard): show transcript token totals and turn counts"
```

### Task 6: Add Turn-Aware Session Detail and Secondary Model Token Breakdown

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/components/SessionTimelinePanel.tsx`
- Modify: `apps/dashboard/src/components/SessionTimelinePanel.test.tsx`
- Create: `apps/dashboard/src/components/ModelUsagePanel.tsx`
- Create: `apps/dashboard/src/components/ModelUsagePanel.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/styles.css`
- Modify: `README.md`

- [ ] **Step 1: Write failing tests for session detail and model grouping**

Extend `apps/core/src/app.test.ts` with:

```ts
it("returns prompt, assistant, token, and tool rows in one session timeline", async () => {
  const response = await app.inject({ method: "GET", url: "/api/sessions/ses_chat" });

  expect(response.json()).toMatchObject({
    sessionId: "ses_chat",
    timeline: expect.arrayContaining([
      expect.objectContaining({ type: "prompt.submitted" }),
      expect.objectContaining({ type: "assistant.responded", model: "sonnet-test" }),
      expect.objectContaining({ type: "token.usage.recorded", tokenTotal: 15 })
    ])
  });
});

it("returns tokensByModel from the scoped overview payload", async () => {
  const response = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });

  expect(response.json()).toMatchObject({
    tokensByModel: [{ model: "sonnet-test", totalTokens: 15 }]
  });
});
```

Extend `apps/dashboard/src/components/SessionTimelinePanel.test.tsx` with a row that expects:

```tsx
expect(screen.getByText("token.usage.recorded")).toBeInTheDocument();
expect(screen.getByText("sonnet-test")).toBeInTheDocument();
expect(screen.getByText("15 tokens")).toBeInTheDocument();
```

Create `apps/dashboard/src/components/ModelUsagePanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { ModelUsagePanel } from "./ModelUsagePanel";

it("renders descending model token totals", () => {
  render(
    <ModelUsagePanel
      rows={[
        { model: "sonnet-test", totalTokens: 300 },
        { model: "unknown", totalTokens: 45 }
      ]}
    />
  );

  expect(screen.getByText("sonnet-test")).toBeInTheDocument();
  expect(screen.getByText("300")).toBeInTheDocument();
  expect(screen.getByText("unknown")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the core and dashboard tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/core test -- src/app.test.ts
corepack pnpm --filter @agent-metrics/dashboard test -- src/App.test.tsx src/components/SessionTimelinePanel.test.tsx src/components/ModelUsagePanel.test.tsx
```

Expected: FAIL because session detail and model grouping are not yet exposed.

- [ ] **Step 3: Implement the richer session timeline and model grouping**

Update `apps/core/src/app.ts` so `/api/sessions/:id` assembles rows from:

- `sessions`
- `prompt_events`
- `assistant_responses`
- `token_usage_events`
- `tool_events`
- `code_edits`

Use one normalized timeline shape:

```ts
type SessionTimelineEntry = {
  type: string;
  toolName: string;
  status: string;
  durationMs: number;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  tokenTotal: number;
  model: string | null;
};
```

Also add `tokensByModel` to `/api/overview` by grouping `token_usage_events` on `COALESCE(model, 'unknown')`.

Create `apps/dashboard/src/components/ModelUsagePanel.tsx`:

```tsx
type ModelUsageRow = {
  model: string;
  totalTokens: number;
};

export function ModelUsagePanel({ rows }: { rows: ModelUsageRow[] }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <h2>Tokens by Model</h2>
        <span>{rows.length} models</span>
      </div>
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td>{row.totalTokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

Update `SessionTimelinePanel.tsx` so token rows render `"{entry.tokenTotal} tokens"` and assistant rows show `entry.model` when present.

Update `README.md` with one short section:

```md
## Transcript-Reported Usage

`agent-metrics` now reads Claude Code local transcripts to surface:

- pure chat sessions with no tool calls
- total token usage
- input/output/cache token breakdowns

These numbers are transcript-reported usage totals, not billing or provider invoice totals.
```

- [ ] **Step 4: Run the core and dashboard tests again**

Run:

```powershell
corepack pnpm --filter @agent-metrics/core test -- src/app.test.ts
corepack pnpm --filter @agent-metrics/dashboard test -- src/App.test.tsx src/components/SessionTimelinePanel.test.tsx src/components/ModelUsagePanel.test.tsx
```

Expected: PASS, with session detail showing prompt/assistant/token rows and overview exposing a secondary model breakdown.

- [ ] **Step 5: Commit the detail and model-breakdown slice**

```powershell
git add apps/core/src/app.ts apps/core/src/app.test.ts apps/dashboard/src/api.ts apps/dashboard/src/components/SessionTimelinePanel.tsx apps/dashboard/src/components/SessionTimelinePanel.test.tsx apps/dashboard/src/components/ModelUsagePanel.tsx apps/dashboard/src/components/ModelUsagePanel.test.tsx apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/styles.css README.md
git commit -m "feat(dashboard): add transcript session detail and model token breakdown"
```

### Task 7: Run Full Verification and Record the Final Delivery State

**Files:**
- Modify: `docs/superpowers/plans/2026-05-27-claude-transcript-usage.md`

- [ ] **Step 1: Run the full workspace test suite**

Run:

```powershell
corepack pnpm test
```

Expected: PASS across `packages/*`, `apps/cli`, `apps/core`, and `apps/dashboard`.

- [ ] **Step 2: Run the TypeScript workspace check**

Run:

```powershell
corepack pnpm lint
```

Expected: PASS with no new type errors.

- [ ] **Step 3: Smoke-test the local product flow**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1
```

Then manually verify:

- a pure chat Claude Code session appears in `Recent Sessions`
- `Total Tokens` rises without any tool calls
- a mixed chat + tool session still shows tool calls and edits
- session detail shows prompt, assistant, token, and tool rows
- `Tokens by Model` shows the active model string

- [ ] **Step 4: Mark the plan footer with the final verification date**

Append this note to the bottom of this plan after implementation:

```md
## Verification Record

- `corepack pnpm test`
- `corepack pnpm lint`
- manual smoke-test via `start-agent-metrics.ps1`
```

- [ ] **Step 5: Commit the verification record**

```powershell
git add docs/superpowers/plans/2026-05-27-claude-transcript-usage.md
git commit -m "docs(plan): record transcript usage verification"
```
