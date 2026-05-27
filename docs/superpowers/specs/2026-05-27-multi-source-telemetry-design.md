# Multi-Source Telemetry Design

## Goal

Extend `agent-metrics` from a Claude-centric local telemetry stack into a source-aware local analytics system that can ingest and compare activity from:

- `Claude Code`
- `OpenCode`
- `Codex`

The first delivery must let the dashboard answer three practical questions with one consistent UI:

- which programming tool generated this activity?
- how many sessions, turns, tool calls, and tokens came from each source?
- for Codex specifically, which provider endpoint or host did the token usage likely flow through?

## Scope

This design covers:

- source-aware normalized telemetry across Claude Code, OpenCode, and Codex
- new adapter boundaries for OpenCode and Codex
- storage and API changes required to persist and filter by source
- dashboard changes required to classify, filter, and compare sources
- first-delivery acceptance rules for:
  - high-fidelity OpenCode ingestion
  - coarse but useful Codex ingestion

This design does not cover:

- Codex first-delivery per-tool execution detail
- Codex first-delivery precise code-edit attribution
- billing or money estimation
- company-wide centralized deployment
- replacing the existing local-first architecture

## Confirmed Decisions

- Source classification is a first-class feature, not a dashboard-only post-processing trick.
- The design follows a source-first normalized event model.
- `OpenCode` first delivery must support fine-grained event ingestion.
- `Codex` first delivery only needs:
  - session visibility
  - token totals
  - model visibility when available
  - provider endpoint or host visibility
- The dashboard must support a global source filter alongside the existing time filter.
- Missing source-specific dimensions must be shown as unavailable, not silently coerced to zero.
- Token reporting is usage-only and does not include cost.
- The existing `events.jsonl` normalized log remains the shared source of truth for local rebuilds.

## Current State

The current repository already has three important foundations:

1. Claude hooks ingestion
   - operational telemetry for sessions, tools, and code edits

2. Claude transcript ingestion
   - prompt, response, token, and model usage from local transcript JSONL

3. One normalized query layer
   - `apps/core` ingests normalized events into SQLite
   - `apps/dashboard` reads aggregate APIs from that SQLite cache

The current limitation is that the normalized model is still effectively single-source in practice:

- `token.usage.recorded.usage_source` only allows `claude-transcript`
- SQLite tables do not yet persist `source_vendor` and `source_adapter`
- aggregate APIs do not yet filter or break down by source
- the dashboard cannot distinguish Claude activity from any future OpenCode or Codex activity

At the same time, local source data for OpenCode and Codex has already been confirmed to exist.

### Confirmed OpenCode Local Source

OpenCode keeps local state in:

- `~/.local/share/opencode/opencode.db`

Confirmed useful tables and fields:

- `session`
  - `id`
  - `directory`
  - `time_created`
  - `time_updated`
  - `time_archived`
  - `tokens_input`
  - `tokens_output`
  - `tokens_reasoning`
  - `tokens_cache_read`
  - `tokens_cache_write`
- `message`
  - role
  - created/completed time
  - provider/model metadata
  - token payloads
- `part`
  - `text`
  - `reasoning`
  - `tool`
  - tool state with status and timing

### Confirmed Codex Local Sources

Codex keeps useful local state in:

- `~/.codex/sessions/**/rollout-*.jsonl`
- `~/.codex/history.jsonl`
- `~/.codex/logs_2.sqlite`
- `~/.codex/config.toml`

Confirmed useful facts:

- rollout files include:
  - `session_meta`
  - `custom_tool_call`
  - `patch_apply_end`
  - `token_count`
- config can include provider endpoint information such as:
  - `model_providers.<id>.base_url`

The project therefore does not have a data-availability problem. It has a normalization and source-modeling problem.

## Problem Statement

The dashboard is moving from "one local Claude telemetry pipeline" to "one local agent analytics surface that compares multiple programming tools." That introduces four concrete requirements:

1. source provenance must survive end-to-end
   - ingestion
   - storage
   - aggregate queries
   - dashboard rendering

2. different sources must be allowed to have different fidelity
   - OpenCode can provide fine-grained tool and token events
   - Codex first delivery can provide only session and token visibility

3. provider endpoint visibility must become queryable where available
   - especially for Codex

4. the system must remain local-first and rollback-safe
   - no cloud collector
   - no vendor lock-in
   - rebuildable from local event history

If source attribution is bolted on after ingestion, later queries become fragile and the dashboard cannot reliably answer source comparison questions.

## Recommended Approach

Adopt one source-aware normalized event layer with separate source adapters.

The core idea is simple:

- keep one shared event contract
- make source identity mandatory on normalized events
- keep each raw-source parser isolated in its own adapter package
- let `apps/core` remain source-agnostic once events are normalized

This approach is preferred because it preserves current architecture strengths:

- one query model
- one dashboard
- one local event ledger
- easy future extension to more tools

It also matches the confirmed delivery target:

- OpenCode first delivery: high fidelity
- Codex first delivery: coarse but source-visible

## Alternatives Considered

### 1. Source-first normalized event model

Make `source_vendor` and `source_adapter` first-class in schema, storage, API, and dashboard before adding OpenCode and Codex adapters.

Pros:

- clean architecture
- durable query model
- easy dashboard source filtering
- safe foundation for future adapters

Cons:

- broader first-pass change set
- requires schema migration and regression coverage

Recommendation: choose this option.

### 2. Patch new sources into existing tables without source foundations

Use existing tables with minimal new fields and encode source meaning indirectly through `usage_source`, `tool_name`, or ad hoc JSON.

Pros:

- faster short-term ingestion

Cons:

- weak source filtering
- brittle queries
- future technical debt

### 3. Keep each source in separate query paths

Create separate OpenCode and Codex storage/query flows and merge only in the UI.

Pros:

- highest raw-source isolation

Cons:

- duplicates logic
- complicates the dashboard
- weakens the normalized event architecture

## Functional Design

### 1. Architecture Boundaries

The system remains split into four layers.

#### `adapters-*`

Each source gets an isolated adapter package.

- `adapters-claude`
  - existing Claude hooks and transcript support
- `adapters-opencode`
  - new adapter that reads local `opencode.db`
- `adapters-codex`
  - new adapter that reads local rollout/history/config/log sources

Adapter responsibilities are limited to:

- reading local source state incrementally
- mapping source-specific records into normalized events

Adapters do not own:

- aggregate metrics
- dashboard formatting
- SQLite query semantics

#### `event-schema`

This remains the single shared contract for normalized events.

Source differences are represented through standardized fields rather than by proliferating source-specific event types.

#### `apps/core`

`apps/core` remains the orchestration, ingestion, and aggregate query layer.

Its responsibilities become:

- run source synchronizers safely
- ingest normalized events into SQLite
- expose source-aware aggregate APIs

It should not need to understand OpenCode SQL shape or Codex rollout line formats directly.

#### `apps/dashboard`

The dashboard remains one UI over the shared API.

Its responsibilities become:

- expose source filters
- show source breakdowns
- display unavailable dimensions clearly for lower-fidelity sources

### 2. Source Identity Model

Source identity and usage origin must be modeled separately.

#### `source_vendor`

Product-level identity of the programming tool that produced the activity.

First-delivery canonical values:

- `claude-code`
- `opencode`
- `codex`

#### `source_adapter`

The local ingestion path that observed the activity.

First-delivery canonical values:

- `claude-hook`
- `claude-transcript`
- `opencode-db`
- `codex-rollout`
- `codex-history`
- `codex-logs`

Dashboard primary filtering uses `source_vendor`. Operational debugging can use `source_adapter`.

#### `usage_source`

This remains specific to token derivation, not product identity.

First-delivery canonical values should include:

- `claude-transcript`
- `opencode-message`
- `codex-rollout`
- `codex-logs`

This separation prevents one field from carrying multiple meanings.

### 3. Storage and Query Model

The normalized SQLite cache must persist source provenance across all relevant tables.

#### Required schema additions

Add `source_vendor` and `source_adapter` to:

- `sessions`
- `tool_events`
- `prompt_events`
- `assistant_responses`
- `token_usage_events`
- `code_edits`

Add source/time indexes so source filtering does not degrade dashboard responsiveness.

#### Provider metadata

Add nullable provider fields where they can be known:

- `provider_id`
- `provider_base_url`
- `provider_host`

These are most important on:

- `token_usage_events`
- `assistant_responses`
- session summary queries derived from those tables

#### Aggregate rules

- `totalTokens` remains derived, not stored:
  - `input + output + cache_creation + cache_read`
- event ingestion must be idempotent through stable `event_id`
- SQLite remains a query cache
- `events.jsonl` remains rebuildable truth

#### Migration strategy

Use additive migrations only:

- add columns
- add indexes
- keep current tables rebuildable from normalized events

Do not rely on a one-time brittle rewrite script as the only upgrade path.

### 4. OpenCode Adapter Design

OpenCode is the first high-fidelity non-Claude source.

#### Read model

Primary source tables:

- `session`
- `message`
- `part`

Use `message` and `part` as the primary truth for detailed telemetry. Use `session.tokens_*` and `session.summary_*` only as fallback references, not as the main counting source.

