# Agent Metrics Architecture and Desktop Widget Refactor Specification

Date: 2026-07-17
Specification revision: 2
Status: Approved direction, implementation not started
Audience: implementation agents, reviewers, and maintainers
Authority: this revision supersedes the earlier architecture documents listed in section 3 where they conflict; only a later approved ADR or a higher numbered revision of this specification may override it

## 1. Purpose

This specification defines the target architecture and migration constraints for refactoring Agent Metrics. It covers:

- normalized telemetry event semantics
- token accounting
- tool-call lifecycle correlation
- Core synchronization, ingestion, storage, queries, and API boundaries
- shared API and Electron IPC contracts
- Dashboard data loading and information architecture
- Desktop main-window architecture
- the floating dashboard, orb, and peek-card replacement
- packaging, testing, observability, and rollout requirements

This is an implementation specification, not a statement that the target structure already exists. Agents MUST distinguish the current state in section 4 from the target state in later sections.

## 2. Normative Language

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

- MUST: required for the refactor to be accepted
- MUST NOT: prohibited because it violates a boundary or compatibility constraint
- SHOULD: expected unless a documented technical reason prevents it
- SHOULD NOT: avoid unless there is a documented technical reason
- MAY: optional and does not block acceptance

## 3. Authority and Relationship to Existing Documents

This document is authoritative for the refactor described here.

The following documents remain useful as historical context but do not override this specification:

- `docs/superpowers/specs/2026-05-25-agent-metrics-dashboard-design.md`
- `docs/superpowers/specs/2026-05-27-dashboard-time-scopes-design.md`
- `docs/superpowers/specs/2026-05-27-multi-source-telemetry-design.md`
- `docs/superpowers/specs/2026-05-30-desktop-dashboard-design.md`
- `docs/superpowers/specs/2026-06-05-desktop-orb-peek-card-design.md`

When this document conflicts with an earlier document, this document wins. In particular:

- the target Desktop model is Main Window plus one Widget Window
- the target Core API does not synchronize sources in GET request hooks
- token accounting has one shared semantic definition
- API and Electron contracts are shared rather than manually duplicated

## 4. Current State Baseline

Agents MUST inspect the repository before editing because the branch may contain work in progress. At the time this specification was written, the relevant current state is:

- `apps/core/src/app.ts` contains database creation, migrations, source synchronization, event-log ingestion, aggregate SQL, API routes, exports, and response assembly.
- Core API requests run source synchronization through an `onRequest` hook.
- token accounting rules are repeated across `packages/metrics-engine` and several Core queries.
- tool lifecycle correlation is inferred from `event_id` suffixes for some adapters.
- Claude hook and transcript tool events can use unrelated random event IDs for one logical tool call.
- `apps/dashboard/src/App.tsx` owns surface routing, polling, request state, panel overrides, session selection, and Desktop snapshot synchronization.
- Dashboard responses and Desktop bridge types are maintained separately from Core response definitions.
- Desktop currently manages main, floating, orb, and peek-card windows.
- `apps/desktop/src/main.ts` owns most Electron lifecycle, window, widget, IPC, drag, hover, and persistence behavior.
- packaged runtime deployment includes more workspace content than runtime execution needs.

Known baseline verification issues at document creation time:

- root TypeScript checking fails because some Dashboard test fixtures do not satisfy current production types
- Core tests can discover real local ZCode, Codex, or Cursor data unless every source path is isolated
- OpenCode totals are inconsistent between some aggregate dimensions because token rules are duplicated

Agents MUST NOT describe this baseline as already refactored.

## 5. Goals

The refactor MUST achieve the following outcomes:

1. Every adapter emits events with explicit, stable semantics.
2. Every visible token total is computed from one accounting policy.
3. Tool start and finish events are correlated by a dedicated tool-call identifier.
4. API reads do not trigger source synchronization.
5. Adapter failure does not block unrelated API reads or unrelated adapters.
6. Core modules are separated by ownership and reason to change.
7. Core and Dashboard share validated response contracts.
8. Electron main, preload, and renderer share validated IPC contracts.
9. Dashboard polling is deduplicated, cancellable, and aware of stale data.
10. Desktop uses one Main Window and one Widget Window.
11. The Widget Window owns collapsed, expanded, and pinned presentation states.
12. Existing local telemetry is migrated without destructive reset.
13. Browser Dashboard usage remains supported.
14. Windows and macOS packaging remain supported.
15. Tests and builds do not depend on telemetry installed on the developer machine.

## 6. Non-Goals

This refactor MUST NOT include:

- replacing SQLite with a remote database
- converting the project into microservices
- rewriting the backend in another language
- replacing Electron with Tauri or another shell
- requiring cloud accounts, remote telemetry, or authentication
- removing the JSONL audit log before a tested replacement exists
- introducing Redux solely to manage request state
- redesigning source adapters beyond changes required by normalized contracts
- implementing auto-update, signing, notarization, or store distribution
- deleting user telemetry as a migration strategy

## 7. Target System Architecture

```text
Claude / OpenCode / ZCode / Codex / Cursor
                    |
                    v
             Sync Adapters
                    |
                    v
            Sync Coordinator
        scheduling / locks / retry
                    |
                    v
        Normalized Event Log Writer
                    |
                    v
          SQLite Event Projector
                    |
                    v
        Repositories + Query Services
                    |
                    v
             Fastify Routes
                    |
                    v
        @agent-metrics/contracts
              /             \
             v               v
     Browser Dashboard   Electron Desktop
                         Main + Widget
```

Required dependency direction:

```text
contracts        -> no app dependencies
schema/domain    -> no app dependencies
adapters         -> event schema + shared utilities
core             -> adapters + domain + contracts + SQLite/Fastify
Dashboard        -> contracts; no imports from Core source
Desktop          -> contracts; no imports from Dashboard internals
```

Circular workspace dependencies MUST NOT be introduced.

## 8. Target Package and Directory Map

The final names MAY differ slightly when required by existing package conventions, but ownership boundaries MUST remain equivalent.

```text
packages/
  event-schema/
    src/
      events.ts
      sources.ts
      tool-lifecycle.ts
      usage.ts
      index.ts

  metrics-engine/
    src/
      token-accounting.ts
      overview.ts
      index.ts

  contracts/
    src/
      common.ts
      overview.ts
      sessions.ts
      sync.ts
      desktop.ts
      index.ts

apps/core/src/
  server.ts
  bootstrap.ts

  config/
    runtime-config.ts

  db/
    connection.ts
    schema.ts
    migrations/
      runner.ts
      001-initial.ts
      002-tool-call-id.ts
      003-token-semantics.ts
      004-sync-state.ts
    repositories/
      event-repository.ts
      session-repository.ts
      sync-state-repository.ts

  ingest/
    event-log-reader.ts
    event-log-cursor.ts
    event-projector.ts

  sync/
    sync-adapter.ts
    sync-coordinator.ts
    sync-scheduler.ts

  queries/
    overview-query.ts
    token-query.ts
    tool-query.ts
    session-query.ts
    timeline-query.ts

  routes/
    overview-route.ts
    token-route.ts
    tool-route.ts
    session-route.ts
    sync-route.ts
    export-route.ts

apps/dashboard/src/
  app/
    AppShell.tsx
    SurfaceRouter.tsx
    DashboardPage.tsx
    WidgetPage.tsx

  data/
    query-client.ts
    useOverviewQuery.ts
    useTokenTrendQuery.ts
    useToolsQuery.ts
    useSessionsQuery.ts
    useSyncStatusQuery.ts

  components/
    shell/
    overview/
    sessions/
    tools/
    widget/
      WidgetSurface.tsx
      WidgetCollapsed.tsx
      WidgetExpanded.tsx
      WidgetMetricStrip.tsx
      WidgetStatus.tsx

apps/desktop/src/
  main.ts
  bootstrap.ts

  windows/
    main-window.ts
    widget-window.ts
    window-manager.ts

  widget/
    widget-controller.ts
    widget-state.ts
    widget-layout.ts

  ipc/
    register-desktop-ipc.ts

  runtime/
    process-supervisor.ts
    child-logger.ts

  persistence/
    desktop-settings.ts
    window-state.ts
```

Agents SHOULD prefer moving tested code into these boundaries over rewriting working logic.

## 9. Normalized Event Contract

### 9.1 Common Validation and Naming

All newly emitted events MUST satisfy the runtime schema in `@agent-metrics/event-schema`; TypeScript types alone are not a boundary check. The current target schema version is `2`.

```ts
type SourceVendor = "claude-code" | "opencode" | "codex" | "cursor";
type SourceAdapter =
  | "claude"
  | "claude-hook"
  | "claude-transcript"
  | "opencode-db"
  | "zcode-db"
  | "cursor-ide"
  | "codex-rollout"
  | "codex-history"
  | "codex-logs";
type UsageSource =
  | "claude-transcript"
  | "opencode-message"
  | "opencode-step-finish"
  | "cursor-generation"
  | "cursor-composer-context"
  | "codex-rollout"
  | "codex-logs";
type InputTokenSemantics = "delta" | "gross";
type UsageMeasurement = "increment" | "session-context-snapshot";

type SessionKey = {
  sourceInstanceId: string;
  sessionId: string;
};

type BaseEventV2 = {
  schema_version: 2;
  event_id: string;
  session_id: string;
  timestamp: string;
  source_vendor: SourceVendor;
  source_adapter: SourceAdapter;
  source_instance_id: string;
  adapter_instance_id: string;
  source_record_namespace: string;
  source_record_id: string | null;
  workspace_path: string;
};
```

`source_instance_id` identifies one configured telemetry installation/database/root, not one coordinator run. It MUST be a stable non-secret ID persisted in the adapter-instance registry. Default IDs are `claude:default`, `opencode:default`, `zcode:default`, `codex:default`, and `cursor:default`; additional configured roots receive a persisted UUID-based suffix. `adapter_instance_id` is the stable registry key for the collector configuration that emitted the observation, such as `zcode-db@zcode:default`. `source_record_namespace` names the native store/record kind (`hook`, `transcript`, table/part type, rollout/log table), and `source_record_id` is its stable native record ID or null. ZCode remains `source_vendor: "opencode"` with `source_adapter: "zcode-db"`; UI labels MAY display ZCode separately, but domain grouping MUST NOT invent a fifth vendor without a later schema revision.

A session's canonical identity is `(source_instance_id, session_id)`. A bare `session_id` is unique only within one source instance. Every session table key, foreign key, count, grouping, route parameter, cursor tie-breaker, and tool-call key MUST use `SessionKey`.

Common rules:

- identifiers MUST be non-empty UTF-8 strings and MUST NOT contain secrets or prompt content
- `timestamp` MUST be RFC 3339 and normalize to UTC millisecond precision using `new Date(value).toISOString()` before identity hashing or storage
- token counts and durations MUST be finite, safe, non-negative integers; a source adapter MUST reject or quarantine invalid records rather than silently take absolute values
- missing token counters MUST normalize to zero only when the source contract defines absence as zero
- `workspace_path` input MUST be absolute unless the source genuinely has no workspace, in which case the literal `.` is retained as unknown; normalization converts `\` to `/`, removes redundant `.` segments and trailing separators except filesystem roots, uppercases a Windows drive letter, preserves UNC server/share text and path-segment case, and does not resolve `..`, symlinks, or require the path to exist
- snake_case is the serialized event and database-column convention; camelCase is used only inside TypeScript domain/API objects through an explicit `NormalizedUsage` mapper that converts every field at the event parser or repository boundary
- raw source records MAY be retained separately for diagnostics, but normalized event fields MUST contain only schema-defined values and MUST NOT change meaning by adapter
- schema version `1` and unversioned historical records are legacy input; compatibility parsers MUST convert them to the version `2` in-memory domain form before projection
- writers MUST NOT emit mixed schema versions after their adapter is migrated

### 9.2 Event Identity

`event_id` is the globally unique idempotency key stored as the raw-event primary key. Its construction is mandatory:

```text
stable source record ID available:
  v2:<source_instance_id>:<source_record_namespace>:<event_kind>:sha256(<session_id>, <source_record_id>)

