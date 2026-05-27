# Dashboard Time Scopes Design

## Goal

Replace the current always-cumulative dashboard behavior with time-scoped analytics that support:

- natural calendar periods
- rolling windows
- optional lifetime totals

The default dashboard view must prioritize natural periods, show daily/weekly/monthly statistics, and display the top-level `Updated` timestamp as a full date and time.

## Scope

This design covers:

- shared time-scope query parameters for the metrics API
- dashboard defaults for natural period reporting
- a global time filter for aggregate panels
- panel-level override support for selected aggregate panels
- full timestamp display for the dashboard `Updated` label

This design does not cover:

- changing the hook collection pipeline
- token or cost attribution
- company-wide deployment
- long-term pre-aggregated warehouse tables

## Confirmed Decisions

- Support three scope modes:
  - `calendar`
  - `rolling`
  - `lifetime`
- Support three ranges:
  - `day`
  - `week`
  - `month`
- Default dashboard scope is:
  - `mode=calendar`
  - `range=day`
- Lifetime totals remain available, but are not the default view.
- The dashboard must support both:
  - a global filter
  - panel-level local overrides for selected panels
- Timezone is the local machine timezone, currently `Asia/Shanghai`.
- Calendar week boundaries are Monday through Sunday.
- The top `Updated` label must display a full date and time, not just time-of-day.

## Current State

The current dashboard loads:

- `/api/overview`
- `/api/tools`
- `/api/sessions`
- `/api/sessions/:id`

Those endpoints currently behave as lifetime totals unless the selected session detail endpoint is used. The React app also stamps `Updated` locally using the browser clock and currently displays only `HH:mm:ss`.

This creates two product problems:

1. the main dashboard numbers grow forever and are difficult to use for daily/weekly/monthly review
2. the `Updated` label lacks enough date context once the dashboard has been open across days

## Problem Statement

The product is supposed to monitor current activity, not just cumulative historical totals. Users need to answer questions like:

- how many tool calls happened today?
- how does this week compare to this month?
- what happened in the last 7 days versus this calendar week?

The current lifetime-only queries force every top-level card and chart into one undifferentiated aggregate. The fix needs a shared time-window model across the API and dashboard, while still allowing a few panels to opt out or override global scope when local analysis is more useful.

## Recommended Approach

Introduce one shared time-scope model across the API and frontend:

- `mode`:
  - `calendar`
  - `rolling`
  - `lifetime`
- `range`:
  - `day`
  - `week`
  - `month`

The backend becomes responsible for interpreting the requested time window and applying it consistently to aggregate queries. The frontend becomes responsible for:

- holding one global scope state
- passing it to aggregate endpoints
- allowing selected panels to temporarily override it

This keeps time math centralized, avoids split logic between API and browser, and preserves a clean path for export consistency later.

## Alternatives Considered

### 1. Backend-owned filtering with shared scope parameters

Add `mode` and `range` query parameters to the aggregate endpoints and let the API define the exact time window.

Pros:

- one source of truth for time boundaries
- consistent dashboard and export behavior
- easier to extend to more panels later

Cons:

- requires API and frontend changes

### 2. Frontend-only filtering from larger payloads

Load broad datasets once and let the browser compute daily/weekly/monthly aggregates.

Pros:

- fewer API changes

Cons:

- duplicates time logic in the UI
- harder to keep exports consistent
- weaker scaling path

### 3. Dedicated aggregate tables per period

Precompute daily/weekly/monthly/rolling tables in SQLite.

Pros:

- best long-term performance

Cons:

- too heavy for the current scope
- unnecessary before the query model is stable

Recommendation: option 1.

## Functional Design

### 1. Shared Time Scope Model

Every aggregate dashboard query should accept:

- `mode`
- `range`

Mode semantics:

- `calendar`
  - use the current local calendar period
  - `day`: today from local `00:00:00` to now
  - `week`: Monday `00:00:00` of the current local week to now
  - `month`: first day of current local month `00:00:00` to now
- `rolling`
  - use a backward-looking window ending now
  - `day`: last 24 hours
  - `week`: last 7 days
  - `month`: last 30 days
- `lifetime`
  - use all retained data
  - `range` is accepted for UI consistency but ignored by the backend

### 2. API Contract

The aggregate endpoints should accept query parameters:

- `/api/overview?mode=calendar&range=day`
- `/api/tools?mode=rolling&range=week`
- `/api/sessions?mode=calendar&range=month`

Responses should include scope metadata so the UI can render the active interpretation explicitly:

- `mode`
- `range`
- `timezone`
- `windowStart`
- `windowEnd`
- `updatedAt`

