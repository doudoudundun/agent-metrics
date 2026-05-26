# Agent Metrics Dashboard Design

## Summary

This project is a local-first plugin-style developer tool for monitoring agent usage, with an initial focus on Claude Code. It provides a dashboard for session and tool activity while keeping the architecture vendor-extensible. The first version prioritizes overview metrics, local storage, low-friction deployment, and data portability.

## Goals

- Provide a local dashboard for agent usage metrics.
- Track tool call counts, successful execution counts, code edit activity, affected file counts, and line insertions/deletions.
- Show estimated token usage from locally visible Claude Code information.
- Refresh the dashboard in near real time.
- Support JSON and CSV export.
- Keep the core architecture vendor-neutral even though v1 only integrates Claude Code.

## Non-Goals

- Precise request-level token billing or API-level metering.
- Multi-user or company-wide aggregation.
- Cross-vendor support in the first release.
- Alerts, rules engines, or anomaly detection.
- Cloud sync, hosted control plane, or account system.
- WebSocket push updates in v1.

## Product Shape

The product is not tied to a specific editor or vendor host UI. It is a local web dashboard plus local background services, designed in a plugin-style project structure. The initial launch path is a wrapper command around Claude Code.

## Supported Launch Modes

### V1 Required Mode

- `wrapper`
  - Example: `agent-metrics wrap claude -- <original args>`
  - This is the only implemented launch mode in v1.
  - It provides the most reliable session boundaries and event capture.

### Future-Compatible Modes

- `alias/shim`
  - A drop-in `claude` proxy placed earlier in `PATH`.
- `activate`
  - A shell activation step that injects environment and paths before normal `claude` use.
- `attach`
  - A daemon that observes logs, session files, or child processes without being the launch path.

The codebase should define a launcher interface so these modes can be added later without reworking storage, metrics, or UI.

## Architecture

The system is split into three main modules:

1. `collector wrapper`
   - Starts Claude Code through the monitored entrypoint.
   - Creates session boundaries.
   - Captures tool-level and edit-related events visible from the local runtime.
   - Writes normalized events to the local ingest path.

2. `local metrics core`
   - Runs as a local service.
   - Accepts normalized events.
   - Persists raw events and derived aggregates.
   - Exposes a local HTTP API for the dashboard and export actions.

3. `dashboard`
   - Runs as a local web app.
   - Focuses on overview metrics first, with session drill-downs available behind summary surfaces.
   - Polls the local API every 5 to 10 seconds for near-real-time updates.

### Architectural Boundary Rules

- The Claude-specific adapter translates Claude Code behavior into generic events.
- The metrics engine only understands normalized events and aggregates.
- The dashboard only consumes API responses and does not parse raw event logs.

This separation keeps the first implementation simple while preserving a clean path to future vendor adapters.

## Event Ingestion Design

The ingestion pipeline is:

`wrapper -> JSONL raw events -> local metrics core -> SQLite aggregates -> dashboard/API`

### Why JSONL First

- It is easy to inspect and debug locally.
- It preserves the original event stream for replay or re-aggregation.
- It decouples event capture from aggregate computation.
- It reduces the impact of transient database or aggregation failures.

### Event Types

The normalized event model must support at least:

- `session.started`
- `session.ended`
- `tool.called`
- `tool.succeeded`
- `tool.failed`
- `code.edit.applied`
- `snapshot.created`
- `ingest_error`

### Event Shape Requirements

All events should include:

- `event_id`
- `session_id`
- `timestamp`
- `source_vendor`
- `source_adapter`
- `workspace_path`

Tool events should additionally include:

- `tool_name`
- `status`
- `duration_ms`
- `argument_summary`

Code edit events should additionally include:

- `tool_name`
- `files_changed`
- `file_count`
- `insertions`
- `deletions`
- `edit_operation_count`

### Token Handling In V1

Token reporting is intentionally low precision in v1.

- Source: locally visible Claude Code information only.
- Accuracy label: always mark token figures as `estimated`.
- V1 does not proxy requests, meter real API responses, or claim billing-grade accuracy.

## Storage Design

V1 uses both JSONL and SQLite:

- `JSONL`
  - raw append-only events
  - replay and debugging source of truth
- `SQLite`
  - query-friendly local store for sessions, tool activity, edit metrics, and rollups

### Core Storage Units

- `sessions`
  - session lifecycle and summary fields
- `tool_events`
  - individual tool call and completion records
- `code_edits`
  - edit-level metrics such as files changed and line deltas
- `daily_rollups`
  - daily and weekly aggregates for faster overview queries
- `export_jobs`
  - export request metadata and filters if async export handling is introduced