no stable source record ID:
  v2:<source_instance_id>:<source_record_namespace>:<event_kind>:sha256(<canonical_identity_fields>)
```

`event_kind` is the serialized `type`. Digest is lowercase hexadecimal SHA-256 over UTF-8 RFC 8785 canonical JSON. Native IDs are trimmed, invalid when empty, and otherwise case-sensitive. With a native record ID, hash `{ "sessionId": session_id, "sourceInstanceId": source_instance_id, "sourceRecordId": source_record_id }`. Fallback identity includes `sourceInstanceId`, `sourceRecordNamespace`, `sessionId`, `eventKind`, canonical UTC `timestamp`, source-native sequence, and adapter-documented location fields. `source_record_namespace` intentionally distinguishes hook/transcript/database observations: separate source records describing one logical tool call have different `event_id` values and converge only through `tool_call_id`/aliases. Each adapter documents and pins complete identity strings. Random UUID is allowed only for a live record with neither stable ID nor stable fields; replayable adapters MUST NOT use it.

Projection computes `semantic_fingerprint = sha256(RFC 8785 JSON of the complete normalized event excluding source_adapter and adapter_instance_id provenance)`. Only observations of the same native record namespace/ID are expected to share `event_id`. A repeat with the same fingerprint adds provenance idempotently; a different fingerprint creates a uniquely keyed identity conflict and excludes that event projection until repaired. First-writer-wins is prohibited.

Canonical event rows and collector provenance are separate:

```text
event_observations
  event_id
  adapter_instance_id
  source_adapter
  observed_at
  PRIMARY KEY (event_id, adapter_instance_id)
```

Adapter-instance filtering matches a canonical row when any observation uses a requested instance; a row matching multiple requested instances is counted once. Source-adapter enum filtering, when added to an internal query, follows the same `EXISTS` rule.

Two different logical events MUST NOT share an `event_id`. Start and terminal tool events are different events and therefore MUST have different `event_id` values even though they share a tool call identity.

### 9.3 Tool Call Identity

Every `tool.called`, `tool.succeeded`, and `tool.failed` event MUST include:

```ts
tool_call_id: string;
```

`tool_call_id` is unique only within `SessionKey`. The canonical database/query identity is therefore:

```ts
type ToolCallKey = SessionKey & {
  toolCallId: string;
};
```

Rules:

- start and terminal events for the same logical invocation MUST have the same `tool_call_id`
- `tool_call_id` MUST NOT be inferred by parsing `event_id` for new events
- adapters MUST use the source's native tool-use, call, request, or part ID when it is stable within a session
- if a source lacks a native ID, the observation MUST derive `sha256(RFC 8785 JSON of source_instance_id, session_id, canonical timestamp/source sequence, tool name, and the adapter-documented source record/part location)` and prefix it with `derived:`
- repeated source records MUST be handled by `event_id` idempotency, not by creating extra tool calls
- a missing start MAY create a terminal-only projected call with `started_at = null`; a later start fills it without changing terminal state
- start candidates and terminal candidates are independently ordered by `(timestamp, event_id)`; the earliest valid candidate of each kind is canonical regardless of ingestion order
- an event with an existing semantic fingerprint is idempotent evidence; a later lifecycle candidate with a different fingerprint is retained as diagnostic evidence and does not replace the canonical candidate
- if a newly ingested event sorts before a current canonical start or terminal, projection MUST recompute the call from all raw lifecycle events in one transaction
- a terminal event's tool name MUST match the canonical start when both are present; a mismatch is quarantined rather than merged
- aggregate queries MUST count the composite `ToolCallKey`, including terminal-only calls, exactly once

Claude convergence is mandatory when evidence is unambiguous, but raw observations keep their original identity:

1. hook events use `tool_use_id` when available
2. transcript `tool_use` and `tool_result` use the transcript tool-use ID
3. matching trimmed native IDs normalize directly to `native:<id>`
4. hook events without a native ID retain deterministic observed `derived:` IDs
5. projection builds a same-`SessionKey`, same-tool-name candidate graph with edges only when timestamps differ by at most 5 seconds
6. a hook aliases to a transcript `native:` identity only when both nodes have degree one; many-to-one matching is prohibited
7. arrival of relevant observations recomputes the affected graph; an edge becoming ambiguous atomically revokes its alias and rebuilds the affected projected calls
8. zero or multiple candidates keep separate derived identities and record a diagnostic; the projector MUST NOT guess

The alias table retains observed and canonical IDs plus rule version and evidence event IDs. Adapter fixture tests MUST cover native-ID convergence, unique fallback alias, ambiguous fallback, alias revocation, terminal-before-start, duplicate/conflicting start, and duplicate/conflicting terminal cases.

### 9.4 Closed Event Union

The version `2` runtime schema MUST be a strict discriminated union; unknown keys are rejected at the normalized boundary. Provider metadata fields remain present because current adapters already emit them.

```ts
type ProviderMetadata = {
  provider_id: string;            // literal "unknown" when unavailable
  provider_base_url?: string | null;
  provider_host?: string | null;
};

type NormalizedEventV2 =
  | (BaseEventV2 & { type: "session.started" })
  | (BaseEventV2 & {
      type: "session.ended";
      exit_code?: number | null;
      duration_ms?: number;
    })
  | (BaseEventV2 & {
      type: "tool.called";
      tool_call_id: string;
      tool_name: string;
      status: "started";
      argument_summary: string;
    })
  | (BaseEventV2 & {
      type: "tool.succeeded" | "tool.failed";
      tool_call_id: string;
      tool_name: string;
      status: "succeeded" | "failed";
      duration_ms: number;
    })
  | (BaseEventV2 & {
      type: "code.edit.applied";
      tool_name: string;
      files_changed: string[];
      file_count: number;
      insertions: number;
      deletions: number;
      edit_operation_count: number;
    })
  | (BaseEventV2 & {
      type: "prompt.submitted";
      prompt_id: string;
      prompt_chars: number;
    })
  | (BaseEventV2 & ProviderMetadata & {
      type: "assistant.responded";
      message_id: string;
      model?: string | null;
      stop_reason?: string | null;
      response_chars: number;
    })
  | TokenUsageRecordedEvent
  | (BaseEventV2 & {
      type: "snapshot.created";
      file_path: string;
      snapshot_role: "before" | "after";
    })
  | (BaseEventV2 & {
      type: "ingest_error";
      message: string;
    });