#### Normalized event mapping

- `session.started`
  - from `session.time_created`
- `session.ended`
  - from `session.time_archived` when present
- `prompt.submitted`
  - from `message.role = user`
  - `prompt_chars` from concatenated user text parts
- `assistant.responded`
  - from `message.role = assistant`
  - `response_chars` from assistant text parts
  - `model` from `providerID/modelID`
- `token.usage.recorded`
  - from assistant message token payload
  - `usage_source = opencode-message`
- `tool.succeeded`
  - from `part.type = tool` with completed status
- `tool.failed`
  - from `part.type = tool` with error status

#### `tool.called`

Only emit `tool.called` if a stable tool-start boundary can be extracted without guesswork. Otherwise, first delivery may omit it rather than fake precision.

#### `code.edit.applied`

Only emit when a tool record clearly exposes file-write intent and target files can be extracted with confidence.

Do not synthesize code-edit detail from coarse session summary fields in first delivery.

#### Provider fields

OpenCode first delivery should record:

- `source_vendor = opencode`
- `source_adapter = opencode-db`
- `provider_id`
- `model`

It should not aggressively infer provider base URLs when they are not directly available.

#### Incremental sync strategy

Use durable cursors plus stable `event_id`.

Suggested identity patterns:

- `opencode:session:<id>:started`
- `opencode:session:<id>:ended`
- `opencode:message:<id>:prompt`
- `opencode:message:<id>:assistant`
- `opencode:message:<id>:usage`
- `opencode:part:<id>:tool:<status>`

This keeps repeated syncs idempotent and prevents session-level token double-counting.

### 5. Codex Adapter Design

Codex first delivery is intentionally coarse-grained.

#### Read model

Primary source:

- `~/.codex/sessions/**/rollout-*.jsonl`

Supporting sources:

- `~/.codex/history.jsonl`
- `~/.codex/config.toml`
- `~/.codex/logs_2.sqlite`

#### Source priority

- rollout files are the primary business telemetry source
- config is the provider endpoint source
- history is only a metadata fallback
- logs are diagnostic or reconciliation support, not first-delivery primary accounting

#### First-delivery normalized event mapping

- `session.started`
  - from rollout `session_meta` or equivalent session start record
- `session.ended`
  - only when a stable end signal exists
- `token.usage.recorded`
  - from rollout `token_count`
  - `usage_source = codex-rollout`

`assistant.responded` is optional in first delivery. If rollout boundaries are not stable enough, omit it rather than emitting weak records.

#### Provider endpoint extraction

Extract provider metadata from `config.toml` where available:

- `provider_id`
- `provider_base_url`
- `provider_host`

The dashboard should at minimum be able to show token usage grouped by `provider_host` or provider identity for Codex sessions.

#### Why tool detail is deferred

Although Codex rollout data contains `custom_tool_call` and `patch_apply_end`, first-delivery tool and code-edit detail is deferred because it still needs clear rules for:

- parent versus sub-agent attribution
- tool start/end pairing
- file-change precision

Those problems should be solved in a later design slice rather than rushed into a misleading first release.

#### Incremental sync strategy

Use stable event identities derived from:

- source file path
- session identity
- source event identity when present

`history.jsonl` and `logs_2.sqlite` must not become duplicate token sources in first delivery.

### 6. Core Synchronization Model

`apps/core` should orchestrate multiple source synchronizers safely.

#### Synchronization rules

- each source sync runs as its own single-flight action
- one source failing must not fail unrelated source reads
- API requests should serve stale-but-valid cached metrics when a source sync fails

This extends the same resilience pattern already added for Claude transcript synchronization.

#### Event ingestion rules

The ingestion path stays source-agnostic:

- parse normalized event
- upsert by `event_id`
- preserve source and provider columns

#### API rules

Aggregate endpoints should accept an optional `sourceVendor` query parameter:

- `all`
- `claude-code`
- `opencode`
- `codex`

Filtering semantics:

- first apply time window
- then apply source filter

### 7. API Contract Changes

#### `/api/overview`

Keep current KPI fields and add:

- `sourceBreakdown`
  - per source:
    - `sessionCount`
    - `turnCount`
    - `totalTokens`
    - `toolCalls`
- `providerBreakdown`
  - token totals by `provider_host` or `provider_id`

#### `/api/tools`

- support `sourceVendor`
- in `all` mode, aggregate by tool name across sources
- optionally include source contribution metadata
- when filtered to one source, preserve simple ranking behavior

#### `/api/sessions`

Each session row should include:

- `sourceVendor`
- `sourceAdapter`
- `providerId` when known
- `providerHost` when known

#### `/api/sessions/:id`