## Local API Design

The local metrics core exposes a small HTTP API:

- `GET /api/overview`
  - overview KPIs and trend summaries
- `GET /api/tools`
  - grouped tool metrics such as counts, failures, and average duration
- `GET /api/sessions`
  - recent sessions with summary fields
- `GET /api/sessions/:id`
  - detailed session timeline and edit data
- `GET /api/exports/json`
  - filtered JSON export
- `GET /api/exports/csv`
  - filtered CSV export

The API remains local-only in v1.

## Dashboard Information Architecture

The dashboard is overview-first.

### Primary Surfaces

- KPI header
  - total tool calls
  - successful executions
  - edit operation count
  - affected file count
  - estimated tokens
- Trends
  - today, 7-day, and 30-day activity
- Tool rankings
  - by volume, failure rate, and average duration
- Edit activity
  - recent sessions with changed files and line deltas
- Recent sessions
  - compact summaries with drill-down entry
- Export controls
  - JSON and CSV by time range or filter

### Refresh Model

- Frontend polling every 5 to 10 seconds.
- No WebSocket requirement in v1.
- If recent aggregates are temporarily unavailable, the UI should display stale state rather than blank state.

## Recommended Tech Stack

- `TypeScript` across the full stack
- `Node.js` for CLI wrapper and local service
- `Fastify` for local API service
- `SQLite` for local aggregate storage
- `React + Vite` for the dashboard
- `Recharts` or `Chart.js` for charts
- `pnpm workspace` for monorepo management

## Repository Layout

```text
agent-metrics/
  apps/
    cli/
    core/
    dashboard/
  packages/
    adapters/claude/
    event-schema/
    export-kit/
    metrics-engine/
    shared-utils/
  data/
    events/
    sqlite/
  docs/
    superpowers/
      specs/
      plans/
```

### Package Responsibilities

- `apps/cli`
  - wrapper command and launcher selection
- `apps/core`
  - local API service, ingest coordination, and aggregate refresh
- `apps/dashboard`
  - web UI
- `packages/adapters/claude`
  - Claude Code normalization logic
- `packages/event-schema`
  - shared event and API types
- `packages/metrics-engine`
  - aggregate calculations
- `packages/export-kit`
  - JSON and CSV export formatting
- `packages/shared-utils`
  - path, diff, time, and logging helpers

## Error Handling

- If wrapper startup fails, surface the wrapper error clearly.
- If a single event cannot be parsed, write an `ingest_error` and continue.
- If JSONL write succeeds but SQLite aggregation fails, preserve raw events and allow replay.
- If edit diffs cannot be calculated, keep the edit operation record even when line deltas are missing.
- If the dashboard cannot read fresh aggregate data, show stale data status rather than a blank screen.

## Testing Strategy

### Contract And Unit Tests

- `event-schema`
  - contract tests to keep adapter and core aligned
- `packages/adapters/claude`
  - fixture-driven tests with real or sanitized Claude Code samples
- `packages/metrics-engine`
  - aggregate tests for success rate, edit counts, file counts, line deltas, and token summaries

### Integration Tests

- `apps/core`
  - API tests for overview, tools, sessions, session detail, and exports

### UI Tests

- `apps/dashboard`
  - smoke tests for KPI cards, charts, rankings, and recent session summaries

### End-To-End Test

- Launch the wrapper with simulated events.
- Confirm raw events are written.
- Confirm aggregates are produced.
- Confirm the dashboard API exposes the expected overview.

## Future Expansion

These are explicitly deferred but the design should not block them:

- high-precision token metering through a local or enterprise gateway
- additional vendor adapters
- company-wide aggregation
- alerting and rule definitions
- push-based live updates
- packaged installer and auto-update flow

## Risks And Tradeoffs

- Wrapper-first launch is the most reliable but requires a changed user habit.
- Estimated tokens are useful for directionally understanding usage but must not be presented as billing truth.
- JSONL plus SQLite is slightly more moving parts than a single store, but it gives better recovery and inspectability.
- Polling is simpler than push updates and is adequate for v1, at the cost of slight freshness lag.

## V1 Acceptance Criteria

- A user can start Claude Code through the wrapper command.
- A local session is recorded with start and end boundaries.
- Tool call and success/failure counts are visible in the dashboard.
- Code edit operation count, affected file count, and line deltas are visible in the dashboard.
- Estimated token figures are visible and labeled as estimated.
- Overview metrics refresh without manual page reload.
- JSON and CSV exports work for filtered local data.

## Notes

- This design is written for the new project root at `D:\projects\dev\agent-metrics`.
- The project root is not currently a git repository, so the spec can be written to disk but not committed yet.