```

For terminal tool events, the `type` and `status` pair MUST match. All count/duration fields follow section 9.1 validation. `edit_operation_count` is positive; other counters are non-negative.

### 9.5 Token Usage Semantics

A normalized usage event MUST preserve source-reported counters and explicitly state input semantics and measurement type.

```ts
type TokenUsageRecordedEvent = BaseEventV2 & ProviderMetadata & {
  type: "token.usage.recorded";
  message_id: string;
  model?: string | null;
  input_tokens: number;
  input_token_semantics: InputTokenSemantics;
  usage_measurement: UsageMeasurement;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use: string;        // validated serialized JSON object
  usage_source: UsageSource;
};
```

`provider_id` is normalized by the adapter or set to literal `unknown`; projection MUST NOT infer it from model text. `server_tool_use` is preserved for compatibility and MUST parse as a JSON object whose numeric counters are finite non-negative integers where present.

Meaning:

- `delta`: `input_tokens` excludes cache-read input
- `gross`: `input_tokens` includes cache-read input and excludes cache-creation input

For `gross`, `cache_read_input_tokens > input_tokens` is invalid source data and MUST be quarantined. It MUST NOT be silently clamped in storage. Non-negative clamping in display helpers is defensive compatibility behavior for legacy rows only and MUST emit a diagnostic counter.

Current exhaustive mapping:

| `usage_source` | Adapter(s) | Semantics | Measurement | Migration evidence/rule |
|---|---|---|---|---|
| `claude-transcript` | `claude-transcript` | `delta` | `increment` | transcript fixture |
| `opencode-message` | `opencode-db`, `zcode-db` | `gross` | `increment` | used only when no step-finish usage exists for the message |
| `opencode-step-finish` | `opencode-db`, `zcode-db` | `gross` | `increment` | preferred OpenCode/ZCode message usage fixture |
| `cursor-generation` | `cursor-ide` | `delta` | `increment` | generation token columns fixture |
| `cursor-composer-context` | `cursor-ide` | `delta` | `session-context-snapshot` | context/`totalUsedTokens` snapshot; excluded from additive totals |
| `codex-rollout` | `codex-rollout` | `gross` | `increment` | rollout usage fixture |
| `codex-logs` | `codex-logs` | `gross` | `increment` | logs database fixture |

`codex-history` does not emit usage unless a later fixture adds a registry row. `session-context-snapshot` rows MAY be shown as context diagnostics but MUST NOT contribute to Overview, trend, model/provider/source/session totals, exports, or Widget metrics. Adding a new usage source or changing a mapping requires a schema revision, fixture, and numbered migration; adapters and queries MUST NOT apply an unregistered fallback.

The mapping MUST be encoded by `usage_source` at adapter normalization, not inferred from vendor in queries. Historical migration MUST use this exhaustive registry keyed by `(source_adapter, usage_source)`. Unknown pairs remain in raw storage and a uniquely keyed pending-usage-migration table. A later registry addition MUST replay pending rows idempotently and rerun reconciliation.

For historical Codex rows, the migration MUST inspect the existing `schema_migrations` marker `codex-raw-input-tokens-v1`: marked rows already store gross input and MUST NOT add cache-read again; unmarked pre-migration Codex rows require the old conversion exactly once inside the new transactional migration. Marker adoption and conversion MUST be covered by both marked and unmarked fixtures.

Usage idempotency MUST use `event_id`. When multiple collectors expose the same source-instance-native usage record, their normalizers MUST converge even though `source_adapter` differs. Records with distinct native message/turn IDs are additive even when all counters and timestamps match. A compatibility deduplicator MAY suppress a legacy duplicate only when source instance, session, message ID, model, timestamp, usage source, and all token counters match exactly; heuristic time-window deduplication is prohibited.

### 9.6 Canonical Token Accounting

The canonical accounting functions MUST live in `@agent-metrics/metrics-engine` or a more specific shared domain package.

```ts
type NormalizedUsage = {
  inputTokenSemantics: InputTokenSemantics;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

function toNormalizedUsage(event: TokenUsageRecordedEvent): NormalizedUsage {
  return {
    inputTokenSemantics: event.input_token_semantics,
    inputTokens: event.input_tokens,
    outputTokens: event.output_tokens,
    cacheCreationInputTokens: event.cache_creation_input_tokens,
    cacheReadInputTokens: event.cache_read_input_tokens
  };
}

function displayedInputTokens(usage: NormalizedUsage): number {
  if (usage.inputTokenSemantics === "delta") return usage.inputTokens;
  if (usage.cacheReadInputTokens > usage.inputTokens) {
    throw new InvalidUsageError("gross input is smaller than cache-read input");
  }
  return usage.inputTokens - usage.cacheReadInputTokens;
}

function totalTokens(usage: NormalizedUsage): number {
  return (
    displayedInputTokens(usage) +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}
```

Overview, model, source, provider, session, trend, timeline, export, and Widget snapshot totals MUST use this policy.

Canonical aggregate definitions:

- total tokens: sum of `totalTokens` over the filtered normalized usage rows
- displayed input: sum of `displayedInputTokens`
- output/cache read/cache creation: sums of the corresponding stored normalized counters
- provider: `provider_id` stored in the normalized event; unknown values are the literal `unknown`, so every additive usage row belongs to exactly one provider group
- cache hit rate: `cache_read_input_tokens / (displayed_input_tokens + cache_read_input_tokens + cache_creation_input_tokens)`, expressed as `0` when the denominator is zero
- sessions: distinct composite `SessionKey` values in the filtered dataset
- tool success rate: succeeded logical calls divided by terminal logical calls; calls without a terminal state are excluded from the denominator
- model grouping: SQL uses `COALESCE(model_id, 'unknown')`; null model rows are never dropped

Acceptance invariant:

> For a fixed filtered additive usage dataset, the sum of model, source-vendor, provider, and composite-session totals MUST each equal the Overview total. Adapter groups are overlapping provenance filters and are not an additive reconciliation dimension.

No Core SQL query MAY contain a vendor-specific token formula after migration completion. If SQL aggregation is required for performance, the shared domain module MUST expose the SQL expression or the normalized database columns MUST make the SQL vendor-neutral.

## 10. Database and Migration Design

### 10.1 Versioned Migrations

Core MUST use a migration runner. On first startup against an existing unversioned database, migration `000-adopt-legacy-baseline` MUST inspect table/column/index shapes and existing named markers, record a matching baseline version without rewriting data, then allow later migrations to run. An unknown or partially matching schema MUST abort with a diagnostic and backup instruction rather than being treated as fresh. Fresh databases run the same migration sequence from version `000`; schema creation MUST NOT bypass the runner.

Every migration MUST:

- have a stable monotonically increasing version and name
- run inside one SQLite transaction
- update schema/data and write its migration marker atomically
- be skipped when the marker already exists; data migrations MUST additionally tolerate process restart before commit
- adopt existing markers such as `codex-raw-input-tokens-v1` as explicit migration inputs rather than deleting or rerunning them
- have automated fresh-database, each recognized historical-shape, preexisting-marker, rollback-on-failure, and repeat-run tests
- preserve existing user data

Application startup MAY mutate operational state through normal repository transactions, including ingestion cursors, sync status, and newly projected events. Schema changes and one-time historical rewrites MUST occur only through tracked migrations.

Historical migration to schema version `2` MUST run in this order inside versioned migrations:

1. create canonical raw events, event observations, diagnostics, source-instance registry, and version `2` projection tables without deleting legacy tables/columns
2. assign the documented default `source_instance_id` for each existing adapter installation and backfill `schema_version = 1` for unversioned rows
3. derive token semantics and measurement by the exhaustive `(source_adapter, usage_source)` registry in section 9; unknown pairs enter `pending_usage_migrations` and are accounted for but excluded from normalized aggregates
4. copy provider metadata, `server_tool_use`, and counters into raw/canonical storage, applying the existing Codex marker rule exactly once and validating all constraints
5. replay original raw sources when available to recover native `tool_call_id`; otherwise pair only unambiguous legacy event-ID suffixes and assign a deterministic `legacy:<event_id>` identity to each uncorrelated lifecycle event, with `legacy_uncorrelated` diagnostic
6. rebuild projections from canonical rows and observations
7. run reconciliation before writing the migration marker

Reconciliation succeeds only when:

- every historical row is counted exactly once as normalized, pending, ambiguous, invalid, or legacy-uncorrelated
- normalized raw token-counter sums equal an independent fold through the registry and canonical domain functions
- projected tool calls equal a recomputation from raw lifecycle rows and aliases
- no `event_id` has multiple semantic fingerprints outside the identity-conflict diagnostic set
- model/source-vendor/provider/composite-session totals satisfy section 9.6

A migration MUST abort and roll back if reconciliation fails. Rollback compatibility means the previous release can start and read all pre-upgrade telemetry and pre-upgrade settings; it need not see events or settings written only after upgrade. Legacy tables/columns MUST therefore remain readable for one compatibility release. If a phase requires stronger rollback visibility, it MUST dual-write the previous representation and test it. Removal follows section 23.

### 10.2 Diagnostics and Repair

Projection/migration diagnostics use a durable table keyed by `(diagnostic_code, source_instance_id, event_id, evidence_fingerprint)`. Required codes include `IDENTITY_CONFLICT`, `LEGACY_UNCORRELATED`, `AMBIGUOUS_TOOL_ALIAS`, `INVALID_USAGE`, `PENDING_USAGE_MAPPING`, and `MALFORMED_JSONL`. Each row stores first/last seen UTC time, occurrence count, bounded sanitized summary, raw-record locator or log file identity/offset, resolution state, and resolver migration/version. Prompt/source payload content is not copied into the diagnostic row.

Replays upsert the same key and MUST NOT create duplicate diagnostics. Diagnostics remain for the telemetry retention period and are never auto-resolved because a later replay omitted the record. Repair occurs only through a numbered migration or an explicit local repair command that supports dry-run, creates a database backup, records the prior/new fingerprint and resolver version, rebuilds affected projections transactionally, and reruns reconciliation. The current refactor need not provide a repair UI.

### 10.3 Tool Lifecycle Projection

The database MUST store `tool_call_id` separately from `event_id`. The query model MUST project one logical row per composite call identity:

```text
tool_calls
  source_instance_id
  session_id
  tool_call_id
  tool_name
  started_at NULL
  finished_at NULL
  status                         -- started | succeeded | failed
  duration_ms NULL
  diagnostic_flags NULL
  PRIMARY KEY (source_instance_id, session_id, tool_call_id)
```

Raw event rows remain separate. Aggregate queries MUST count projected composite call identities rather than event suffixes.

Projection conflict rules are those in section 9.3. Updating a terminal-only row with a later start MUST preserve `finished_at` and terminal status. Duration is calculated only when both timestamps exist and `finished_at >= started_at`; otherwise it remains null and a diagnostic is recorded.

### 10.4 Usage Storage

The selected storage representation is mandatory; it is not an implementation choice:

```text
usage_events
  event_id PRIMARY KEY
  schema_version
  source_instance_id
  source_vendor
  session_id
  message_id
  occurred_at
  model_id NULL
  provider_id                  -- normalized value or literal 'unknown'
  provider_base_url NULL
  provider_host NULL
  input_token_semantics        -- delta | gross
  usage_measurement            -- increment | session-context-snapshot
  raw_input_tokens
  displayed_input_tokens
  output_tokens
  cache_creation_input_tokens
  cache_read_input_tokens
  server_tool_use
  semantic_fingerprint
```

Collector provenance is stored only in `event_observations`; canonical rows MUST NOT select a first-writer `source_adapter`. `raw_input_tokens` preserves the normalized source-reported `input_tokens`. `displayed_input_tokens` MUST be computed by the canonical domain function during projection and stored to make SQL aggregation vendor-neutral. All token columns use non-negative integer checks. Projecting the same event/fingerprint again MUST not add counters twice; a conflicting fingerprint follows section 9.2.

Queries MUST sum only `usage_measurement = 'increment'`, use normalized columns without vendor branches, and join observations only for adapter filters with an `EXISTS` predicate so one event is counted once. A fixture test MUST compare stored `displayed_input_tokens` with the domain function for every registered usage source and legacy path.

### 10.5 Required Indexes

At minimum, high-volume tables MUST have named indexes for their real time and identity columns:

| Table | Required index columns |
|---|---|
| `sessions` | `(source_instance_id, started_at)` |
| canonical raw events | `(source_instance_id, timestamp)` and `(event_id, semantic_fingerprint)` |
| `event_observations` | `(adapter_instance_id, event_id)` and `(source_adapter, event_id)` |
| `tool_calls` | `(source_instance_id, session_id, started_at)`; primary key handles call lookup |
| `usage_events` | `(source_instance_id, occurred_at)` and `(source_instance_id, session_id, occurred_at)` |
| `session_contexts` | `(source_instance_id, updated_at)` |
| sync state | `(adapter_instance_id)` and queued runs by `(status, accepted_at)` |

Legacy tables retain their existing `created_at`/`started_at`/`updated_at` names until removed; migrations MUST NOT issue one blanket timestamp index against unlike tables. Agents MUST use `EXPLAIN QUERY PLAN` for introduced high-volume queries and assert the expected index name in query tests.

## 11. Event Log Ingestion

### 11.1 Raw Ingress and Canonical Log Ownership

Raw hook capture MUST remain Core-independent. A short-lived hook process writes one envelope per event to a source-instance spool directory using:

1. create a uniquely named `.tmp` file in the destination directory
2. write the complete UTF-8 JSON envelope and flush/close it
3. atomically rename it to `.json`

Consumers ignore `.tmp` files. A crash before rename may leave a bounded orphan cleaned after 24 hours; a crash after rename leaves a complete discoverable envelope. Raw spool envelopes retain source-native IDs and payloads needed for later normalization, subject to the existing sensitive-data policy. Source databases/transcripts remain external raw inputs and do not need copying into the spool.

The canonical normalized JSONL has exactly one writer lease at a time. Core's coordinator is the normal owner. A one-shot/compatibility CLI parser MAY acquire the same OS-released exclusive lease only while Core is absent; failure to acquire it exits without writing. Raw hook processes MUST NOT append directly to canonical JSONL and MUST NOT require Core availability.

The lease owner consumes ready spool files in stable filename order, validates/normalizes them, appends complete version `2` records, flushes the append, then atomically records the spool filename and resulting event ID in its checkpoint store. A crash before checkpoint may replay the envelope; `event_id`/fingerprint rules make replay safe. Processed raw envelopes remain retained under the configured telemetry retention policy; cleanup MUST NOT occur merely because projection succeeded.

Every canonical append contains one complete UTF-8 JSON record plus `\n` in one file append operation. Source synchronizers submit normalized records to the leased writer component rather than opening the canonical file independently. While no lease owner runs, raw spool and external source data accumulate and are processed on the next startup/manual parse.

### 11.2 Incremental Projection

The ingestion cursor MUST store:

```ts
type EventLogCursor = {
  fileIdentity: string;
  committedOffset: number;
  committedPrefixHash: string;
};
```

`fileIdentity` uses platform file identity when available and otherwise lowercase-hex SHA-256 of RFC 8785 JSON containing canonical path, creation time, and lowercase-hex SHA-256 of the first 4 KiB. `committedPrefixHash` is lowercase-hex SHA-256 of up to the final 4 KiB ending at `committedOffset`; at offset zero it is SHA-256 of empty bytes. It detects in-place replacement.

The event-log reader MUST:

- open the file and read byte ranges from the committed offset; steady-state ingestion MUST NOT use whole-file `readFile`
- process only newline-terminated records and preserve an incomplete trailing line for the next pass
- skip and report malformed newline-terminated records without blocking later valid records
- project one bounded batch and update its cursor in the same SQLite transaction
- create prepared SQLite statements once per projector rather than inside the per-event loop
- make replay safe through `event_id` idempotency

Recovery is deterministic:

1. if file identity and committed-prefix hash match, resume from `committedOffset`
2. if file size is smaller than the offset, identity changed, or prefix validation fails, reset the candidate read offset to zero without deleting projected rows
3. replay from zero; existing `event_id` values are ignored idempotently and new values are projected
4. commit the replacement file identity and new offset only with the successfully projected batch

The implementation MUST NOT advance beyond an incomplete trailing record. A malformed committed line advances the cursor past that line only after its diagnostic has been recorded in the same transaction. Tests MUST cover append, partial line, malformed line, truncation, same-path replacement, replay, and interruption between projection and cursor commit.

## 12. Synchronization Architecture

### 12.1 Sync Adapter Interface

Every source synchronizer MUST be wrapped behind a common interface:

```ts
type SyncAdapter = {
  adapterInstanceId: string;
  sourceInstanceId: string;
  sourceAdapter: SourceAdapter;
  sourceVendor: SourceVendor;
  enabled: boolean;
  sync(context: { runId: string; signal: AbortSignal }): Promise<SyncResult>;
};

type SyncResult = {
  discoveredRecords: number;
  committedUniqueEvents: number;
  projectedUniqueEvents: number;
  projectionWatermark: number;
};
```

`adapter_instance_id` is a stable registry key unique within Core and maps one synchronizer configuration to one `source_instance_id`; it is not the adapter enum. Example defaults are `claude-transcript@claude:default` and `zcode-db@zcode:default`. Coordinator time, not adapter-returned time, is authoritative. An adapter MAY continue using existing cursor files during early migration, but the coordinator boundary MUST exist before request-triggered sync is removed.

### 12.2 Sync Coordinator

The coordinator MUST:

- initialize enabled adapters as `idle` and disabled adapters as `disabled`
- run initial synchronization after routes are ready without blocking API startup
- schedule periodic synchronization independently from API reads
- use a global concurrency limit of `2` and FIFO order by acceptance time
- prevent overlapping or multiply queued runs of the same adapter instance
- allow different adapter instances to run independently
- record adapter and run status
- catch adapter errors without terminating Core
- expose manual refresh through the POST endpoints in section 12.4
- stop accepting work and abort queued/active runs during clean shutdown

```ts
type SyncAdapterStatus = "idle" | "queued" | "syncing" | "ready" | "stale" | "error" | "disabled";
type SyncRunStatus = "queued" | "syncing" | "succeeded" | "failed" | "aborted";

type SyncAdapterState = {
  adapterInstanceId: string;
  sourceInstanceId: string;
  sourceAdapter: SourceAdapter;
  sourceVendor: SourceVendor;
  status: SyncAdapterStatus;
  activeRunId: string | null;
  pendingRunId: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulAt: string | null;
  nextScheduledAt: string | null;
  lastError: { code: string; summary: string } | null;
  consecutiveFailures: number;
};

type SyncRun = {
  runId: string;
  adapterInstanceId: string;
  status: SyncRunStatus;
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  discoveredRecords: number;
  committedUniqueEvents: number;
  projectedUniqueEvents: number;
  projectionWatermark: number | null;
  error: { code: string; summary: string } | null;
};
```

State transitions are deterministic:

| Current condition | Event | Next status |
|---|---|---|
| adapter disabled | schedule/manual request | `disabled`; no run is accepted |
| enabled, capacity available | run accepted | `syncing`; set `activeRunId` |
| enabled, capacity full | run accepted | `queued`; set `pendingRunId` |
| already queued | another trigger | remain `queued`; coalesce onto pending run |
| already syncing | another trigger | remain `syncing`; coalesce onto active run |
| `syncing` | succeeded through projection watermark | `ready`; clear error/reset failures |
| `syncing`, previous success exists | failure | `stale`; retain committed data/increment failures |
| `syncing`, no previous success | failure | `error`; increment failures |
| `ready` | freshness deadline passes | `stale` |
| disabled becomes enabled | configuration change | `ready` if prior success is fresh, `stale` if expired, otherwise `idle` |
| queued/active | shutdown | run becomes `aborted`; adapter restores pre-run stable state without failure increment |

A failed run MAY leave already committed unique events visible; run counters include only committed canonical events/observations, not attempted writes. A run reaches `succeeded` only after discovery ends, its canonical JSONL appends are durable, and projection atomically commits through its `projectionWatermark`; a subsequent GET MUST observe all accepted events from that run. Adapter state and terminal run metadata commit atomically. Completed run records remain queryable for at least one hour. The freshness deadline is `max(2 * periodicSyncInterval, 5 minutes)`. Error summaries are sanitized and bounded to 2 KiB.

### 12.3 API Read Semantics

GET routes MUST NOT invoke adapters, discover sources, append normalized events, project event-log records, advance ingestion cursors, or otherwise mutate synchronization state. Event-log projection is coordinator-owned background work and is tested independently from source discovery.

A failed adapter MUST NOT make `/api/overview`, `/api/tools`, `/api/token-trend`, or `/api/sessions` unavailable when previously projected data exists. Responses use the latest committed projection and expose freshness through the sync status contract.

### 12.4 Sync Endpoints

Target endpoints:

```text
GET  /api/sync/status
GET  /api/sync/runs/:runId
POST /api/sync
POST /api/sync/:adapterInstanceId
```

The contracts package MUST define these payloads:

```ts
type SyncStatusResponse = {
  generatedAt: string;
  shuttingDown: boolean;
  adapters: SyncAdapterState[];
};

type ManualSyncRequest = {
  reason?: string; // sanitized, maximum 200 characters
};

type ManualSyncDisposition = "started" | "queued" | "coalesced";

type ManualSyncResponse = {
  requestId: string;
  acceptedAt: string;
  runs: Array<{
    adapterInstanceId: string;
    runId: string;
    disposition: ManualSyncDisposition;
  }>;
};

type SyncRunResponse = SyncRun;
```

`POST /api/sync` targets all enabled adapter instances. `POST /api/sync/:adapterInstanceId` targets exactly one. Both return `202` immediately. If an instance is active or queued, the request reuses that run ID with `coalesced`; it MUST NOT queue another run. `queued` is used only when the global concurrency limit delays the accepted run.

`GET /api/sync/runs/:runId` returns `200 SyncRunResponse`; unknown/expired IDs return `404 SYNC_RUN_NOT_FOUND`. Dashboard polls non-terminal runs every one second with no overlapping request and waits for every returned run to become terminal before refreshing view data; `failed`/`aborted` preserves stale data and displays the per-run error. Polling stops at terminal state or after one hour, when the run is treated as expired.

Error responses follow section 13. Unknown adapter instance IDs return `404 ADAPTER_NOT_FOUND`; disabled instances return `409 ADAPTER_DISABLED`; a shutting-down coordinator returns `503 SYNC_SHUTTING_DOWN`; invalid bodies return `400 INVALID_REQUEST`. A manual endpoint MUST NOT hold the HTTP connection open until synchronization finishes.

## 13. Core Query and Route Boundaries

Routes MUST be thin. A route is responsible for:

- parsing request parameters with the shared runtime schema
- calling one query/application service
- parsing the complete outbound payload with its response schema before sending it
- mapping expected domain errors to the shared HTTP error contract

Routes MUST NOT contain:

- source scanning or event-log projection
- migration logic
- per-vendor token formulas
- large SQL blocks
- Desktop-specific behavior

Query modules MUST own SQL and response-row mapping. Database repositories MUST own reusable persistence operations.

All analytics endpoints MUST preserve the existing calendar/rolling/lifetime model and use this additive filter contract:

```ts
type TimeScope =
  | { mode: "calendar" | "rolling"; range: "day" | "week" | "month" }
  | { mode: "lifetime"; range: "day" | "week" | "month" }
  | { mode: "custom"; startAt: string; endAt: string };

type AnalyticsFilter = TimeScope & {
  sourceVendors?: SourceVendor[];
  sourceInstanceIds?: string[];
  adapterInstanceIds?: string[];
  workspacePaths?: string[];
};
```

GET serialization uses scalar `mode`, `range`, `startAt`, `endAt` keys and repeated keys for arrays, for example `sourceVendor=codex&sourceVendor=cursor`. Parameters are strict: duplicates of scalar keys, unknown enum values, URL-decoding errors, or inappropriate bounds return `400 INVALID_REQUEST`; omission defaults to `{ mode: "calendar", range: "day" }`. `custom` requires canonical RFC 3339 bounds with `startAt < endAt`; non-custom modes reject bounds. All intervals are `[startAt, endAt)`. One server request timestamp is captured before resolving named scopes. Calendar scopes use the configured IANA timezone; rolling day/week/month are 24 hours/7 days/30 days; lifetime has null bounds and ignores `range` semantically while preserving it for current response compatibility.

Within one filter dimension, values combine with OR; different dimensions combine with AND. Omitted arrays mean all. An explicitly present empty array in a programmatic contract means no rows, but HTTP cannot encode it and clients MUST short-circuit without a request. Array values are normalized, deduplicated, and sorted before query-key/cursor fingerprinting. Workspace filters compare the section 9.1 normalized key. Adapter-instance matching uses event observations and counts a canonical event once. Time comparisons use normalized occurrence time, not ingestion time.

List and timeline endpoints additionally use cursor pagination:

```ts
type PageRequest = { limit?: number; cursor?: string };
type PageResponse<T> = { rows: T[]; nextCursor: string | null };
```

The default limit is `50`, maximum `200`. Cursors are opaque, versioned, URL-safe base64url RFC 8785 JSON containing the filter fingerprint and final sort key; malformed, expired-version, or mismatched-filter cursors return `400 INVALID_CURSOR`. Ordering is:

- sessions: `lastActivityAt DESC, sourceInstanceId ASC, sessionId ASC`
- session timeline: `createdAt ASC, eventId ASC`
- tools: bounded non-paginated ranking `count DESC, toolName ASC`, maximum 200 rows
- token trend: chronological fixed buckets, no cursor

Session detail/timeline paths use `/api/sources/:sourceInstanceId/sessions/:sessionId`; both segments are URL-encoded exact identifiers. The old `/api/sessions/:id` remains as a compatibility route only when the bare ID matches exactly one source instance; zero matches return `404 SESSION_NOT_FOUND`, multiple return `409 AMBIGUOUS_SESSION_ID`.

Exports use the same GET filter encoding as tools, stream UTF-8 rows ordered `count DESC, toolName ASC`, and use filenames `agent-metrics-tools-<UTC timestamp>.json|csv`. A stream failure closes the response and logs the request ID; no success trailer is invented. No hard export row cap is applied because tool names are already a bounded aggregate, but HTTP/server output backpressure MUST be honored.

### 13.1 HTTP Response Contracts

All response keys use camelCase. Counts/token values are finite non-negative integers; rates are finite numbers in `[0, 1]`. Timestamps are canonical UTC RFC 3339 strings.

```ts
type AggregateMeta = {
  mode: "calendar" | "rolling" | "lifetime" | "custom";
  range: "day" | "week" | "month" | null;
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
  updatedAt: string;
};

type TokenComponents = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

type OverviewResponse = AggregateMeta & TokenComponents & {
  sessionCount: number;
  turnCount: number;
  responseCount: number;
  totalToolCalls: number;
  successfulExecutions: number;
  failedExecutions: number;
  startedOnlyExecutions: number;
  successRate: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  tokensByModel: Array<TokenComponents & { model: string }>;
  sourceBreakdown: Array<{
    sourceVendor: SourceVendor;
    sessionCount: number;
    turnCount: number;
    totalTokens: number;
    toolCalls: number;
  }>;
  providerBreakdown: Array<{ providerId: string; providerHost: string | null; totalTokens: number }>;
};

type ToolRow = {
  toolName: string;
  count: number;
  failures: number;
  averageDurationMs: number;
};

type TokenTrendPoint = TokenComponents & {
  bucketStart: string;
  label: string;
  cacheHitRate: number;
};

type SessionRow = {
  sourceInstanceId: string;
  sessionId: string;
  workspacePath: string;
  sourceVendor: SourceVendor;
  sourceAdapters: SourceAdapter[];
  providerId: string;
  providerHost: string | null;
  turnCount: number;
  totalTokens: number;
  lastModel: string | null;
  lastActivityAt: string;
};

type SessionTimelineEntry = {
  eventId: string;
  createdAt: string;
  type: NormalizedEventV2["type"];
  sourceVendor: SourceVendor;
  sourceAdapters: SourceAdapter[];
  toolCallId: string | null;
  toolName: string | null;
  status: string | null;
  durationMs: number | null;
  providerId: string | null;
  providerHost: string | null;
  filesChanged: string[];
  insertions: number | null;
  deletions: number | null;
  promptId: string | null;
  promptChars: number | null;
  messageId: string | null;
  model: string | null;
  stopReason: string | null;
  responseChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  usageSource: UsageSource | null;
};

type SessionDetailResponse = AggregateMeta & {
  sourceInstanceId: string;
  sessionId: string;
  workspacePath: string;
  sourceVendor: SourceVendor;
  sourceAdapters: SourceAdapter[];
  context: { executionPath: string | null; skillsLoaded: boolean; skillNames: string[] } | null;
  timeline: PageResponse<SessionTimelineEntry>;
};

type WidgetSnapshotResponse = {
  generatedAt: string;
  scope: { mode: "rolling"; range: "day"; windowStart: string; windowEnd: string };
  metrics: TokenComponents & {
    sessionCount: number;
    logicalToolCalls: number;
    cacheHitRate: number;
    toolSuccessRate: number;
    editOperationCount: number;
    affectedFileCount: number;
  };
};
```

The Widget scope is always rolling 24 hours in revision `2`; it does not inherit Dashboard filters. Expanded content uses total tokens as primary metric and logical tool calls, sessions, cache hit rate, and success rate as the four secondary metrics. No implementation-selected metric subset is allowed in this revision.

Endpoint ownership is fixed:

| Method/path | Request | Success | Response/order | Specific errors |
|---|---|---|---|---|
| `GET /api/health` | none | `200` | `{ status: "ok", apiVersion: 2, eventSchemaVersion: 2 }` | `503 NOT_READY` |
| `GET /api/overview` | `AnalyticsFilter` query | `200` | `OverviewResponse` | filter errors |
| `GET /api/token-trend` | `AnalyticsFilter` query | `200` | `AggregateMeta & { rows: TokenTrendPoint[] }`, chronological | filter errors |
| `GET /api/tools` | `AnalyticsFilter` query | `200` | `AggregateMeta & { rows: ToolRow[] }`, ranking order | filter errors |
| `GET /api/sessions` | filter + `PageRequest` | `200` | `AggregateMeta & PageResponse<SessionRow>` | cursor/filter errors |
| `GET /api/sources/:sourceInstanceId/sessions/:sessionId` | filter + timeline `PageRequest` | `200` | `SessionDetailResponse` | `404 SESSION_NOT_FOUND`, cursor errors |
| `GET /api/widget-snapshot` | no analytics filter | `200` | `WidgetSnapshotResponse` | `503 PROJECTION_NOT_READY` |
| `GET /api/exports/json` | `AnalyticsFilter` | `200` stream | `ToolRow[]` JSON | filter/stream errors |
| `GET /api/exports/csv` | `AnalyticsFilter` | `200` stream | header plus `ToolRow` rows | filter/stream errors |
| sync endpoints | section 12.4 | stated there | stated there | stated there |

All endpoint response schemas, including export JSON rows and `/api/health`, live in `@agent-metrics/contracts`. Endpoint additions require schema, table entry, tests, and owning phase.

### 13.2 HTTP Error and Local Security Contract

Every non-2xx API response MUST satisfy:

```ts
type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, string | number | boolean>;
  };
};
```

Messages MUST be sanitized and safe to show in the UI. Stack traces, filesystem records, SQL, and source payloads MUST NOT cross the HTTP boundary.

Core MUST bind only explicitly configured numeric loopback addresses (`127.0.0.1` and/or `::1`), never wildcard interfaces. `Host` must match the bound loopback host and configured port. Browser requests with an `Origin` header require an exact allowlist entry for the configured Dashboard development origin or packaged/local Dashboard origin; permissive/reflected CORS is prohibited. State-changing methods require a trusted `Origin` and reject missing or `null` origin; native/non-browser callers use an unguessable startup token supplied through protected runtime configuration and sent as `X-Agent-Metrics-Token`. GET responses containing telemetry use `Cache-Control: no-store`. DNS resolution is not accepted as proof of loopback.

## 14. Shared Contracts

Create `@agent-metrics/contracts`. It MUST depend on and re-export shared source/event identifiers from `@agent-metrics/event-schema`; it MUST NOT redeclare `SourceVendor`, `SourceAdapter`, `UsageSource`, or event-type literals. The event-schema and contracts packages MUST provide strict Zod runtime schemas and schema-inferred TypeScript types for:

- common source and time-scope fields
- Overview response
- token trend response
- tool ranking response
- session list response
- session detail response
- sync status response
- Desktop settings exposed to the renderer
- Desktop widget snapshot
- Electron IPC request and response payloads

The contracts package MUST NOT import Fastify, Electron, React, or SQLite.

Core MUST parse route inputs and complete outbound response objects with the contract schemas. Dashboard MUST parse every HTTP success and error payload before use. Desktop main MUST parse IPC requests, preload MUST parse IPC responses before returning them, and renderers MUST consume only inferred contract types. Constructing an object with a TypeScript annotation is not runtime validation.

Generic casts such as `rows as T[]`, passthrough `unknown`, and partial row validation MUST NOT be used at external boundaries.

## 15. Dashboard Data Architecture

### 15.1 App Responsibilities

`App.tsx` MUST stop owning every request and every Desktop surface branch.

Target separation:

- `SurfaceRouter`: chooses browser, Desktop main, or Desktop widget page
- `DashboardPage`: full analytics workspace
- `WidgetPage`: compact Desktop widget renderer
- query hooks/client: fetching, cancellation, deduplication, refresh, stale data
- presentational components: rendering only

### 15.2 Query Client Requirements

The Dashboard query layer MUST:

- normalize query keys using the section 13 sorted/deduplicated filter encoding and deduplicate identical in-flight requests
- cancel obsolete requests when source/time scope changes and apply a 10-second request timeout
- use a 30-second visible-document polling interval for aggregate/status data, plus or minus up to 10% per-client jitter
- never start another interval request while the previous request for that key is unresolved
- expose `loading`, `refreshing`, `stale`, `error`, and `data`
- preserve last successful data during transient failures
- support `refreshView()` for projected GET data and `syncSources()` for POST sync/run polling followed by view refresh
- stop periodic polling while the document is hidden
- resume with immediate view refresh when visible
- retry interval failures only at the next scheduled poll; manual commands MAY retry once after one second, but automatic exponential retries MUST NOT overlap polling

The Top Bar refresh command invokes `refreshView()`. A source synchronization command is labeled “Sync sources,” displays accepted/queued/coalesced and terminal run state, and MUST NOT masquerade as immediate completion.

A proven small query library MAY be adopted if it does not create a large migration burden. A local query client is also acceptable. Redux MUST NOT be added only for this purpose.

### 15.3 Dashboard Information Architecture

The target full Dashboard is an operational telemetry workspace, not a marketing page.

Required structure:

```text
Top Bar
  product name
  live/stale/offline state
  source filter
  time scope
  refresh
  Desktop-only window/settings actions when available

