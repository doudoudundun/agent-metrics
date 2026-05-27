# Claude Transcript Usage Design

## Goal

Extend `agent-metrics` so it can:

- capture Claude Code sessions that contain no tool calls and no file edits
- report token usage from Claude Code local transcripts
- keep the product local-first and vendor-tolerant
- preserve the existing hooks-based operational telemetry for tools and code edits

The primary user-visible outcome is simple:

- the dashboard can show how many tokens were used
- pure chat sessions are no longer invisible

## Scope

This design covers:

- transcript-driven ingestion for Claude Code local JSONL files
- normalized events for prompt, response, and token usage
- deduplication rules for repeated transcript records
- aggregate token reporting by day, week, and month
- token grouping by model name as a secondary breakdown
- dashboard and API changes needed to expose the new metrics

This design does not cover:

- billing or cost calculation
- provider-side billing truth reconciliation
- company-wide deployment architecture
- replacing the existing hooks pipeline
- non-Claude transcript formats

## Confirmed Decisions

- Keep the existing hooks pipeline for session, tool, and edit telemetry.
- Add a second transcript ingestion pipeline for conversation and token telemetry.
- Token reporting is usage-only, not money or cost.
- The primary homepage token KPI is one total token number.
- Detailed breakdown may include:
  - `input_tokens`
  - `output_tokens`
  - `cache_read_input_tokens`
  - `cache_creation_input_tokens`
- Total tokens are defined as:
  - `input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- Token metrics must be labeled as Claude Code transcript reported usage.
- Token usage may be grouped by model name when `message.model` is present, but this is a secondary breakdown rather than a homepage headline KPI.
- The initial realtime strategy is:
  - hook-triggered transcript catch-up
  - API-read catch-up before aggregate responses
- Do not start with a heavy OS-level file watcher.

## Current State

The current telemetry model only records:

- `session.started`
- `session.ended`
- `tool.called`
- `tool.succeeded`
- `tool.failed`
- `code.edit.applied`
- `snapshot.created`
- `ingest_error`

The current Claude hook adapter only maps:

- `SessionStart`
- `SessionEnd`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`

As a result, sessions with only user prompts and assistant responses are currently undercounted or fully invisible unless some tool activity happens in the same session.

At the same time, Claude Code local transcripts already contain enough data for token reporting. Local JSONL records include:

- user messages
- assistant messages
- `message.model`
- `message.usage.input_tokens`
- `message.usage.output_tokens`
- `message.usage.cache_creation_input_tokens`
- `message.usage.cache_read_input_tokens`

This means the missing capability is not data availability. The missing capability is ingestion.

## Problem Statement

The product currently answers operational questions such as:

- how many tools were called?
- which tools ran most often?
- how many files were changed?

But it still fails on two important product questions:

- how much token usage happened when the session was mostly conversation?
- what happened in sessions where no tool ran at all?

If this blind spot remains, the dashboard under-reports real activity and makes the token story unreliable.

## Recommended Approach

Adopt a hybrid telemetry model with two inputs and one normalized event layer:

1. Hooks pipeline
   - low-latency operational events
   - session lifecycle
   - tool lifecycle
   - edit detection

2. Transcript pipeline
   - conversation lifecycle
   - assistant completion visibility
   - token usage visibility
   - model breakdown support

3. Unified event layer
   - both inputs normalize into one common event log and one storage/query model

This approach is preferred because:

- hook events remain the fastest path for tool activity
- transcript events fill the no-tool visibility gap
- token usage comes from a concrete local source instead of inference
- future vendor adapters can target the same normalized layer

## Alternatives Considered

### 1. Hook-only extension

Add more Claude hooks such as `UserPromptSubmit` and `Stop`, but do not ingest transcripts.

Pros:

- lower implementation surface
- good realtime behavior

Cons:

- token usage remains incomplete or weak
- still depends on what Claude exposes through hook payloads