`updatedAt` should be server-generated at response time and used by the top dashboard status area.

### 3. Endpoint Responsibilities

#### `/api/overview`

Returns KPI metrics for the requested scope window.

Examples:

- session count within the window
- tool calls within the window
- successful and failed executions within the window
- edit counts and file deltas within the window

#### `/api/tools`

Returns tool rankings only from the requested scope window. This is the primary source for the top-tools chart and tools table.

#### `/api/sessions`

Returns only sessions that started within the requested scope window, ordered newest-first.

#### `/api/sessions/:id`

Remains session-scoped rather than period-scoped. It shows the selected session's own timeline. This endpoint does not participate in daily/weekly/monthly aggregation because it already represents a single concrete session, not a time-window aggregate.

### 4. Frontend Scope Model

The dashboard should hold one global scope state:

- default `mode=calendar`
- default `range=day`

That global scope drives:

- KPI grid
- top tools chart
- tools ranking table
- recent sessions list

The hero area should also display the current scope label in human-readable form, for example:

- `Today`
- `This Week`
- `This Month`
- `Last 24 Hours`
- `Last 7 Days`
- `All Time`

### 5. Panel-Level Local Overrides

The dashboard should support a reusable local override model:

- panel default: follow the global scope
- optional panel override: set a panel-local `mode` and `range`
- visible reset action: return to global scope
- visible indicator: mark the panel as using a local override

In this iteration, local override should be applied first to aggregate panels, not to `Session Timeline`, because `Session Timeline` is already bound to one selected session rather than a cross-session aggregate.

### 6. Updated Timestamp Behavior

The top hero status area should show:

- full local date
- full local time

Example format:

- `2026-05-27 14:32:18`

The source should be the backend `updatedAt` response field for the active overview request, not a client-only clock stamp.

### 7. Timezone and Boundary Rules

The backend must compute calendar windows in the configured local timezone.

For the current environment:

- timezone: `Asia/Shanghai`
- week starts: Monday

These rules must be centralized in the backend so every panel sees the same interpretation.

## UX Behavior

### Global Filter

The top-level dashboard filter exposes:

- mode picker:
  - natural calendar
  - rolling window
  - lifetime
- range picker:
  - day
  - week
  - month

Default selection on first load:

- natural calendar
- day

### Local Override

Selected aggregate panels can expose a compact local filter affordance:

- follow global
- override to a different mode/range
- restore to global

The UI must make it obvious when a panel is not following the global filter anymore.

## Files Likely Affected

- `apps/core/src/app.ts`
- `apps/core/src/app.test.ts`
- API type definitions under `apps/dashboard/src/`
- `apps/dashboard/src/App.tsx`
- aggregate panel components under `apps/dashboard/src/components/`
- dashboard tests under `apps/dashboard/src/`

## Testing Strategy

Automated coverage should include:

- overview metrics filtered to calendar day
- overview metrics filtered to calendar week
- overview metrics filtered to rolling month
- lifetime totals still available when requested
- tool ranking filtered by requested scope
- session list filtered by requested scope
- frontend default scope is `calendar + day`
- frontend renders full `Updated` date-time
- frontend sends scope query parameters on dashboard refresh
- local override affects only the target panel

Manual acceptance should include:

1. Open the dashboard and confirm the default view is the current calendar day.
2. Switch to calendar week and confirm cards/tables change from the daily baseline.
3. Switch to rolling 7 days and confirm results differ from the current calendar week when expected.
4. Switch to lifetime and confirm cumulative totals are still available.
5. Override one aggregate panel locally and confirm other panels keep following the global scope.
6. Confirm `Updated` shows a full date and time.

## Risks

### 1. Timezone Drift Between Browser and API

If the browser and backend use different assumptions, labels and data windows can disagree. The backend must own window math and return enough metadata for the UI to render the active scope accurately.

### 2. Session Boundary Semantics

Filtering sessions by `started_at` is simple and stable, but it means long-running sessions that began before the active window are excluded from the scoped session list. This is acceptable for the first implementation and should be documented in code comments or tests.

### 3. UI Scope Complexity

Global scope plus local overrides can become confusing if too many panels opt out. The first rollout should keep overrides limited to a small number of aggregate panels.

## Success Criteria

- The dashboard no longer defaults to lifetime cumulative totals.
- Users can switch between natural calendar, rolling window, and lifetime views.
- Daily, weekly, and monthly statistics are available without leaving the main dashboard.
- Global scope is the default control model.
- Selected aggregate panels can override global scope without affecting the rest of the page.
- `Updated` shows a full date and time with clear day context.