Overview Strip
  sessions
  turns
  tool calls
  total tokens
  cache hit rate

Primary Workspace
  activity/token trend
  recent sessions
  tool ranking
  model/provider usage
  selected session timeline
```

The large promotional Hero pattern SHOULD be removed or reduced to a compact toolbar/header.

Panel-local time overrides MAY remain, but the UI MUST clearly indicate when a panel is not following global scope.

### 15.4 Visual System

The visual system MUST prioritize scanning, comparison, and repeated use.

Requirements:

- standard card radius SHOULD be 6px to 8px
- sections MUST NOT be presented as nested cards
- decorative radial gradients, glow blobs, and bokeh-style effects MUST be removed
- typography MUST use stable sizes rather than viewport-width scaling
- controls MUST use appropriate icons, segmented controls, selects, toggles, and tooltips
- icon buttons SHOULD use the repository's selected icon library; add one shared icon library if none exists
- status MUST not be communicated by color alone
- loading, empty, stale, offline, syncing, and error states MUST be designed
- text MUST fit at supported Desktop and browser widths
- the palette SHOULD combine neutral surfaces with distinct success, warning, error, and accent colors rather than one dominant hue family

The target palette MAY use:

```text
background: warm-neutral light gray
surface: white or near-white
strong surface: graphite
text: near-black
accent: restrained lime/green
info: cyan/blue
warning: amber
error: red
```

Exact colors are implementation details, but the constraints above are normative.

## 16. Desktop Window Model

### 16.1 Required Windows

The target Desktop application MUST define exactly two product-window roles and MUST create at most one instance of each:

1. Main Window
2. Widget Window

The Widget instance MAY be absent when disabled or not yet lazily created under section 16.8. Transient native menus and dialogs do not count as product windows.

The following separate windows MUST be retired after the compatibility transition:

- floating window
- orb window
- peek-card window

Their user-visible capabilities MUST move into the Widget Window.

### 16.2 Main Window

The Main Window owns:

- full Dashboard
- settings entry point
- runtime and sync diagnostics
- detailed sessions and exports

The Main Window SHOULD restore bounds and MUST be clamped to a visible display after monitor changes.

Closing follows the configured close behavior. The default remains hide to tray.

### 16.3 Widget Window

The Widget Window is one transparent or frameless BrowserWindow whose size and position change with its mode.

Target modes:

```ts
type WidgetMode =
  | "collapsed"
  | "expanded"
  | "pinned";
