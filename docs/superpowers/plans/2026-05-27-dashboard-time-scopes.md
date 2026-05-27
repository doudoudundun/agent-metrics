# Dashboard Time Scopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add natural calendar, rolling-window, and lifetime time scopes to the dashboard so users can review daily, weekly, and monthly metrics by default instead of only cumulative totals, while keeping selected aggregate panels able to override the global scope and showing a full `Updated` date-time.

**Architecture:** Centralize time-window parsing and boundary calculation in `apps/core`, then thread the resulting scope metadata through the aggregate API responses. On the frontend, hold one global scope state for overview/tools/sessions, add a hero-level scope control, and allow selected aggregate panels to opt into panel-local overrides backed by their own scoped tool queries.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React 19, Vitest, Testing Library, PowerShell

---

## File Structure

- Create: `apps/core/src/time-scope.ts`
  - Parse query parameters, compute calendar/rolling/lifetime windows, and expose SQL-friendly metadata.
- Create: `apps/core/src/time-scope.test.ts`
  - Deterministic coverage for default scope, Monday-based week boundaries, rolling windows, and lifetime behavior.
- Modify: `apps/core/src/app.ts`
  - Apply scoped filters to overview/tools/sessions queries and return scope metadata with `updatedAt`.
- Modify: `apps/core/src/app.test.ts`
  - Verify API results for calendar day/week, rolling windows, lifetime, session filtering, and full metadata.
- Create: `apps/dashboard/src/time-scope.ts`
  - Shared dashboard scope types, labels, equality, and query-string helpers.
- Create: `apps/dashboard/src/time-scope.test.ts`
  - Verify labels and search parameter generation for global and panel overrides.
- Create: `apps/dashboard/src/components/TimeScopeToolbar.tsx`
  - Hero-level global scope control.
- Create: `apps/dashboard/src/components/PanelScopeControls.tsx`
  - Reusable local override control for aggregate panels.
- Create: `apps/dashboard/src/components/ToolRankingTable.test.tsx`
  - Coverage for local-override status text in the rankings panel.
- Modify: `apps/dashboard/src/api.ts`
  - Add scoped response types and query-aware fetchers.
- Modify: `apps/dashboard/src/App.tsx`
  - Own global scope, panel overrides, scoped polling, and full-date `Updated`.
- Modify: `apps/dashboard/src/App.test.tsx`
  - Verify default scope, full timestamp rendering, and local override isolation.
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`
  - Continue rendering KPI metrics from the scoped overview response.
- Modify: `apps/dashboard/src/components/TrendChart.tsx`
  - Display local override controls and panel scope summary.
- Modify: `apps/dashboard/src/components/TrendChart.test.tsx`
  - Verify panel summary text still reflects top-five calls after override props are added.
- Modify: `apps/dashboard/src/components/ToolRankingTable.tsx`
  - Display local override controls and panel scope summary.
- Modify: `apps/dashboard/src/styles.css`
  - Style the hero toolbar and panel-level scope controls.
- Modify: `README.md`
  - Document default natural-period behavior and scope switching.

### Task 1: Build Deterministic Time Scope Utilities in `apps/core`

**Files:**
- Create: `apps/core/src/time-scope.ts`
- Create: `apps/core/src/time-scope.test.ts`

- [ ] **Step 1: Write the failing core utility tests**

Create `apps/core/src/time-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTimeScope } from "./time-scope.js";

