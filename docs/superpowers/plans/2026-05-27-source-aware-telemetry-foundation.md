# Source-Aware Telemetry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the source-aware telemetry foundation so the existing local dashboard can filter Claude data by source and is structurally ready for OpenCode and Codex adapters.

**Architecture:** Extend the normalized event contract first, then persist source/provider metadata in the core SQLite cache, then expose source-aware aggregate APIs and wire the dashboard to the new contract. Keep the implementation additive so current Claude ingestion still works while OpenCode and Codex adapters land later on the same model.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, React

---

## Scope Split

The accepted spec covers three independent subsystems:

- source-aware foundation
- OpenCode adapter
- Codex adapter

This plan intentionally covers only the first subsystem. It produces a working, testable slice:

- normalized source/provider fields
- source-aware SQLite persistence
- source filter and source breakdown APIs
- dashboard source filter and unavailable-state rendering contract

Follow-on plans should cover:

- `adapters-opencode`
- `adapters-codex`

## File Map

### Event contract

- Modify: `packages/event-schema/src/index.ts`
- Modify: `packages/event-schema/src/index.test.ts`

Responsibility:

- define reusable source and usage-source enums
- extend normalized events with provider metadata where needed

### Core storage and APIs

- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`

Responsibility:

- persist source/provider columns
- migrate older SQLite files
- filter aggregate queries by source
- return source/provider breakdowns

### Dashboard API client and UI

- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/api.test.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`

Responsibility:

- pass `sourceVendor` query params
- parse new overview/session payload fields
- add global source filter
- render source breakdown and unavailable states

### Verification and docs

- Modify: `docs/superpowers/plans/2026-05-27-source-aware-telemetry-foundation.md`

Responsibility:

- track execution notes inline if the implementation discovers contract adjustments

### Task 1: Expand the normalized event contract

**Files:**
- Modify: `packages/event-schema/src/index.ts`
- Modify: `packages/event-schema/src/index.test.ts`
- Test: `packages/event-schema/src/index.test.ts`

- [ ] **Step 1: Write the failing schema tests**

```ts
it("parses token usage events from non-Claude sources", () => {
  const result = TokenUsageRecordedEventSchema.safeParse({
    event_id: "evt_opencode_usage",
    session_id: "ses_opencode_1",
    timestamp: "2026-05-27T10:00:10.000Z",
    source_vendor: "opencode",
    source_adapter: "opencode-db",
    workspace_path: "D:/projects/dev/agent-metrics",
    type: "token.usage.recorded",
    message_id: "msg_1",
    model: "hy3-preview-free",
    provider_id: "opencode",
    provider_base_url: null,
    provider_host: null,
    input_tokens: 120,
    output_tokens: 48,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 16,
    server_tool_use: "{}",
    usage_source: "opencode-message"
  });

  expect(result.success).toBe(true);
});

it("rejects unknown source vendors", () => {
  const result = AnyEventSchema.safeParse({
    event_id: "evt_bad_source",
    session_id: "ses_1",
    timestamp: "2026-05-27T10:00:10.000Z",
    source_vendor: "unknown-tool",
    source_adapter: "claude-transcript",
    workspace_path: "D:/projects/dev/agent-metrics",
    type: "session.started"
  });

  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `corepack pnpm --filter @agent-metrics/event-schema test`

Expected: FAIL because `usage_source` is still locked to `claude-transcript` and provider fields are not yet accepted.

- [ ] **Step 3: Implement the minimal schema changes**

```ts
const SourceVendorSchema = z.enum(["claude-code", "opencode", "codex"]);

const SourceAdapterSchema = z.enum([
  "claude-hook",
  "claude-transcript",
  "opencode-db",
  "codex-rollout",
  "codex-history",
  "codex-logs"
]);

const UsageSourceSchema = z.enum([
  "claude-transcript",
  "opencode-message",
  "codex-rollout",
  "codex-logs"
]);

const BaseEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  timestamp: z.string().datetime(),
  source_vendor: SourceVendorSchema,
  source_adapter: SourceAdapterSchema,
  workspace_path: z.string().min(1)
});

const ProviderFieldsSchema = z.object({
  provider_id: z.string().min(1).nullable().optional(),
  provider_base_url: z.string().url().nullable().optional(),
  provider_host: z.string().min(1).nullable().optional()
});

export const AssistantRespondedEventSchema = BaseEventSchema.extend({
  type: z.literal("assistant.responded"),
  message_id: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  stop_reason: z.string().min(1).nullable().optional(),
  response_chars: z.number().int().nonnegative()
}).merge(ProviderFieldsSchema);

export const TokenUsageRecordedEventSchema = BaseEventSchema.extend({
  type: z.literal("token.usage.recorded"),
  message_id: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  server_tool_use: z.string().default("{}"),
  usage_source: UsageSourceSchema
}).merge(ProviderFieldsSchema);
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `corepack pnpm --filter @agent-metrics/event-schema test`