```

Transient interaction flags MUST be represented separately:

```ts
type WidgetInteraction = {
  dragging: boolean;
  pointerInside: boolean;
  keyboardFocusInside: boolean;
};
```

Data health MUST also be separate:

```ts
type WidgetDataStatus =
  | "loading"
  | "ready"
  | "syncing"
  | "stale"
  | "offline"
  | "error";
```

Definitions are evaluated in this order:

1. `offline`: the latest Widget snapshot or sync-status request failed because Core cannot be reached; retained snapshot data MAY still render
2. with no retained valid snapshot, `loading` while the initial request is pending and `error` after Core returns an invalid/error response
3. with retained data, `stale` when the latest view refresh failed, snapshot age exceeds the freshness deadline, or any enabled adapter is stale/error
4. otherwise `syncing` when any enabled adapter is queued/syncing
5. otherwise `ready`

`error` therefore never replaces renderable retained data; that case is `stale`. Do not combine presentation mode, pointer state, and data health into one large string union.

### 16.4 Widget State Transitions

Mode semantics:

- `collapsed` is the compact docked control
- `expanded` uses the full Widget geometry while hover/focus interaction remains active and automatically collapses after both pointer and keyboard focus leave
- `pinned` uses the same full geometry and content as expanded, remains open until explicitly unpinned, and is the only full mode selected as a restart preference; runtime mode changes persist `widgetModeOnStartup` only for explicit pin/unpin commands, not transient hover expansion

Required transitions:

| Current | Event | Next |
|---|---|---|
| collapsed | pointer enter | expanded after `OPEN_DELAY_MS` |
| collapsed | primary click without drag | pinned |
| collapsed | drag start | collapsed, dragging |
| expanded | pointer and focus leave | collapsed after `CLOSE_DELAY_MS` |
| expanded | pin | pinned |
| expanded | open main | `widgetModeAfterOpenMain`, Main shown; this automatic transition does not rewrite `widgetModeOnStartup` |
| pinned | unpin | expanded |
| pinned | pointer/focus leave | pinned |
| any | hide command | window hidden without changing mode |
| any | reset position | default visible position in current mode |

Centrally defined interaction constants MUST initially be:

```ts
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 300;
const DRAG_THRESHOLD_PX = 5;
const ACTIVATION_SUPPRESSION_MS = 250;
```

Pointer enter cancels the pending close timer; pointer/focus leave cancels the pending open timer. Pin, hide, pointer gesture beginning, display change, and window destruction cancel both timers. Timer callbacks MUST re-check current mode, focus, pointer, and drag state before changing geometry.

Main records `screen.getCursorScreenPoint()` when the renderer reports pointer-down, samples the native cursor during movement, and begins dragging only after Euclidean movement reaches `DRAG_THRESHOLD_PX`. Main owns the threshold, timers, activation eligibility, and `ACTIVATION_SUPPRESSION_MS`; renderer coordinates are never trusted as native screen coordinates. Pointer-up ends the gesture and returns whether click activation is eligible. A drag gesture MUST NOT pin or expand the Widget.

### 16.5 Widget Geometry

Recommended initial sizes:

- collapsed window: approximately `88 x 88`
- expanded window: approximately `384 x 248`

Final values MAY change after visual testing, but dimensions MUST be stable and centrally defined.

The Widget Window MUST:

- dock to left or right screen edge with at least the full `88 x 88` collapsed interactive area inside the display work area
- remain recoverable if displays change
- position expanded content inward from the dock edge
- avoid taskbar/dock overlap by using display work area
- preserve its dock edge and vertical anchor ratio rather than persisting mode-dependent expanded width/height
- use one layout module for all placement calculations
- stay above normal application windows using Electron's non-exclusive floating level while remaining below system/security UI
- avoid focus on hover expansion; direct keyboard/pointer activation MAY focus it, and opening Main MUST transfer focus to Main

Closing the Widget hides it unless the app is quitting; disabling it destroys it. Renderer reload/crash preserves controller mode, normalized anchor, and visibility and recreates/reloads at most the existing single BrowserWindow. `widgetBounds` stores the last normalized collapsed anchor rectangle. Entering expanded or pinned mode derives full bounds from that anchor and dock edge; it MUST NOT overwrite the anchor with expanded dimensions. The renderer MUST NOT independently guess native screen coordinates.

### 16.6 Widget Interaction Ownership

Electron main process owns:

- BrowserWindow lifecycle
- native bounds
- display selection
- docking
- always-on-top behavior
- tray commands
- settings persistence
- crash/reload recovery

Widget renderer owns:

- collapsed and expanded content
- visual animation within the native bounds supplied by main
- metric formatting
- button interactions
- visible health/status state

The Widget uses one data path in browser and Desktop modes: `WidgetPage` fetches `GET /api/widget-snapshot` and `GET /api/sync/status` through the shared Dashboard query client. The snapshot endpoint is a bounded Core projection containing only the Widget metrics and `generatedAt`; it MUST NOT load session timelines or full tool tables. Desktop main/preload MUST NOT query Core and relay snapshots over IPC, and renderer-to-renderer snapshots MUST NOT be used as a state bus.

Widget `refreshView()` refetches the snapshot and status. The optional “Sync sources” action invokes the manual sync endpoint with the same semantics as section 15.2. Browser mode renders the same data/status behavior and replaces native-only actions with unavailable/hidden controls when the bridge is absent.

The renderer requests native window operations through the preload bridge. It MUST NOT access Node or Electron APIs directly.

### 16.7 Widget Content

Collapsed presentation MUST:

- show product identity or recognizable mark
- show data health using a status indicator
- remain readable when partially hidden at the screen edge
- avoid small text that cannot be read at widget size
- provide an accessible name

Expanded presentation MUST include:

- product name
- data status and last updated time
- one primary metric, defaulting to total tokens
- three or four secondary metrics chosen from tool calls, edits, files, cache hit, and success rate
- pin/unpin action
- open Main Window action
- optional manual refresh action

Expanded presentation MUST NOT contain cards nested inside another card. Metric rows or divided sections are preferred.

Icon actions MUST have tooltips and accessible labels.

### 16.8 Legacy Settings Migration

Existing settings such as:

- `floatingWindowBounds`
- `reopenFloatingWindowOnStartup`
- `enableOrb`
- `showOrbOnStartup`
- `orbBounds`
- `orbDockEdge`

MUST be migrated to the new Widget settings without losing recoverable user preferences.

Target settings MUST include the following complete persisted type and defaults:

```ts
type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DesktopSettings = {
  settingsVersion: 2;
  closeBehavior: "hide-to-tray" | "quit-app";
  launchAtLogin: boolean;
  showMainWindowOnStartup: boolean;
  mainWindowBounds: WindowBounds | null;
  widgetEnabled: boolean;
  showWidgetOnStartup: boolean;
  widgetModeOnStartup: "collapsed" | "pinned";
  widgetModeAfterOpenMain: "collapsed" | "expanded";
  widgetBounds: WindowBounds | null;
  widgetDockEdge: "left" | "right";
};