describe("resolveTimeScope", () => {
  const now = new Date("2026-05-27T10:30:00.000Z");

  it("defaults to the current calendar day in the provided local offset", () => {
    const scope = resolveTimeScope({}, { now, timezone: "Asia/Shanghai", offsetMinutes: 480 });

    expect(scope.mode).toBe("calendar");
    expect(scope.range).toBe("day");
    expect(scope.windowStart).toBe("2026-05-26T16:00:00.000Z");
    expect(scope.windowEnd).toBe("2026-05-27T10:30:00.000Z");
  });

  it("uses Monday as the start of the current calendar week", () => {
    const scope = resolveTimeScope(
      { mode: "calendar", range: "week" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope.windowStart).toBe("2026-05-24T16:00:00.000Z");
    expect(scope.windowEnd).toBe("2026-05-27T10:30:00.000Z");
  });

  it("uses rolling 30-day windows for rolling month", () => {
    const scope = resolveTimeScope(
      { mode: "rolling", range: "month" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope.windowStart).toBe("2026-04-27T10:30:00.000Z");
    expect(scope.windowEnd).toBe("2026-05-27T10:30:00.000Z");
  });

  it("returns no bounds for lifetime mode", () => {
    const scope = resolveTimeScope(
      { mode: "lifetime", range: "week" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope.windowStart).toBeNull();
    expect(scope.windowEnd).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new utility tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/core exec vitest run src/time-scope.test.ts
```

Expected: FAIL because `src/time-scope.ts` does not exist yet.

- [ ] **Step 3: Implement the scope parser and window builder**

Create `apps/core/src/time-scope.ts`:

```ts
export type TimeScopeMode = "calendar" | "rolling" | "lifetime";
export type TimeScopeRange = "day" | "week" | "month";

export type ResolvedTimeScope = {
  mode: TimeScopeMode;
  range: TimeScopeRange;
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
};

export function resolveTimeScope(
  query: Record<string, unknown>,
  input: {
    now?: Date;
    timezone?: string;
    offsetMinutes?: number;
  } = {}
): ResolvedTimeScope {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMinutes = input.offsetMinutes ?? -now.getTimezoneOffset();
  const mode = normalizeMode(query.mode);
  const range = normalizeRange(query.range);

  if (mode === "lifetime") {
    return {
      mode,
      range,
      timezone,
      windowStart: null,
      windowEnd: null
    };
  }

  const windowEnd = now.toISOString();
  const windowStart = buildWindowStart({ mode, range, now, offsetMinutes });

  return {
    mode,
    range,
    timezone,
    windowStart,
    windowEnd
  };
}
```

Fill in the helper functions so:

- `calendar/day` snaps to local midnight
- `calendar/week` snaps to local Monday midnight
- `calendar/month` snaps to local month start midnight
- `rolling/day` subtracts 24 hours
- `rolling/week` subtracts 7 days
- `rolling/month` subtracts 30 days

Use plain `Date` math with an explicit `offsetMinutes` adjustment so tests stay deterministic and independent from the runner machine timezone.

- [ ] **Step 4: Run the utility tests again and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/core exec vitest run src/time-scope.test.ts
```

Expected: PASS with the calendar and rolling windows resolved in UTC ISO format.

- [ ] **Step 5: Commit the core time-scope utility task**

```powershell
git add apps/core/src/time-scope.ts apps/core/src/time-scope.test.ts
git commit -m "feat(core): add deterministic dashboard time-scope utilities"
```

### Task 2: Make the Aggregate Core API Scope-Aware

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`

- [ ] **Step 1: Write failing API tests for scoped overview, tools, and sessions**

Extend `apps/core/src/app.test.ts` with one seeded dataset spread across multiple dates:

```ts
it("filters overview metrics to the current calendar day", async () => {
  const app = buildApp({
    dbPath,
    eventLogPath: logPath,
    now: () => new Date("2026-05-27T10:30:00.000Z"),
    timezone: "Asia/Shanghai",
    offsetMinutes: 480
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/overview?mode=calendar&range=day"
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    sessionCount: 1,
    totalToolCalls: 1
  });
});

it("filters tool rankings to a rolling week window", async () => {
  const app = buildApp({
    dbPath,
    eventLogPath: logPath,
    now: () => new Date("2026-05-27T10:30:00.000Z"),
    timezone: "Asia/Shanghai",
    offsetMinutes: 480
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/tools?mode=rolling&range=week"
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    rows: [{ toolName: "Read", count: 2, failures: 0, averageDurationMs: 14 }]
  });
});

it("filters recent sessions by started_at for the current calendar month", async () => {
  const app = buildApp({
    dbPath,
    eventLogPath: logPath,
    now: () => new Date("2026-05-27T10:30:00.000Z"),
    timezone: "Asia/Shanghai",
    offsetMinutes: 480
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/sessions?mode=calendar&range=month"
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    rows: [{ sessionId: "ses_current", workspacePath: "D:/projects/dev/agent-metrics" }]
  });
});
```

Seed the log with:

- one old session before the active week
- one session inside the current week
- one session on the current day

Keep the existing session detail test unchanged so `/api/sessions/:id` remains per-session.

- [ ] **Step 2: Run the API tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/core exec vitest run src/app.test.ts
```

Expected: FAIL because the endpoints still return lifetime totals without `mode`, `range`, `timezone`, `windowStart`, `windowEnd`, `updatedAt`, or `rows` envelopes.

- [ ] **Step 3: Implement scope-aware query filtering in `app.ts`**

Modify `apps/core/src/app.ts` in three parts:

1. Extend `buildApp` input so tests can inject deterministic time settings:

```ts
export function buildApp(input: {
  dbPath: string;
  eventLogPath?: string;
  now?: () => Date;
  timezone?: string;
  offsetMinutes?: number;
}): MetricsApp {
```

2. Add a helper to build SQL clauses for scoped timestamps:

```ts
function buildWindowClause(
  columnName: string,
  scope: ResolvedTimeScope
): { sql: string; params: string[] } {
  if (!scope.windowStart || !scope.windowEnd) {
    return { sql: "", params: [] };
  }

  return {
    sql: ` WHERE ${columnName} >= ? AND ${columnName} <= ?`,
    params: [scope.windowStart, scope.windowEnd]
  };
}
```

3. Return scope metadata with each aggregate endpoint:

```ts
app.get("/api/overview", async (request) => {
  const scope = resolveTimeScope(request.query as Record<string, unknown>, {
    now: input.now?.(),
    timezone: input.timezone,
    offsetMinutes: input.offsetMinutes
  });
  const overviewRows = selectOverviewRows(db, scope);

  return {
    ...buildOverviewMetrics({
      sessions: overviewRows.sessions,
      toolEvents: overviewRows.toolEvents,
      codeEdits: overviewRows.codeEdits
    }),
    ...scope,
    updatedAt: (input.now?.() ?? new Date()).toISOString()
  };
});
```

For `/api/tools` and `/api/sessions`, return:

```ts
{
  rows,
  ...scope,
  updatedAt: (input.now?.() ?? new Date()).toISOString()
}
```

Use:

- `created_at` for `tool_events`
- `created_at` for `code_edits`
- `started_at` for `sessions`

Keep `/api/sessions/:id` unscoped.

- [ ] **Step 4: Run the API tests again and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/core exec vitest run src/app.test.ts
```

Expected: PASS with scoped metrics, tool rows, session rows, and preserved session detail behavior.

- [ ] **Step 5: Commit the scoped API task**

```powershell
git add apps/core/src/app.ts apps/core/src/app.test.ts
git commit -m "feat(core): add scoped dashboard aggregates for day week and month"
```

### Task 3: Add Global Dashboard Scope and Full `Updated` Date-Time

**Files:**
- Create: `apps/dashboard/src/time-scope.ts`
- Create: `apps/dashboard/src/time-scope.test.ts`
- Create: `apps/dashboard/src/components/TimeScopeToolbar.tsx`
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/components/KpiGrid.tsx`
- Modify: `apps/dashboard/src/styles.css`

- [ ] **Step 1: Write the failing dashboard tests**

Add `apps/dashboard/src/time-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildScopeLabel, buildScopeSearchParams } from "./time-scope";

describe("dashboard time scope helpers", () => {
  it("labels the default scope as Today", () => {
    expect(buildScopeLabel({ mode: "calendar", range: "day" })).toBe("Today");
  });

  it("builds query params for rolling week", () => {
    expect(buildScopeSearchParams({ mode: "rolling", range: "week" }).toString()).toBe(
      "mode=rolling&range=week"
    );
  });
});
```

Update `apps/dashboard/src/App.test.tsx` to:

- mock `fetchOverview`, `fetchTools`, and `fetchSessions` as `vi.fn()`
- assert first render calls each aggregate fetch with `{ mode: "calendar", range: "day" }`
- assert the page renders a full `Updated` timestamp such as `2026-05-27 18:30:00`

Use this mock shape:

```ts
const fetchOverview = vi.fn(async () => ({
  sessionCount: 3,
  totalToolCalls: 12,
  successfulExecutions: 10,
  failedExecutions: 2,
  successRate: 0.8333,
  editOperationCount: 4,
  affectedFileCount: 7,
  insertions: 42,
  deletions: 8,
  mode: "calendar",
  range: "day",
  timezone: "Asia/Shanghai",
  windowStart: "2026-05-26T16:00:00.000Z",
  windowEnd: "2026-05-27T10:30:00.000Z",
  updatedAt: "2026-05-27T10:30:00.000Z"
}));
```

- [ ] **Step 2: Run the dashboard tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/time-scope.test.ts src/App.test.tsx
```

Expected: FAIL because dashboard fetchers do not accept scope arguments, `Updated` is still client-only `HH:mm:ss`, and no global scope helpers exist.

- [ ] **Step 3: Implement dashboard scope helpers, API types, and hero toolbar**

Create `apps/dashboard/src/time-scope.ts`:

```ts
export type TimeScopeMode = "calendar" | "rolling" | "lifetime";
export type TimeScopeRange = "day" | "week" | "month";

export type TimeScopeSelection = {
  mode: TimeScopeMode;
  range: TimeScopeRange;
};

export function buildScopeLabel(scope: TimeScopeSelection): string {
  if (scope.mode === "calendar" && scope.range === "day") return "Today";
  if (scope.mode === "calendar" && scope.range === "week") return "This Week";
  if (scope.mode === "calendar" && scope.range === "month") return "This Month";
  if (scope.mode === "rolling" && scope.range === "day") return "Last 24 Hours";
  if (scope.mode === "rolling" && scope.range === "week") return "Last 7 Days";
  if (scope.mode === "rolling" && scope.range === "month") return "Last 30 Days";
  return "All Time";
}

export function buildScopeSearchParams(scope: TimeScopeSelection): URLSearchParams {
  return new URLSearchParams({
    mode: scope.mode,
    range: scope.range
  });
}
```

Create `apps/dashboard/src/components/TimeScopeToolbar.tsx`:

```tsx
import type { TimeScopeSelection } from "../time-scope";

export function TimeScopeToolbar(input: {
  scope: TimeScopeSelection;
  onChange: (next: TimeScopeSelection) => void;
}) {
  return (
    <div className="scope-toolbar">
      <label>
        <span>Window</span>
        <select
          aria-label="Global time mode"
          value={input.scope.mode}
          onChange={(event) => input.onChange({ ...input.scope, mode: event.target.value as TimeScopeSelection["mode"] })}
        >
          <option value="calendar">Natural Calendar</option>
          <option value="rolling">Rolling Window</option>
          <option value="lifetime">Lifetime</option>
        </select>
      </label>
      <label>
        <span>Range</span>
        <select
          aria-label="Global time range"
          value={input.scope.range}
          onChange={(event) => input.onChange({ ...input.scope, range: event.target.value as TimeScopeSelection["range"] })}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </label>
    </div>
  );
}
```

Modify `apps/dashboard/src/api.ts` so:

- `fetchOverview(scope)` appends `mode` and `range`
- `fetchTools(scope)` appends `mode` and `range`
- `fetchSessions(scope)` appends `mode` and `range`
- aggregate responses include `mode`, `range`, `timezone`, `windowStart`, `windowEnd`, and `updatedAt`

Modify `apps/dashboard/src/App.tsx` so:

- it owns `globalScope` defaulting to `{ mode: "calendar", range: "day" }`
- dashboard polling reloads overview/tools/sessions when `globalScope` changes
- `lastUpdated` is derived from `overview.updatedAt`
- the hero area renders `TimeScopeToolbar`
- the hero area shows the global scope label

Format the updated timestamp with:

```ts
new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
}).format(new Date(updatedAt))
```

The rendered result should be `YYYY-MM-DD HH:mm:ss`.

- [ ] **Step 4: Run the dashboard tests again and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/time-scope.test.ts src/App.test.tsx
```

Expected: PASS with default `calendar/day` fetches and a full `Updated` date-time in the hero.

- [ ] **Step 5: Commit the global scope dashboard task**

```powershell
git add apps/dashboard/src/time-scope.ts apps/dashboard/src/time-scope.test.ts apps/dashboard/src/components/TimeScopeToolbar.tsx apps/dashboard/src/api.ts apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/components/KpiGrid.tsx apps/dashboard/src/styles.css
git commit -m "feat(dashboard): add global calendar and rolling time scopes"
```

### Task 4: Add Panel-Level Local Override for Aggregate Tool Panels

**Files:**
- Create: `apps/dashboard/src/components/PanelScopeControls.tsx`
- Create: `apps/dashboard/src/components/ToolRankingTable.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/components/TrendChart.tsx`
- Modify: `apps/dashboard/src/components/TrendChart.test.tsx`
- Modify: `apps/dashboard/src/components/ToolRankingTable.tsx`
- Modify: `apps/dashboard/src/styles.css`

- [ ] **Step 1: Write failing local-override tests**

Update `apps/dashboard/src/App.test.tsx` to verify a local override only affects the targeted panel:

```ts
it("lets the activity snapshot override the global scope without changing tool rankings", async () => {
  const fetchTools = vi.fn(async (scope: { mode: string; range: string }) => {
    if (scope.mode === "rolling" && scope.range === "week") {
      return {
        rows: [
          { toolName: "Read", count: 9, failures: 0, averageDurationMs: 15 },
          { toolName: "Edit", count: 4, failures: 0, averageDurationMs: 12 }
        ],
        mode: "rolling",
        range: "week",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-20T10:30:00.000Z",
        windowEnd: "2026-05-27T10:30:00.000Z",
        updatedAt: "2026-05-27T10:30:00.000Z"
      };
    }

    return {
      rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }],
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    };
  });

  render(<App />);

  fireEvent.change(await screen.findByLabelText("Activity Snapshot mode"), {
    target: { value: "rolling" }
  });
  fireEvent.change(screen.getByLabelText("Activity Snapshot range"), {
    target: { value: "week" }
  });

  expect(await screen.findByText("13 calls total")).toBeInTheDocument();
  expect(screen.getByText("1 tracked")).toBeInTheDocument();
});
```

Add `apps/dashboard/src/components/ToolRankingTable.test.tsx`:

```ts
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolRankingTable } from "./ToolRankingTable";

describe("ToolRankingTable", () => {
  it("shows when the panel is following the global scope", () => {
    render(
      <ToolRankingTable
        rows={[{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]}
        scopeLabel="Today"
        override={null}
        onOverrideChange={vi.fn()}
      />
    );

    expect(screen.getByText("Following global: Today")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the override tests and verify they fail**

Run:

```powershell
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/App.test.tsx src/components/TrendChart.test.tsx src/components/ToolRankingTable.test.tsx
```

Expected: FAIL because the tool panels do not accept override props and `App` only keeps one shared tools dataset.

- [ ] **Step 3: Implement reusable panel overrides for the tool panels**

Create `apps/dashboard/src/components/PanelScopeControls.tsx`:

```tsx
import { buildScopeLabel, type TimeScopeSelection } from "../time-scope";

export function PanelScopeControls(input: {
  panelName: string;
  scope: TimeScopeSelection;
  override: TimeScopeSelection | null;
  onOverrideChange: (next: TimeScopeSelection | null) => void;
}) {
  const value = input.override ?? input.scope;

  return (
    <div className="panel-scope-controls">
      <span>
        {input.override ? "Override active" : `Following global: ${buildScopeLabel(input.scope)}`}
      </span>
      <select
        aria-label={`${input.panelName} mode`}
        value={value.mode}
        onChange={(event) => input.onOverrideChange({ ...value, mode: event.target.value as TimeScopeSelection["mode"] })}
      >
        <option value="calendar">Natural Calendar</option>
        <option value="rolling">Rolling Window</option>
        <option value="lifetime">Lifetime</option>
      </select>
      <select
        aria-label={`${input.panelName} range`}
        value={value.range}
        onChange={(event) => input.onOverrideChange({ ...value, range: event.target.value as TimeScopeSelection["range"] })}
      >
        <option value="day">Day</option>
        <option value="week">Week</option>
        <option value="month">Month</option>
      </select>
      {input.override ? (
        <button onClick={() => input.onOverrideChange(null)} type="button">
          Use Global Scope
        </button>
      ) : null}
    </div>
  );
}
```

Modify `App.tsx` so it owns:

```ts
const [trendOverride, setTrendOverride] = useState<TimeScopeSelection | null>(null);
const [rankingOverride, setRankingOverride] = useState<TimeScopeSelection | null>(null);
const [trendTools, setTrendTools] = useState<ToolsResponse | null>(null);
const [rankingTools, setRankingTools] = useState<ToolsResponse | null>(null);
```

Behavior:

- if an override is `null`, the panel uses the globally-fetched tools response
- if an override is set, fetch `fetchTools(override)` for that panel only
- do not refetch overview or sessions when a panel-only override changes

Modify `TrendChart.tsx` and `ToolRankingTable.tsx` so they accept:

```ts
scopeLabel: string;
override: TimeScopeSelection | null;
onOverrideChange: (next: TimeScopeSelection | null) => void;
```

Render `PanelScopeControls` in each panel heading and keep the existing summary text:

- `Top 5 by calls`
- `X calls total`
- `Y tracked`

- [ ] **Step 4: Run the override tests again and verify green**

Run:

```powershell
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/App.test.tsx src/components/TrendChart.test.tsx src/components/ToolRankingTable.test.tsx
```

Expected: PASS with:

- overridden activity snapshot data fetched separately
- unchanged tool rankings when only the chart panel is overridden
- explicit “Following global” text when no override is active

- [ ] **Step 5: Commit the panel override task**

```powershell
git add apps/dashboard/src/components/PanelScopeControls.tsx apps/dashboard/src/components/ToolRankingTable.test.tsx apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/components/TrendChart.tsx apps/dashboard/src/components/TrendChart.test.tsx apps/dashboard/src/components/ToolRankingTable.tsx apps/dashboard/src/styles.css
git commit -m "feat(dashboard): add local override controls for aggregate tool panels"
```

### Task 5: Update Docs and Run End-to-End Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the failing documentation expectation**

The README currently implies the dashboard is a live cumulative surface. Update it so the dashboard behavior is explicit:

```md
- the dashboard defaults to the current calendar day
- the hero toolbar switches between natural calendar, rolling window, and lifetime views
- selected aggregate panels can override the global scope
- `Updated` displays a full local date-time
```

This step has no failing automated test. Verification comes from the full test/build/lint run and a browser smoke test.

- [ ] **Step 2: Update README and any visible operator copy**

Modify the verification section so it tells the operator to:

1. start the app
2. confirm the default view is the current calendar day
3. switch to calendar week, rolling week, and lifetime
4. confirm one aggregate panel can override the global scope

- [ ] **Step 3: Run the full project verification**

Run:

```powershell
corepack pnpm test
corepack pnpm build
corepack pnpm lint
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1 -NoBrowser
```

Expected:

- all tests pass
- build passes
- lint passes
- dashboard starts successfully
- the hero shows a full `Updated` date-time
- the page defaults to the current calendar day

- [ ] **Step 4: Perform the manual acceptance pass**

1. Open `http://127.0.0.1:4173`.
2. Confirm the default hero scope is `Today`.
3. Confirm KPI totals differ when switching from `Today` to `This Week`.
4. Switch to `Rolling Window` + `Week` and confirm values change from the calendar week when expected.
5. Switch to `Lifetime` and confirm cumulative totals remain available.
6. Override `Activity Snapshot` locally and confirm `Tool Rankings` still follows the global scope.
7. Confirm the top `Updated` label includes date and time.

- [ ] **Step 5: Commit the docs and verification task**

```powershell
git add README.md
git commit -m "docs(dashboard): describe calendar rolling and lifetime scope controls"
```

## Self-Review

- Spec coverage:
  - shared backend scope model: Task 1 and Task 2
  - scoped aggregate API responses: Task 2
  - default natural period view: Task 3
  - full `Updated` date-time: Task 3 and Task 5
  - global filter: Task 3
  - selected panel local overrides: Task 4
- Placeholder scan:
  - no `TODO`, `TBD`, or “implement later” markers remain
  - each file change lists exact paths and runnable commands
- Type consistency:
  - core utility names: `resolveTimeScope`, `ResolvedTimeScope`
  - dashboard scope names: `TimeScopeSelection`, `buildScopeLabel`
  - panel override component: `PanelScopeControls`