Expected: PASS with the new source-vendor, adapter, and usage-source coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/event-schema/src/index.ts packages/event-schema/src/index.test.ts
git commit -m "feat(schema): add source-aware provider metadata"
```

### Task 2: Persist source and provider metadata in core storage

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`
- Test: `apps/core/src/app.test.ts`

- [ ] **Step 1: Write failing core tests for source-aware overview queries**

```ts
it("filters overview metrics by sourceVendor and returns source breakdown rows", async () => {
  for (const event of [
    {
      event_id: "evt_claude_started",
      session_id: "ses_claude",
      timestamp: "2026-05-27T01:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude-transcript",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    },
    {
      event_id: "evt_codex_started",
      session_id: "ses_codex",
      timestamp: "2026-05-27T02:00:00.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    }
  ]) {
    await appendJsonLine(logPath, event);
  }

  const app = buildApp({ dbPath, ...scopedAppInput });
  await ingestEventLog({ app, eventLogPath: logPath });

  const allResponse = await app.inject({
    method: "GET",
    url: "/api/overview?mode=calendar&range=day&sourceVendor=all"
  });
  const codexResponse = await app.inject({
    method: "GET",
    url: "/api/overview?mode=calendar&range=day&sourceVendor=codex"
  });

  expect(allResponse.json()).toMatchObject({
    sessionCount: 2,
    sourceBreakdown: [
      expect.objectContaining({ sourceVendor: "claude-code", sessionCount: 1 }),
      expect.objectContaining({ sourceVendor: "codex", sessionCount: 1 })
    ]
  });
  expect(codexResponse.json()).toMatchObject({
    sessionCount: 1,
    sourceBreakdown: [expect.objectContaining({ sourceVendor: "codex", sessionCount: 1 })]
  });
});
```

- [ ] **Step 2: Run the core tests to verify they fail**

Run: `corepack pnpm --filter @agent-metrics/core test`

Expected: FAIL because the schema is not yet persisted into SQLite and the API does not accept `sourceVendor`.

- [ ] **Step 3: Implement the minimal storage, migration, and query changes**

```ts
type SourceVendor = "claude-code" | "opencode" | "codex";

function resolveSourceVendor(query: unknown): SourceVendor | "all" {
  const value = queryRecord(query).sourceVendor;
  return value === "claude-code" || value === "opencode" || value === "codex" ? value : "all";
}

function buildSourceFilter(columnName: string, sourceVendor: SourceVendor | "all") {
  if (sourceVendor === "all") {
    return { clause: "", params: [] as string[] };
  }

  return {
    clause: ` AND ${columnName} = ?`,
    params: [sourceVendor]
  };
}

db.exec(`
  ALTER TABLE sessions ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code';
  ALTER TABLE sessions ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'claude-hook';
  ALTER TABLE assistant_responses ADD COLUMN provider_id TEXT;
  ALTER TABLE assistant_responses ADD COLUMN provider_base_url TEXT;
  ALTER TABLE assistant_responses ADD COLUMN provider_host TEXT;
  ALTER TABLE token_usage_events ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code';
  ALTER TABLE token_usage_events ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'claude-transcript';
  ALTER TABLE token_usage_events ADD COLUMN provider_id TEXT;
  ALTER TABLE token_usage_events ADD COLUMN provider_base_url TEXT;
  ALTER TABLE token_usage_events ADD COLUMN provider_host TEXT;
`);
```

- [ ] **Step 4: Extend the overview/session/timeline payloads**

```ts
return withScopeMetadata(
  {
    ...buildOverviewMetrics(...),
    tokensByModel: selectTokensByModel(db, scope, sourceVendor),
    sourceBreakdown: selectSourceBreakdown(db, scope),
    providerBreakdown: selectProviderBreakdown(db, scope, sourceVendor)
  },
  scope
);

return withScopeMetadata(
  {
    rows: selectSessions(db, scope, sourceVendor)
  },
  scope
);
```

- [ ] **Step 5: Run the core tests to verify they pass**

Run: `corepack pnpm --filter @agent-metrics/core test`

Expected: PASS, including existing transcript single-flight coverage and new source-aware query coverage.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/app.ts apps/core/src/app.test.ts
git commit -m "feat(core): persist source metadata and filter aggregates"
```

### Task 3: Add source-aware dashboard API parsing and global filter UI

**Files:**
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/api.test.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`
- Test: `apps/dashboard/src/api.test.ts`
- Test: `apps/dashboard/src/App.test.tsx`

- [ ] **Step 1: Write the failing API and UI tests**

```ts
it("appends sourceVendor to aggregate dashboard requests", async () => {
  stubFetchJson({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T10:30:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    sessionCount: 1,
    turnCount: 0,
    responseCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokensByModel: [],
    totalToolCalls: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    successRate: 0,
    editOperationCount: 0,
    affectedFileCount: 0,
    insertions: 0,
    deletions: 0,
    sourceBreakdown: [],
    providerBreakdown: []
  });

  await fetchOverview(
    { mode: "calendar", range: "day" },
    "codex"
  );

  expect(fetch).toHaveBeenCalledWith(
    "/api/overview?mode=calendar&range=day&sourceVendor=codex"
  );
});
```