const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  settingsVersion: 2,
  closeBehavior: "hide-to-tray",
  launchAtLogin: false,
  showMainWindowOnStartup: true,
  mainWindowBounds: null,
  widgetEnabled: true,
  showWidgetOnStartup: true,
  widgetModeOnStartup: "collapsed",
  widgetModeAfterOpenMain: "collapsed",
  widgetBounds: null,
  widgetDockEdge: "right"
};
```

Bounds are finite integers in Electron display-independent screen units with positive dimensions. Persistence uses temp-file, flush/close, and atomic rename in the settings directory. On startup, raw JSON MUST be parsed and migrated before the version `2` sanitizer discards unknown fields. A valid existing version `2` object wins over coexisting legacy fields and migration is a no-op; an interrupted temp file never replaces the last valid settings file.

Migration is field-by-field and deterministic:

| Target | Legacy source | Rule |
|---|---|---|
| `widgetEnabled` | `enableOrb`, then `preferredSurface` | valid `enableOrb`; otherwise true when preferred surface is `orb`/`floating-window`; otherwise default |
| `showWidgetOnStartup` | `showOrbOnStartup`, `reopenFloatingWindowOnStartup`, `preferredSurface` | true when valid orb/floating startup flag for the preferred legacy surface is true; false when both valid flags are false; force false if disabled |
| `widgetModeOnStartup` | `orbCollapsed`, `preferredSurface`, `reopenFloatingWindowOnStartup` | `collapsed` when preferred surface is `orb` and `orbCollapsed` is true; `pinned` for preferred `floating-window` with reopen true or preferred `orb` with `orbCollapsed` false; otherwise `collapsed` |
| `widgetBounds` | `orbBounds`, then `floatingWindowBounds` | source rectangle selects display and vertical-center ratio only; construct the centrally defined collapsed size at the selected dock edge, then clamp |
| `widgetDockEdge` | `orbDockEdge`, then nearest edge from selected legacy bounds | valid `left`/`right`; ties/default use `right` |
| `showMainWindowOnStartup` | existing field, then `preferredSurface` | valid explicit field wins; otherwise true only for preferred `main-window` |
| `mainWindowBounds` | existing field | keep valid bounds and clamp; otherwise null |
| `widgetModeAfterOpenMain` | none | `collapsed` |
| close/login settings | same-name fields | preserve valid values, otherwise defaults |

If legacy fields conflict, the row order and within-row source order above are authoritative. Invalid values are ignored per field and MUST NOT reset unrelated settings. The migration and `settingsVersion: 2` write are atomic/idempotent. Legacy fields remain readable for rollback compatibility but version `2` writers stop updating them.

Window lifecycle rules:

- `widgetEnabled = false`: do not create a Widget BrowserWindow; changing to true creates it lazily
- enabled plus `showWidgetOnStartup = false`: create lazily on the first tray/show command
- enabled plus `showWidgetOnStartup = true`: create after Desktop readiness and show in `widgetModeOnStartup`
- hide closes visibility only; disabling destroys the Widget window
- a renderer crash recreates the same single Widget window from persisted settings and controller state

Settings migration and lifecycle MUST be covered by table-driven tests.

### 16.9 Legacy Capability Parity

Old product windows MUST remain until every required capability has the following verified destination:

| Legacy capability | Target owner and behavior | Verification |
|---|---|---|
| orb compact indicator | Widget `collapsed` | renderer and screenshot test |
| orb hover expansion | `collapsed` to `expanded` transition | fake-timer state test |
| orb click/pin behavior | `collapsed` to `pinned` | state and Electron integration test |
| peek-card summary metrics | Widget expanded/pinned content | contract fixture and screenshot |
| floating dashboard persistence | pinned mode plus normalized anchor bounds | restart integration test |
| drag, dock, and edge recovery | main-process Widget controller/layout | multi-display layout tests |
| open full Dashboard | `showMainWindow()` action | IPC integration test |
| tray show/hide/reset commands | Window manager commands for the single Widget | Electron integration test |
| startup visibility and position | version `2` settings migration/lifecycle | table-driven migration test |
| always-on-top behavior | Widget controller applies the same documented z-order policy in all modes | Windows and macOS smoke test |

A legacy window MUST NOT be deleted merely because its visual content exists in the Widget. Its settings, tray commands, startup behavior, positioning, accessibility name, and failure recovery MUST also have a verified target. Optional legacy decoration or animation that carries no interaction, state, or accessibility behavior does not block retirement.

## 17. Desktop IPC Contract

IPC channel constants and Zod payload schemas live in `@agent-metrics/contracts`.

```ts
type DesktopPlatformInfo =
  | { platform: "win32"; supportsLaunchAtLogin: true; supportsWidget: true }
  | { platform: "darwin"; supportsLaunchAtLogin: true; supportsWidget: true };

type ChildName = "watcher" | "parser" | "core";
type ChildRuntimeStatus = {
  name: ChildName;
  ownership: "managed" | "external" | "none";
  state: "starting" | "ready" | "degraded" | "stopped";
  pid: number | null;
  restartCount: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  errorSummary: string | null;
};
type RuntimeStatus = {
  state: "starting" | "ready" | "degraded" | "stopped";
  coreEndpoint: string | null;
  children: ChildRuntimeStatus[];
  lastUpdatedAt: string;
};

type DesktopSettingsView = DesktopSettings & DesktopPlatformInfo;
type DesktopSettingsPatch = Partial<Pick<DesktopSettings,
  | "closeBehavior"
  | "launchAtLogin"
  | "showMainWindowOnStartup"
  | "widgetEnabled"
  | "showWidgetOnStartup"
  | "widgetModeOnStartup"
  | "widgetModeAfterOpenMain"
>>;
type WidgetPointerResult = { activationEligible: boolean; dragging: boolean };
type WidgetCommandResult = { visible: boolean; mode: WidgetMode };
```

Window bounds and dock position are updated only by main-owned window commands, not arbitrary renderer settings patches.

Literal channels and schemas:

| Channel | Sender | Request | Response |
|---|---|---|---|
| `desktop:get-platform-info` | Main, Widget | none | `DesktopPlatformInfo` |
| `desktop:get-runtime-status` | Main | none | `RuntimeStatus` |
| `desktop:get-settings` | Main | none | `DesktopSettingsView` |
| `desktop:update-settings` | Main | `DesktopSettingsPatch` | `DesktopSettingsView` |
| `desktop:restart-runtime` | Main | `{ child: ChildName }` | `RuntimeStatus` |
| `desktop:show-main-window` | Main, Widget | none | `{ visible: true }` |
| `desktop:hide-widget` | Widget | none | `WidgetCommandResult` |
| `desktop:set-widget-mode` | Widget | `{ mode: WidgetMode }` | `WidgetCommandResult` |
| `desktop:widget-pointer-enter` | Widget | none | `WidgetCommandResult` |
| `desktop:widget-pointer-leave` | Widget | none | `WidgetCommandResult` |
| `desktop:widget-focus-within` | Widget | `{ focused: boolean }` | `WidgetCommandResult` |
| `desktop:widget-pointer-begin` | Widget | none | `WidgetPointerResult` |
| `desktop:widget-pointer-update` | Widget | none | `WidgetPointerResult` |
| `desktop:widget-pointer-end` | Widget | none | `WidgetPointerResult` |
| `desktop:show-widget-menu` | Widget | none | `{ shown: boolean }` |

Main samples native cursor coordinates for all pointer gesture channels. `pointer-begin` records the origin but does not begin drag; `pointer-update` crosses the threshold and moves the window; `pointer-end` ends the gesture. Main owns timers and mode changes. No screen coordinates cross IPC.

Preload exposes one typed method per table row and no generic `invoke`. Every handler verifies the sender is the current main frame of the named owning BrowserWindow; subframes and stale/replaced renderers are rejected. The exact trusted renderer origin is the Dashboard URL configured when that BrowserWindow loads: in development it must equal the configured Vite origin, and in packaged operation it must equal the staged local origin. Origin pattern/wildcard matching is prohibited.

Security baseline for every renderer window:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: <allowlisted preload path>
}
```

Any platform limitation requiring `sandbox: false` needs an approved ADR and compensating controls. Navigation, unexpected window creation, permissions, and shell opening are denied by default; revision `2` has an empty external-link allowlist. Main parses requests and responses, preload parses responses again before returning them, and renderer code consumes inferred types. Widget telemetry never travels over IPC. Browser mode works without the bridge and hides native-only commands.

## 18. Desktop Runtime Supervision

The process supervisor MUST retain child ownership and clean shutdown behavior. It MUST stop only children it started. Reusing a healthy external Core runtime remains allowed, but ownership MUST be `external` in `RuntimeStatus` and Desktop MUST never signal that process during shutdown.

Managed child policy is fixed for this refactor:

```ts
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const FAILURE_WINDOW_MS = 10 * 60_000;
const STABLE_RUN_RESET_MS = 5 * 60_000;
const READINESS_TIMEOUT_MS = 15_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const MAX_CHILD_LOG_BYTES = 5 * 1024 * 1024;
const CHILD_LOG_GENERATIONS = 3;
```

The initial launch is not a restart. Permit at most five automatic restart launches in the rolling failure window; after the fifth restarted process exits unexpectedly, latch that child as `degraded` and stop automatic recovery. Delay index is `min(consecutiveFailures - 1, 4)`. A child running continuously for five minutes resets consecutive failures and the rolling window. Explicit Main-only `desktop:restart-runtime` clears the latch/window for that child and starts it once. Intentional/configuration stop does not count. Only one restart timer exists per child; shutdown cancels it before signaling owned processes.