### 2. Transcript-only ingestion

Read transcript JSONL files and derive all analytics from them.

Pros:

- richer usage and conversation data
- no dependency on hook event completeness for token reporting

Cons:

- weaker realtime behavior for tool lifecycle
- loses the current operational advantages of hooks

### 3. Hybrid hooks plus transcript ingestion

Keep hooks for operational telemetry and use transcripts for conversation and token telemetry.

Pros:

- best coverage
- best long-term extensibility
- token reporting uses a real local source

Cons:

- more moving parts than either single-source option

Recommendation: option 3.

## Functional Design

### 1. New Normalized Events

Add three normalized event types.

#### `prompt.submitted`

Represents one user prompt entering a session.

Suggested fields:

- `event_id`
- `session_id`
- `timestamp`
- `source_vendor`
- `source_adapter`
- `workspace_path`
- `prompt_id`
- `prompt_chars`

#### `assistant.responded`

Represents one assistant response that should count as a user-visible turn.

Suggested fields:

- `event_id`
- `session_id`
- `timestamp`
- `source_vendor`
- `source_adapter`
- `workspace_path`
- `message_id`
- `model`
- `stop_reason`
- `response_chars`

#### `token.usage.recorded`

Represents one deduplicated usage record reported by Claude Code transcript output.

Suggested fields:

- `event_id`
- `session_id`
- `timestamp`
- `source_vendor`
- `source_adapter`
- `workspace_path`
- `message_id`
- `model`
- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `server_tool_use`
- `usage_source`

`usage_source` should be a constant value such as `claude-transcript`.

### 2. Transcript Ingestion Model

Each transcript file should be treated as an append-only JSONL stream.

The ingestion state for each transcript should store:

- `transcript_path`
- `last_byte_offset`
- `last_seen_timestamp`
- a durable dedupe ledger for processed prompt and message identities

The parser should:

1. open the transcript path
2. seek to the previous byte offset
3. read only new appended content
4. parse complete JSON lines
5. emit normalized events
6. advance the stored cursor

This prevents full-file reprocessing on every update and keeps the local overhead small.

### 3. Deduplication Rules

Transcript records cannot be counted line-by-line. The same assistant message can appear more than once.

Required rules:

1. Deduplicate `assistant.responded` by:
   - `session_id + message_id`

2. Deduplicate `token.usage.recorded` by:
   - `session_id + message_id`

3. Deduplicate `prompt.submitted` by:
   - `session_id + prompt_id`
   - fallback to `session_id + transcript_user_uuid` when `prompt_id` is absent

4. If multiple transcript entries exist for the same assistant `message_id`:
   - prefer the record with the most complete usage payload
   - if one record is intermediate and another is terminal, prefer the terminal record
   - if usage is identical, count it once

These rules are mandatory for token accuracy.

### 4. Trigger Model and Realtime Strategy

Use two trigger layers.

#### Hook-triggered catch-up

Whenever a hook payload contains `transcript_path`, the system should enqueue or directly run transcript catch-up for that file.

Initial hook triggers:

- `SessionStart`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`

Future hook triggers that can improve low-latency chat visibility:

- `UserPromptSubmit`
- `Stop`

#### API-read catch-up

Before serving aggregate endpoints such as:

- `/api/overview`
- `/api/tools`
- `/api/sessions`

the backend should run a cheap pending transcript catch-up pass. This ensures that pure chat sessions still appear after refresh even if no recent tool hook fired.

#### Optional active-session polling

If more immediacy is needed later, the dashboard-backed backend process may poll a small set of recently active transcripts every 2 to 5 seconds while the dashboard is running.

This belongs to the second delivery slice and is not required for the first delivery.

### 5. Aggregation Rules

The dashboard should expose token data through the same scoped reporting model already used for day, week, and month views.

Core aggregates:

- `total_tokens`
- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- `turns`
- `responses`

Definitions:

- `turns = count(prompt.submitted)`
- `responses = count(assistant.responded)`
- `total_tokens = input + output + cache_read + cache_creation`

Secondary aggregate:

- `tokens_by_model`

`tokens_by_model` should group token totals by transcript `model` string when available. Missing model values may be grouped under `unknown`.

### 6. API Contract Changes

The aggregate API should expose token metrics alongside existing tool metrics.

#### `/api/overview`

Add fields such as:

- `totalTokens`
- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheCreationTokens`
- `turnCount`
- `responseCount`