Each timeline entry should include:

- `sourceVendor`
- `sourceAdapter`
- `usageSource` for token events
- provider/model metadata where available

### 8. Dashboard Design

The dashboard remains one screen with compact filtering and comparison.

#### Global filters

Keep time scope as the first global filter and add source selection beside it:

- `All`
- `Claude Code`
- `OpenCode`
- `Codex`

Changing source should refresh aggregate cards and tables without a full page reload, matching the intended time-scope interaction model.

#### Top-level KPIs

Top cards continue to reflect the current global time and source filter:

- sessions
- turns
- tokens
- tool calls
- edit operations

#### Source breakdown panel

Add a compact source comparison panel that shows, for each source:

- sessions
- turns
- tokens
- tool calls

This gives immediate cross-source visibility even when the global filter is `All`.

#### Tools panel behavior

- `All` mode:
  - show cross-source top tools
- single-source mode:
  - show that source's tool ranking
- for lower-fidelity sources such as first-delivery Codex:
  - show an explicit unavailable state instead of a misleading empty success metric

#### Session timeline behavior

Timeline rows should show source tags. Token rows should show:

- model
- provider where available
- token usage origin

#### Missing-data policy

Use explicit unavailable states for unsupported dimensions.

Do not conflate:

- "no activity happened"
- "this source does not expose this dimension yet"

### 9. Testing Strategy

#### `event-schema`

Add coverage for:

- expanded `usage_source`
- valid source-aware events from Claude, OpenCode, and Codex

#### `adapters-opencode`

Add fixture-driven tests for:

- session mapping
- prompt mapping
- assistant mapping
- token mapping
- tool success/failure mapping
- idempotent incremental sync
- no double-counting from session summary token fields

#### `adapters-codex`

Add fixture-driven tests for:

- rollout session extraction
- rollout token extraction
- config endpoint extraction
- endpoint normalization into provider fields
- graceful degradation when optional metadata is absent

#### `apps/core`

Add coverage for:

- source-aware migration
- source column persistence
- source filter behavior
- source breakdown aggregation
- provider breakdown aggregation
- multi-source sync failure isolation

#### `apps/dashboard`

Add coverage for:

- global source filter changes
- interaction between time scope and source filter
- source breakdown rendering
- unavailable-state rendering for lower-fidelity sources
- card-level refresh without full page reload

### 10. Delivery Phases

#### Phase 1: source-aware foundation

- expand normalized event schema
- migrate SQLite tables
- extend aggregate APIs for source filtering and breakdowns

#### Phase 2: OpenCode integration

- create `packages/adapters-opencode`
- sync fine-grained OpenCode events into the normalized ledger
- expose OpenCode in source-aware dashboard views

#### Phase 3: Codex integration

- create `packages/adapters-codex`
- sync session, token, model, and provider endpoint data
- expose Codex in source-aware dashboard views

#### Phase 4: hardening

- real local data verification
- regression coverage
- prepare follow-on design slice for Codex tool and edit detail

## First-Delivery Acceptance Criteria

The first delivery is successful when all of the following are true:

1. `All` source view shows combined local activity from:
   - Claude Code
   - OpenCode
   - Codex

2. `OpenCode` source view can show:
   - sessions
   - prompts and assistant turns
   - token usage
   - tool success/failure
   - code edits only where precisely attributable

3. `Codex` source view can show:
   - sessions
   - token totals
   - model where available
   - provider endpoint or host where available

4. source filtering and time filtering work together without full page reload

5. unsupported source dimensions render as explicitly unavailable rather than silently misleading zero-values

## Risks

### 1. Source schema drift

OpenCode and Codex local formats may evolve. Adapters must be tolerant of missing or reordered fields.

### 2. Token double-counting

This is the primary correctness risk for OpenCode and Codex. First delivery must prefer one primary token truth per source and keep fallback sources out of the main aggregate path.

### 3. Provider attribution ambiguity

Codex provider endpoint association may initially be approximate if configuration changes occur between sessions. First delivery should document this clearly rather than overstate certainty.

### 4. UI confusion between zero and unavailable

If the dashboard does not distinguish unsupported dimensions from real zero activity, users will mistrust the data. The unavailable state is a product requirement, not optional polish.

## Success Criteria

This design is successful when:

- source provenance is preserved end-to-end from raw local data into the dashboard
- the dashboard can compare Claude Code, OpenCode, and Codex in one surface
- OpenCode appears as a high-fidelity source
- Codex appears as a lower-fidelity but still useful source with provider visibility
- aggregate queries remain local, rebuildable, and source-aware
- the architecture stays extensible for future source adapters without rewriting the dashboard model