A managed child is `ready` only after its readiness check succeeds within 15 seconds. Core readiness is the versioned `/api/health` contract. Watcher/parser readiness uses an owned-process started signal or documented heartbeat, not PID existence alone. Timeout is an unexpected failure. External Core reuse requires `GET /api/health` to return `apiVersion: 2` and `eventSchemaVersion: 2`; an occupied port or unversioned response is incompatible and MUST NOT be reused. External ownership appears as a Core child entry with `ownership: "external"`, and Desktop never signals it.

Shutdown sends the platform's graceful termination request to owned children, waits five seconds, then force-terminates the owned process tree (`taskkill /T /F` equivalent on Windows, process-group `SIGKILL` on macOS) and records the escalation. Desktop MUST NOT mark shutdown complete before owned process trees exit or escalation is recorded.

Stdout and stderr are tagged and written under the Desktop log directory as `<child>.log`, rotated before an append would exceed 5 MiB to `<child>.log.1` through `.3`; oldest is deleted. Rotation failure retains stderr diagnostics where possible and marks runtime degraded rather than discarding all further output. Renderer-visible errors include only sanitized summaries/relative log names; source records, environment values, and prompt content are excluded. Broken-pipe guards prevent Desktop crashes but do not replace child logging.

Fake-clock and process-fixture tests MUST prove exact delays, fifth-restart boundary, stable reset, explicit restart, readiness timeout, external version rejection, single timer, graceful/forced shutdown, and ownership protection.

## 19. Packaging

Packaged runtime content MUST contain only runtime requirements.

Workspace packages deployed into the Desktop runtime SHOULD declare package file allowlists such as:

```json
{
  "files": ["dist/**/*", "package.json"]
}
```

The final package MUST NOT include:

- test source files
- design documents
- repository-local telemetry
- temporary files
- source maps unless deliberately enabled
- developer IDE settings

Packaging verification MUST include:

- file-content assertion
- native `better-sqlite3` load test under the bundled Node runtime
- Core startup smoke test
- Dashboard load smoke test
- Main and Widget window creation smoke test

Packaging scripts MUST pass explicit target platform and architecture into runtime staging, for example `prepare-runtime --target-platform=win32 --target-arch=arm64`. Staging MUST obtain/rebuild Node and `better-sqlite3` for that exact target and fail on host/target mismatch it cannot satisfy. Alternatively, CI may constrain every package job to a matching native host/architecture, but host `process.platform/process.arch` MUST NOT silently override the requested artifact target. Artifact verification inspects executable/native-module architecture before smoke execution.

Windows x64/ARM64 and macOS x64/ARM64 targets remain required unless separately descoped by an approved ADR. Current orb/peek implementation is Windows-only; Phase 7 therefore includes implementing equivalent macOS Widget window, dock, focus, always-on-top, drag, tray, and display-recovery behavior. macOS cannot be marked supported solely because electron-builder creates an artifact.

Platform verification responsibility:

| Capability | Shared deterministic tests | Windows evidence | macOS evidence |
|---|---|---|---|
| Widget state and timer rules | required on every CI OS | packaged smoke | packaged smoke |
| bounds, dock edge, display recovery | pure layout fixtures for DPI/work-area inputs | native multi-display smoke | native multi-display smoke |
| drag and activation suppression | controller tests | native pointer smoke | native pointer smoke |
| always-on-top and focus behavior | controller assertions | native window smoke | native window smoke |
| tray/menu and close behavior | command tests | packaged smoke | packaged smoke |
| launch at login | settings/IPC tests | native integration check | native integration check |
| `better-sqlite3` runtime load | package test | native x64 and ARM64 execution | native x64 and ARM64 execution |
| package contents/Core/Dashboard/Main/Widget startup | manifest assertions | native x64 and ARM64 execution | native x64 and ARM64 execution |

For each of Windows x64, Windows ARM64, macOS x64, and macOS ARM64, CI or an authorized native machine MUST execute packaged `better-sqlite3` load, Core health, Dashboard load, and Main/Widget creation smoke tests. Window-behavior smoke MAY run once per OS only when pure DPI/layout tests cover both architectures. An agent on one OS may report unavailable checks as skipped, but phase/full completion waits for every required native result. Cross-compiling or inspecting an artifact alone is not execution evidence.

## 20. Testing and Quality Gates

### 20.1 Test Isolation

Tests MUST NOT read real local telemetry sources.

A shared test-environment helper MUST set all source paths, including:

- Claude discovery roots
- OpenCode database and models
- ZCode database and models
- Codex sessions, logs database, and config
- Cursor tracking database
- Cursor workspace storage
- Cursor storage JSON
- Cursor global storage database
- Cursor projects root

Tests requiring a real source MUST create a fixture and explicitly override only that source.

### 20.2 Required Automated Coverage

Event/domain tests:

- tool events require `tool_call_id`
- adapters preserve correlation
- token semantics and totals for every vendor
- aggregate invariants across dimensions

Migration tests:

- old database migrates without data loss
- interrupted migration cannot apply data changes twice
- old Desktop settings migrate to Widget settings

Core tests:

- GET requests do not invoke source adapters
- coordinator coalesces same-adapter runs
- one adapter failure does not block another
- incremental event reader does not reread the complete log
- malformed line handling
- pagination and time/source filters
- sync status API

Dashboard tests:

- query deduplication
- cancellation on filter change
- view refresh versus source sync semantics
- stale-data retention
- hidden-document polling behavior
- full Dashboard information hierarchy
- Widget loading/ready/syncing/stale/offline/error states

Desktop tests:

- Widget state transitions
- layout for left/right dock and multiple displays
- drag click suppression
- pinned mode ignores pointer leave
- IPC validation
- supervisor backoff and restart cap
- clean shutdown

### 20.3 Required Commands

Before a phase is declared complete, relevant commands MUST pass. The repository currently names recursive TypeScript checking `lint` and has no ESLint/style-linter gate. Phase 0 MUST add this exact root script and retain `lint` as a compatibility alias to it:

```json
{
  "scripts": {
    "typecheck": "corepack pnpm -r exec tsc --noEmit",
    "lint": "corepack pnpm typecheck"
  }
}
```

Do not run both aliases as if they were independent evidence. Full refactor gates are:

```text
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm --filter @agent-metrics/desktop test
```

If a true source linter is adopted in a later approved tooling decision, its command becomes an additional gate rather than replacing typecheck.

Phase 8 MUST add and document these Desktop scripts:

```text
prepare-runtime --target-platform=<win32|darwin> --target-arch=<x64|arm64>
verify:package --artifact=<path> --target-platform=<...> --target-arch=<...>
smoke:package --artifact=<path> --target-platform=<...> --target-arch=<...>
```

`verify:package` performs manifest/file and binary-architecture assertions. `smoke:package` performs the target-native runtime/UI checks from section 19. Existing `package:*` aliases MUST pass explicit targets to `prepare-runtime`, then invoke both checks where native execution is available. Exact implementation flags may follow the repository CLI parser convention, but these script names and responsibilities are contractually fixed and belong in release documentation, not a later edit made only to record incidental commands.

A test that passes only because its timeout was increased is not sufficient evidence. Required platform checks that cannot run locally are reported as skipped and remain open per section 19.

## 21. Performance Requirements

The performance fixture MUST contain at least 100,000 additive usage events, 50,000 logical tool calls, 10,000 sessions, five source instances, and a 250 MiB canonical JSONL. With a warm SQLite page cache, no source synchronization running, and 20 warm-up requests discarded, record 100 sequential requests per standard aggregate endpoint on a documented local/CI machine.

Acceptance targets:

- aggregate endpoint p95 below 200 ms on the fixture; when a machine cannot meet an absolute target, the refactor MUST be no slower than baseline by more than 10% and the machine/baseline numbers are reported
- committed aggregate GET remains below 500 ms while one adapter fixture is blocked in discovery
- steady-state append projection reads at most appended bytes plus one configured read buffer and never invokes whole-file `readFile`
- no overlapping network request for one normalized Dashboard query key
- Widget snapshot query plan touches no session timeline or full tool-event result set
- Main Window paints shell/loading state before aggregate requests resolve

Performance assertions MUST specify fixture seed, machine OS/architecture/CPU class, warm-up, sample count, and query plan. Increasing request timeouts is not performance evidence.

## 22. Observability and User-Visible Failure States

Core logs MUST identify:

- adapter instance ID, source instance ID, adapter enum, and source vendor
- sync run ID and duration
- discovered records, committed unique events, projected unique events, and projection watermark
- bounded failure summary and diagnostic code
- migration version/name on failure

Sensitive prompt contents, source database contents, and full filesystem records MUST NOT be logged by default.

Dashboard and Widget use the single derivation algorithm in section 16.3. Dashboard Top Bar derives health from Overview plus sync status; each secondary panel retains and displays its own query state and does not force the aggregate Top Bar offline/error when Overview remains valid. Zero metrics MUST NOT substitute for unavailable data.

## 23. Compatibility Requirements

The following behavior MUST remain available throughout migration:

- browser Dashboard development
- local HTTP API on loopback
- existing CLI hook collection
- existing SQLite data where migration succeeds
- exports, unless an endpoint is explicitly versioned
- tray/menu bar access
- configurable close behavior
- launch-at-login setting

API changes SHOULD be additive first. A “normal release” for compatibility means one identified project version that remained the current supported version for at least 14 consecutive days.

Legacy event-log compatibility may be removed only when all are true:

1. every in-repository adapter has emitted only schema version `2` throughout one normal release
2. the migration has persisted scan results per configured file identity and terminal offset, accounting for every row as normalized, pending, ambiguous, invalid, or legacy-uncorrelated
3. a startup compatibility report for that release shows zero pending parseable usage rows and no unresolved identity conflict affecting aggregates
4. release documentation ends rollback support to the preceding version
5. a newer specification revision/ADR names this section, approves removal, and records a tested database backup/restore path

Removal evidence covers only logs configured and scanned through their recorded terminal offsets. A legacy log configured after compatibility removal is rejected with `UNSUPPORTED_LEGACY_SCHEMA` and a migration/import instruction; it is never silently parsed as version `2`.

Until removal, compatibility parsing is read-only normalization: it MUST NOT rewrite/delete historical JSONL. Ambiguous/unrecoverable tool rows remain separately queryable under deterministic `legacy:` identities and diagnostics. Newly emitted events use version `2` after Phase 2.

Legacy API fields require a named inventory of every in-repository and documented external consumer, one normal release with all inventoried consumers on replacement fields, and explicit ADR/spec approval. Legacy Desktop settings require table-driven migration evidence from every legacy field, one normal release of version `2` writes, the rollback declaration, and explicit approval. Event logs, API fields, and settings have independent exit decisions; satisfying one does not authorize another. Elapsed time alone is insufficient.

## 24. Implementation Phases

Agents MUST implement phases in dependency order unless a phase explicitly states otherwise.

### Phase 0: Establish a Green, Isolated Baseline

Scope:

- repair Dashboard typecheck fixture drift
- introduce the source-isolation test helper
- make Core tests independent from the developer machine
- add the correct OpenCode aggregate regression fixture
- add the root `typecheck` script and retain `lint` as its alias
- record current package smoke behavior without publishing artifacts

Exit criteria:

- `corepack pnpm typecheck` passes
- existing suites pass in an isolated environment
- a guard test fails if any source resolves outside its fixture root; no test reads real user telemetry
- the OpenCode fixture asserts canonical expected totals; it may be skipped with a Phase 2 reference so Phase 0 stays green, but MUST become active in Phase 2

### Phase 1: Establish Shared Contract Foundations

Scope:

- finalize `NormalizedEventV2`, shared source/adapter/usage enums, and identifier schemas in `@agent-metrics/event-schema` without switching producers yet
- create `@agent-metrics/contracts`
- define common/error/filter/pagination/health/sync schemas from sections 12-14
- define Desktop platform/settings/runtime/IPC schemas from sections 16-18
- add event/contract fixture tests without migrating consumers

