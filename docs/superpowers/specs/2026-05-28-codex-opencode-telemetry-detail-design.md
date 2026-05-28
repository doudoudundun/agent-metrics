# Codex and OpenCode Telemetry Detail Design

## Goal

Extend the current multi-source telemetry foundation with two practical upgrades:

- enrich `OpenCode` usage events with provider endpoint metadata
- upgrade `Codex` from token-only visibility to credible `Turns`, `Tool Calls`, and `Edit Operations`

This slice is intentionally focused on raising dashboard usefulness without weakening data trust.

## Why This Slice Exists

The current dashboard already distinguishes `Claude Code`, `OpenCode`, and `Codex`, but two gaps remain:

1. `OpenCode` rows usually show `providerId = opencode` with no `providerHost`
2. `Codex` currently shows token totals and provider metadata, but `Turns`, `Tool Calls`, and `Edit Operations` remain underreported or empty

The user requirement for this slice is explicit:

- `Turns`
- `Tool Calls`
- `Edit Operations`

should all become meaningfully populated for `Codex`, while `OpenCode` should expose provider host data where the local source already makes that possible.

## Design Principles

- Preserve trust over completeness. If a source does not expose a dimension stably, do not guess.
- Prefer structured local artifacts over assistant text reconstruction.
- Keep using the shared normalized event model rather than introducing source-specific query paths.
- Improve `Codex` observability in stages:
  - first, credible aggregate visibility
  - later, richer per-step detail where raw data is stable enough

## Current Source Reality

### OpenCode

Confirmed local sources on this machine:

- `~/.local/share/opencode/opencode.db`
- `~/.cache/opencode/models.json`

Confirmed behavior:

- assistant messages in `opencode.db` contain `providerID` and `modelID`
- `models.json` is a provider registry object keyed by provider id
- example:
  - `providerID = "opencode"`
  - `models.json.opencode.api = "https://opencode.ai/zen/v1"`

This means provider host enrichment is available locally and does not need inference from remote APIs.

### Codex

Confirmed local sources on this machine:

- `~/.codex/sessions/**/rollout-*.jsonl`
- `~/.codex/logs_2.sqlite`
- `~/.codex/config.toml`

Confirmed rollout reality:

- old rollout files contain:
  - `custom_tool_call`
  - `custom_tool_call_output`
- newer rollout files contain:
  - `agent_message`
  - `user_message`
  - `token_count`
  - `patch_apply_end`
  - `web_search_end`

Important constraint:

- recent rollout files do not consistently expose a complete structured event stream for every `shell/read/write` action
- therefore, a claim of `100%` reconstruction for every Codex step would be misleading in the current source environment

## Scope

This design covers:

- `OpenCode` provider host enrichment
- `Codex` turn counting from stable rollout events
- `Codex` tool-call counting from stable rollout events
- `Codex` edit-operation counting from stable rollout events
- timeline visibility for these new Codex events
- tests and acceptance criteria for these rules

This design does not cover:

- tool-level token attribution for `Codex`
- cost estimation
- company-wide deployment
- perfect recovery of every `shell/read/write` action when the rollout format does not expose one

## Functional Design

### 1. OpenCode Provider Enrichment

#### Source Strategy

Add a lightweight local provider registry loader in `adapters-opencode`.

Inputs:

- assistant message `providerID`
- local `models.json`

Mapping:

- `providerID` -> registry entry by top-level key
- registry `api` -> `provider_base_url`
- parsed URL host -> `provider_host`

#### Normalization Rule

For `assistant.responded` and `token.usage.recorded` events emitted from `OpenCode`:

- preserve existing `provider_id`
- add:
  - `provider_base_url`
  - `provider_host`

If the registry file is absent, invalid, or the provider key is missing:

- leave `provider_base_url` and `provider_host` as `null`
- do not synthesize values from model names

#### Expected Outcome

`OpenCode` dashboard rows and provider breakdowns should no longer be limited to `providerId = opencode` with no host when the local registry is present.

### 2. Codex Turn Counting

#### Goal

Populate the dashboard `Turns` KPI for `Codex` with a stable source-backed definition.

#### Rule

Treat stable conversational rollout events as turn evidence:

- `user_message` -> prompt-side turn signal
- `agent_message` -> assistant-side turn signal

Normalization:

- `user_message` maps to `prompt.submitted`
- `agent_message` maps to `assistant.responded`

Constraints:

- use rollout timestamps directly
- do not derive turns from free-form transcript text outside the rollout stream
- keep response char counts simple and source-backed:
  - use message text length where available
  - otherwise allow `0` rather than guessing hidden content

#### Why This Is Acceptable

The dashboard already treats turns as aggregate prompt/response activity. These two event types are a stable enough source to move `Codex` from `0` to meaningful turn counts without pretending to recover unavailable internal detail.

### 3. Codex Tool Calls

#### Goal

Populate `Tool Calls` for `Codex` from stable structured rollout events only.

#### Supported Sources

##### Legacy rollout format

- `custom_tool_call`
- `custom_tool_call_output`

Rules:

- `custom_tool_call` emits `tool.called`
- completion status emits:
  - `tool.succeeded`
  - or `tool.failed`

Use `call_id` as the stable correlation key.

##### Newer rollout format

- `patch_apply_end`
- `web_search_end`

Rules:

- `patch_apply_end` emits a completed tool event with `tool_name = apply_patch`
- `web_search_end` emits a completed tool event with `tool_name = WebSearch`

`argument_summary` policy:

- for `custom_tool_call`, use structured input when available
- for `web_search_end`, summarize:
  - query
  - action type
- for `patch_apply_end`, a summary is optional because the edit event carries richer detail

#### Important Non-Goal

Do not try to reverse-engineer every possible `shell/read/write` action from assistant prose or unrelated records. Only structured rollout events count.

### 4. Codex Edit Operations

#### Goal

Populate `Edit Operations` for `Codex` from patch application artifacts that already describe file changes.

#### Primary Source

- `patch_apply_end.payload.changes`

#### Mapping

When `patch_apply_end.success = true`:

- emit one `code.edit.applied` event
- `tool_name = apply_patch`
- `files_changed` = keys of `changes`
- `file_count` = number of keys
- `edit_operation_count = 1`

#### Insertions and Deletions

Priority order:

1. if `unified_diff` exists, compute line additions and removals from diff hunks
2. if the change type is `add` and only full `content` exists, estimate insertions from added content lines
3. otherwise use `0`

This rule explicitly prioritizes file precision over line-count precision.

When `patch_apply_end.success = false`:

- emit failed tool completion
- do not emit successful `code.edit.applied`

### 5. Event Identity and Idempotency

All new events must remain replay-safe across repeated syncs.

Suggested stable ids:

- `codex:session:<sessionId>:prompt:<eventKey>`
- `codex:session:<sessionId>:response:<eventKey>`
- `codex:session:<sessionId>:tool:<callId>:started`
- `codex:session:<sessionId>:tool:<callId>:succeeded`
- `codex:session:<sessionId>:tool:<callId>:failed`
- `codex:session:<sessionId>:patch:<callId>:tool`
- `codex:session:<sessionId>:patch:<callId>:edit`
- `codex:session:<sessionId>:web_search:<callId>:tool`

`eventKey` may be derived from timestamp plus source subtype when no explicit id exists.

The adapter must not emit duplicate events across re-syncs of unchanged rollout files.

### 6. Core and Dashboard Effects

No new event types are required. This slice should continue to use the existing normalized schema:

- `prompt.submitted`
- `assistant.responded`
- `tool.called`
- `tool.succeeded`
- `tool.failed`
- `code.edit.applied`
- `token.usage.recorded`

Expected behavior after integration:

- `/api/overview?sourceVendor=codex`
  - `turnCount` becomes non-zero
  - `totalToolCalls` becomes non-zero where rollout data exposes them
  - `editOperationCount` becomes non-zero where patch events exist
- `/api/tools?sourceVendor=codex`
  - should show real tool rows such as:
    - `apply_patch`
    - `WebSearch`
    - legacy custom tools where present
- `/api/sessions/:id`
  - timeline should include Codex prompt/response/tool/edit rows

### 7. Accuracy Boundaries

#### Codex tokens

Remain governed by the current rollout token logic. This slice must not change token accounting rules.

#### Codex turns

Credible aggregate activity, not a guarantee of perfect one-to-one recovery of every hidden internal agent step.

#### Codex tool calls

Only count structured tool events actually present in rollout artifacts.

#### Codex edit operations

`files_changed` and `file_count` should be treated as high-confidence.

`insertions` and `deletions` are best-effort structured estimates, not billing-grade patch metrics.

#### OpenCode provider host

Trust the local provider registry. If the registry is stale or incomplete, prefer `null` over inference.

## Testing Strategy

### adapters-opencode

Add tests for:

- provider registry loading from object-shaped `models.json`
- enrichment of `assistant.responded`
- enrichment of `token.usage.recorded`
- graceful null fallback when the registry is missing or malformed

### adapters-codex

Add fixture-driven tests for:

- `user_message` -> `prompt.submitted`
- `agent_message` -> `assistant.responded`
- legacy `custom_tool_call` -> tool events
- legacy `custom_tool_call_output` -> success and failure completion
- `patch_apply_end success=true` -> tool + edit events
- `patch_apply_end success=false` -> failed tool only
- `web_search_end` -> tool event
- replay safety and idempotent sync

### apps-core

Add coverage for:

- `Codex` overview turn/tool/edit aggregates
- `Codex` tool ranking endpoint
- `Codex` session timeline rows for prompt/response/tool/edit
- no regression to token totals after the new Codex events are added

### Runtime Smoke

Verify on the real machine:

- `OpenCode` provider host is populated when registry data exists
- `Codex` tools panel is not empty for sessions with patch or search events
- `Codex` timeline shows edit rows for patch sessions
- refreshes and restarts do not duplicate counts

## Acceptance Criteria

This slice is successful when all of the following are true:

1. `OpenCode` source rows and provider breakdowns can show `provider_host` from local registry data
2. `Codex` `turnCount` becomes non-zero on real sessions where rollout `user_message` and `agent_message` exist
3. `Codex` `Tool Calls` becomes non-zero on real sessions where rollout exposes:
   - legacy custom tool calls
   - patch apply events
   - web search events
4. `Codex` `Edit Operations` becomes non-zero on real sessions with successful `patch_apply_end` events
5. `Codex` session timeline includes prompt, response, tool, and edit rows where the rollout format supports them
6. `Codex` token totals do not regress because of this change
7. repeated syncs and restarts do not duplicate Codex counts

## Follow-On Work

After this slice lands, the next optional design slice can evaluate:

- whether newer rollout formats expose enough structure for richer `shell/read/write` visibility
- whether some assistant-side structured items in `response_item` can safely improve Codex timeline detail
- whether OpenCode patch parts can support high-confidence edit events comparable to Codex patch events