#### `/api/sessions`

Each session summary should add:

- `turnCount`
- `totalTokens`
- `lastModel`

#### `/api/sessions/:id`

Session detail should support a turn-oriented timeline that can show:

- user prompt
- assistant response
- token usage for that assistant response

#### Model grouping endpoint or embedded payload

In the second delivery slice, expose:

- `tokensByModel`

This can either be part of `/api/overview` or a separate dedicated endpoint if payload size becomes an issue.

### 7. Dashboard Changes

The dashboard should stay simple at the top level.

Homepage KPI additions:

- `Total Tokens`
- `Turns`

Session-level detail should show the richer breakdown:

- input tokens
- output tokens
- cache read
- cache created
- model name

Display rules:

- do not display money or estimated cost
- label token numbers as transcript-reported usage
- preserve existing day/week/month scoping behavior

Model grouping should appear as a secondary breakdown, not the main headline KPI.

## Data Model Notes

The normalized schema and storage layer must be extended carefully so existing tool analytics continue to work unchanged.

Important compatibility notes:

- transcript-derived events should use the same base event envelope as existing events
- normalized storage should support per-session joins across hook events and transcript events
- dedupe state must survive restarts
- transcript offsets must survive restarts

## Testing Strategy

### Required Acceptance Scenarios

1. Pure chat session with no tools
   - session appears
   - turns increase
   - total tokens increase
   - tool calls remain zero

2. Mixed session with chat plus tools
   - the same session shows turns, tokens, tool calls, and code edits together

3. Repeated assistant transcript records
   - the same assistant `message_id` appears multiple times
   - token usage is counted once

4. Day, week, and month scopes
   - token totals and turn counts change with scope
   - dashboard no longer behaves as lifetime-only for these metrics

5. Model grouping in the second delivery slice
   - when transcript `model` exists, the session or aggregate view can attribute tokens to that model

### Automated Test Coverage

Add tests for:

- transcript cursor advancement
- partial-line handling
- deduplication of repeated assistant messages
- aggregate total token math
- scoped token queries
- session summaries with token counts
- session detail turn timelines

## Risks

### 1. Transcript shape drift

Claude Code transcript formats may evolve. The parser should be conservative and tolerant of missing fields.

### 2. Duplicate usage records

If dedupe is wrong, token totals will inflate. This is the main correctness risk.

### 3. Intermediate versus terminal records

Some assistant entries may represent a tool-use step or incomplete message. The parser must prefer terminal usage when duplicates exist.

### 4. Model naming variability

Different providers or routing layers may emit model strings with inconsistent names. Token grouping by model should preserve raw strings rather than trying to normalize them aggressively in the first pass.

## Rollout Recommendation

Implement in two delivery slices.

### Slice A

- transcript cursor state
- transcript parsing
- new normalized events
- deduplication
- overview token aggregates
- session summary token totals

This slice solves the core problem:

- pure chat visibility
- token usage visibility

### Slice B

- session detail turn timeline
- model grouping visualizations
- low-latency transcript polling for active sessions

This slice improves inspection depth without blocking the main value.

## Success Criteria

This design is successful when:

- a no-tool Claude Code conversation still produces visible activity in the dashboard
- the dashboard can show token usage for day, week, and month scopes
- token totals are stable across refreshes and restarts
- repeated transcript lines do not inflate totals
- the product still works as a local-first analytics plugin without cost estimation