Exit criteria:

- every section 9 event schema and every schema named in sections 12-14 and 17 exists as strict Zod with inferred types
- contracts imports/re-exports event identifiers rather than duplicating enums or event literals
- fixture tests pin valid payloads, invalid payloads, defaults, and error codes
- neither package imports an app framework or introduces a circular workspace dependency
- no production producer/consumer migration is required to complete this foundation phase

### Phase 2: Normalize Domain Semantics and Migrations

Scope:

- migrate every existing adapter/normalizer to the Phase 1 schema version `2`, including `source_instance_id`, `adapter_instance_id`, `tool_call_id`, usage semantics/measurement, and provider fields
- centralize token accounting
- implement event observations, fingerprints, aliases, diagnostics, and legacy compatibility parsing
- introduce the migration runner, baseline adoption, historical replay/backfill, and canonical projections

Exit criteria:

- every version `2` event fixture parses; invalid enum/count/time/provider/server-tool fixtures fail
- identity string, semantic-conflict, observation provenance, lifecycle, and Claude alias/revocation fixtures pass
- all registered usage-source fixtures satisfy canonical totals and snapshot exclusions
- fresh, every recognized historical shape, marked/unmarked Codex, interrupted, repeat-run, and invalid-data migrations pass reconciliation atomically
- the Phase 0 OpenCode regression is active and green

### Phase 3: Ingestion Foundation and Core Decomposition

Scope:

- Core-independent raw spool and canonical-writer lease
- byte-range event-log reader, prepared projector, and projection watermark
- repositories, query services, and thin routes
- real-column indexes and bounded session/timeline endpoints
- move all migration construction out of `app.ts`

Exit criteria:

- `app.ts` no longer defines migration SQL, event-log byte handling, aggregate SQL, or route handlers; each has one owner from section 8
- no replacement production module exceeds 600 non-generated lines without documented reviewer approval
- offline raw capture, lease contention, spool replay, append, partial/malformed line, truncation, replacement, and interrupted-transaction tests pass
- query-plan tests assert intended named indexes and projection tests expose committed byte watermarks

### Phase 4: Introduce Sync Coordinator

Scope:

- common adapter-instance wrapper and registry
- FIFO/concurrency/coalescing state machine and run persistence
- startup, periodic, and manual synchronization
- run/status endpoints using Phase 1 contracts and Phase 3 projection watermarks
- remove adapter synchronization and projection from GET request hooks
- finish separating adapter scheduling from Core bootstrap

Exit criteria:

- GET route tests prove adapters, projector, cursor repository, and sync-state writers are not invoked
- a blocked adapter fixture leaves committed aggregate GET requests within the section 21 target
- one adapter failure does not prevent another instance from completing
- queued/active coalescing, run lookup/retention, durable-watermark visibility, freshness, error, partial commit, and shutdown-abort tests pass

### Phase 5: Migrate HTTP/IPC Consumers and Dashboard Query Layer

Scope:

- migrate all Core routes/responses and local HTTP security to shared contracts
- add `/api/health`, composite session routes, sync-run route, and `/api/widget-snapshot`
- migrate Dashboard API parsing/types and shared Main-window Desktop IPC (`platform`, runtime, settings, restart, show Main)
- keep legacy floating/orb/peek IPC contracts isolated in a compatibility module until Phase 7; do not expose them through new surfaces
- add query client/hooks and remove duplicated polling effects from `App.tsx`

Exit criteria:

- every endpoint-table and IPC-table success/error fixture parses at producer and consumer boundaries
- repository search/typecheck shows one exported definition for shared vendors/adapters, API payloads, settings views, and IPC payloads
- concurrent-render, normalized request-key, cancellation, view-refresh/source-sync, run-completion, and stale-retention tests pass
- browser Dashboard works with trusted-origin enforcement and with no Desktop bridge

### Phase 6: Full Dashboard Redesign

Scope:

- AppShell and compact top bar
- Overview strip and operational workspace
- visual tokens, accessibility, responsive behavior, and explicit aggregate/per-panel status

Exit criteria:

- snapshots at `1280 x 720`, `1440 x 900`, `1920 x 1080`, `390 x 844`, and `768 x 1024` show Top Bar and Overview Strip in the first viewport without a promotional Hero
- loading, empty, syncing, ready, stale, offline, and error fixtures have visual and accessible output
- DOM/style assertions find no nested component cards or prohibited radial/glow/bokeh declarations
- automated accessibility checks with repository-pinned `axe-core`/Playwright versions report no critical or serious violations; keyboard traversal follows visual order
- screenshot comparison uses the pinned Playwright/browser version, disables nonessential animation, and permits at most a 0.2% differing-pixel ratio with no ignored region covering controls/text
- screenshot/overflow assertions show no clipping, horizontal page overflow, or overlapping controls

### Phase 7: Main Plus Widget Desktop Migration

Scope:

- Widget renderer, controller, state, layout, and single BrowserWindow
- Windows and macOS native Widget behavior
- settings migration, remaining Widget IPC table, and Main/Widget sender enforcement
- move orb, peek, and floating capabilities into Widget, then remove the isolated legacy IPC/windows after parity

Exit criteria:

- runtime enumeration contains at most one Main and one Widget; disabled means no Widget instance
- every transition, focus, timer, native pointer threshold, suppression, crash/reload, and close rule passes
- left/right dock, work area, monitor removal, DPI change, and off-screen recovery pass
- every legacy parity/settings row has an automated or named native-platform assertion
- Windows and macOS Widget creation/interaction smoke tests pass; browser mode remains bridge-free

### Phase 8: Runtime Supervision and Packaging Cleanup

Scope:

- versioned readiness, backoff/restart cap, explicit restart, owned process-tree shutdown
- child logs and exit diagnostics
- target-explicit runtime staging, package allowlists, binary verification, and native smoke scripts

Exit criteria:

- supervisor fixture tests satisfy every quantitative rule in section 18
- runtime package excludes source tests, design docs, temporary files, and local telemetry
- `prepare-runtime`, `verify:package`, and `smoke:package` responsibilities are implemented and documented
- every supported OS/architecture has the native execution evidence required by section 19

## 25. Parallel Work Rules

After Phase 0, agents MAY develop these on isolated branches/worktrees but MUST NOT merge them before their owning phase dependencies pass:

- visual tokens/static Dashboard prototypes owned by Phase 6
- migration-runner experiments owned by Phase 2
- Widget pure state/layout tests owned by Phase 7

Phase 1 contract work is the only architecture work allowed to merge before Phase 2. The following order constraints are absolute:

- no version `2` producer merges before its event schema and compatibility parser
- no sync endpoint merges before Phase 1 sync contracts
- no GET synchronization removal before Phase 4 coordinator/durable-watermark behavior is operational
- no API response change before its contract and in-repository consumers migrate atomically or additively
- no legacy event/settings removal before section 23 exit approval
- no old Desktop-window deletion before Phase 7 parity/settings/native-platform evidence
- no package cleanup before Phase 8 verification knows required runtime content

## 26. Agent Execution Rules

Every implementation agent MUST follow these rules:

1. Read this specification and the files directly affected by the assigned phase.
2. Check `git status` before editing and preserve unrelated user changes.
3. State the phase and acceptance criteria being implemented.
4. Keep changes within the phase boundary unless a prerequisite is unavoidable.
5. Add or update tests with behavioral changes.
6. Do not perform unrelated style cleanup.
7. Do not copy business rules into another layer to make a test pass.
8. Prefer compatibility adapters and migrations over destructive resets.
9. Run the narrowest relevant tests during implementation, then the phase quality gates.
10. Report failed or skipped verification exactly.
11. Do not commit, push, publish, delete telemetry, or regenerate release artifacts unless explicitly authorized.
12. Update this specification only when the architecture decision changes, not to document every implementation detail.

When an agent finds a conflict between code and this specification:

- if code is current-state debt explicitly addressed here, implement toward this specification
- code or comments dated after this document do not override it by recency alone
- only a higher numbered revision of this specification or an approved ADR that names the superseded section may change an architectural requirement
- if such a newer decision exists, cite it and follow it; otherwise stop and document a material conflict before changing architecture
- if the conflict is only naming or file placement, preserve local conventions while maintaining the specified boundary

## 27. Review Checklist

Reviewers MUST reject a phase when any applicable item is false.

### Domain

- [ ] Session identity uses composite `SessionKey` everywhere.
- [ ] Event identity, observation provenance, and logical tool identity are separate.
- [ ] Tool lifecycle uses `tool_call_id` rather than event-ID suffix parsing for version `2`.
- [ ] Token semantics/measurement are explicit per registered usage source.
- [ ] Context snapshots are excluded from additive totals.
- [ ] Token totals agree across model/source/provider/session dimensions.
- [ ] Legacy data remains supported or durably diagnosed.

### Core

- [ ] Raw hook capture remains available while Core is offline.
- [ ] Canonical JSONL has one leased writer and incremental projection does not read full history.
- [ ] GET requests have no sync/projection side effects.
- [ ] Adapter-instance failures and sync runs are observable/isolated.
- [ ] Migrations, marker adoption, diagnostics, and reconciliation are transactional.
- [ ] Routes use defined contracts; sessions/timelines are bounded and composite-keyed.

### Contracts

- [ ] Event, API, and IPC boundaries use one set of strict runtime schemas.
- [ ] Endpoint and literal IPC tables match producers/consumers.
- [ ] External payloads are not accepted through unchecked casts.
- [ ] Loopback HTTP and IPC sender/origin checks meet sections 13 and 17.

### Dashboard

- [ ] Polling is deduplicated and cancellable.
- [ ] Stale/offline states preserve last successful data.
- [ ] Layout is operational, dense, and scannable.
- [ ] No nested cards, decorative glow blobs, or clipped text.

### Desktop

- [ ] At most one Main and one enabled Widget product window exist.
- [ ] Widget mode, pointer/focus interaction, and data status are separate.
- [ ] Main owns timers, native cursor sampling, drag threshold, bounds, and focus/z-order policy.
- [ ] Pinned state ignores pointer leave and dragging cannot activate click.
- [ ] Raw legacy settings migrate before sanitization.
- [ ] Windows and macOS Widget parity evidence exists.

### Runtime and Packaging

- [ ] Restart behavior is bounded and observable.
- [ ] Package contains runtime files only.
- [ ] Native runtime and UI smoke tests pass.

### Verification

- [ ] Typecheck passes.
- [ ] Relevant tests pass in an isolated environment.
- [ ] Build passes.
- [ ] Failures and skipped platform checks are reported.

## 28. Final Acceptance Criteria

The full refactor is complete only when all of the following are true:

1. The same additive usage dataset produces consistent token totals everywhere; context snapshots are excluded.
2. Sessions and tool calls use source-instance composite identities, with legacy ambiguity diagnosed.
3. Raw hooks collect while Core is absent and replay safely through the leased canonical writer.
4. Dashboard reads stay responsive while adapter instances synchronize.
5. Synchronization/run/projection watermarks are visible through status APIs and absent from GET side effects.
6. Core responsibilities are divided into migration, ingest, sync, query, and route modules.
7. Core, Dashboard, and Desktop use shared strict event/API/IPC contracts.
8. Dashboard no longer maintains seven independent polling effects in one component.
9. Desktop creates at most one Main and one enabled Widget and has no legacy product windows/channels.
10. Widget collapsed, expanded, pinned, docked, loading, syncing, stale, offline, and error behavior is tested on Windows/macOS.
11. Legacy telemetry/settings migrate without deletion and satisfy reconciliation/compatibility rules.
12. Typecheck, tests, build, performance fixture, and every required native package smoke pass.
13. Packaged runtime excludes test sources, temporary files, design docs, and local telemetry.

## 29. Deferred Decisions

The following decisions are deliberately deferred and MUST NOT block the refactor:

- replacing JSONL with a different durable event transport
- introducing pre-aggregated daily tables
- adding cost estimation by model/provider
- auto-update and signed distribution
- Linux Desktop support
- cloud synchronization
- user-defined Widget metric layouts

They may be proposed in separate specifications after this refactor establishes stable contracts and boundaries.