```tsx
it("filters dashboard cards by source without full-page error state", async () => {
  render(<App />);

  await screen.findByText("All");
  await userEvent.click(screen.getByRole("button", { name: "Codex" }));

  await screen.findByText(/not available for this source yet/i);
});
```

- [ ] **Step 2: Run the dashboard tests to verify they fail**

Run: `corepack pnpm --filter @agent-metrics/dashboard test`

Expected: FAIL because the dashboard client does not yet know about `sourceVendor`, `sourceBreakdown`, or provider breakdowns.

- [ ] **Step 3: Implement the API contract updates**

```ts
export type SourceVendor = "all" | "claude-code" | "opencode" | "codex";

export type SourceBreakdownRow = {
  sourceVendor: Exclude<SourceVendor, "all">;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
  toolCalls: number;
};

export type ProviderBreakdownRow = {
  providerHost: string | null;
  providerId: string | null;
  totalTokens: number;
};

export async function fetchOverview(
  scope: TimeScopeSelection = DEFAULT_TIME_SCOPE,
  sourceVendor: SourceVendor = "all"
): Promise<OverviewResponse> {
  return parseOverviewResponse(
    await fetchJson<unknown>(withScopeAndSource("/api/overview", scope, sourceVendor)),
    "/api/overview"
  );
}
```

- [ ] **Step 4: Implement the App-level source filter**

```tsx
const SOURCE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" }
] satisfies Array<{ value: SourceVendor; label: string }>;

const [sourceVendor, setSourceVendor] = useState<SourceVendor>("all");

useEffect(() => {
  startTransition(() => {
    void reloadDashboard(scope, sourceVendor);
  });
}, [scope, sourceVendor]);
```

- [ ] **Step 5: Add source breakdown and unavailable-state rendering**

```tsx
{selectedSourceVendor === "codex" && tools.rows.length === 0 ? (
  <p>Not available for this source yet.</p>
) : (
  <ToolChart rows={tools.rows.slice(0, 5)} />
)}

<section aria-label="Source Breakdown">
  {overview.sourceBreakdown.map((row) => (
    <article key={row.sourceVendor}>
      <h3>{SOURCE_LABELS[row.sourceVendor]}</h3>
      <p>{row.totalTokens.toLocaleString()} tokens</p>
    </article>
  ))}
</section>
```

- [ ] **Step 6: Run the dashboard tests to verify they pass**

Run: `corepack pnpm --filter @agent-metrics/dashboard test`

Expected: PASS with source query parameters, parsed source breakdown rows, and UI unavailable-state coverage.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/api.ts apps/dashboard/src/api.test.ts apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/components/KpiGrid.tsx
git commit -m "feat(dashboard): add global source filters and source breakdowns"
```

### Task 4: Verify the foundation slice end-to-end

**Files:**
- Modify: `docs/superpowers/plans/2026-05-27-source-aware-telemetry-foundation.md`

- [ ] **Step 1: Run focused package tests**

Run:

```bash
corepack pnpm --filter @agent-metrics/event-schema test
corepack pnpm --filter @agent-metrics/core test
corepack pnpm --filter @agent-metrics/dashboard test
```

Expected:

- all three commands PASS
- no new failing tests from current Claude-only workflows

- [ ] **Step 2: Run production builds**

Run:

```bash
corepack pnpm --filter @agent-metrics/core build
corepack pnpm --filter @agent-metrics/dashboard build
```

Expected:

- both builds PASS
- TypeScript catches any payload drift between API and dashboard

- [ ] **Step 3: Smoke-test the local APIs using existing Claude data**

Run:

```bash
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1
Invoke-WebRequest http://127.0.0.1:45183/api/overview?mode=calendar&range=day&sourceVendor=all | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest http://127.0.0.1:45183/api/overview?mode=calendar&range=day&sourceVendor=claude-code | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest http://127.0.0.1:45183/api/tools?mode=calendar&range=day&sourceVendor=codex | Select-Object -ExpandProperty StatusCode
```

Expected:

- each request returns `200`
- Codex tools may be empty, but the endpoint must not fail

- [ ] **Step 4: Commit the verified foundation slice**

```bash
git add packages/event-schema/src/index.ts packages/event-schema/src/index.test.ts apps/core/src/app.ts apps/core/src/app.test.ts apps/dashboard/src/api.ts apps/dashboard/src/api.test.ts apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/components/KpiGrid.tsx
git commit -m "feat: add source-aware telemetry foundation"
```

## Self-Review

Spec coverage check:

- source-aware schema: Task 1
- source-aware SQLite and APIs: Task 2
- dashboard source filter and unavailable states: Task 3
- verification and no-regression checks: Task 4

Placeholder scan:

- no `TBD`
- no `TODO`
- no cross-task shorthand

Type consistency:

- canonical values stay aligned across tasks:
  - `claude-code`
  - `opencode`
  - `codex`
  - `claude-transcript`
  - `opencode-message`
  - `codex-rollout`
  - `codex-logs`
