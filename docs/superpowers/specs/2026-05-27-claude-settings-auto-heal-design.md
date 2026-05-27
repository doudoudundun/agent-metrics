# Claude Settings Auto-Heal Design

## Goal

Reduce migration cost and startup cost for local `agent-metrics` usage by removing the need to manually re-edit Claude Code hook settings after provider switches. When `agent-metrics` is running, it should automatically ensure the required Claude hooks exist and restore them if tools such as `ccswitch` overwrite the user settings file.

## Scope

This design covers:

- automatic hook ensure during `agent-metrics` startup
- runtime watching of the Claude user settings file while `agent-metrics` is running
- safe hook re-merge after settings changes
- conflict avoidance with unrelated existing hooks
- operator-visible logs for auto-heal activity

This design does not cover:

- machine-level `managed-settings.json`
- always-on Windows background services outside `agent-metrics`
- company-wide deployment policy
- token or cost attribution

## Confirmed Decisions

- Use the user-level Claude settings file, not Windows managed settings.
- Do not require manual settings edits during normal usage.
- Auto-heal runs only while `agent-metrics` is running.
- `start-agent-metrics.ps1` becomes the primary entry point for hook ensure and watcher startup.
- Settings changes must be merged structurally as JSON, not via string replacement.
- Only `agent-metrics`-owned hooks may be added, replaced, or removed by this feature.
- Invalid JSON must not be force-overwritten.

## Current State

Today the project can install Claude hooks into `~/.claude/settings.json` with:

- `install-claude-hooks.ps1`
- `agent-metrics hooks install --scope global --repo-root <repo>`

The current installer already merges hook trees instead of replacing the entire settings file. That solves first-time installation, but not hot provider switching. If another tool overwrites the Claude settings file after installation, `agent-metrics` stops receiving hooks until the user manually reinstalls them.

## Problem Statement

The user frequently switches model vendors with `ccswitch`. That hot switch can overwrite the Claude user settings file and remove the `agent-metrics` hook configuration. Requiring manual repair creates repeated migration cost and startup friction. The fix must be automatic, must preserve other settings content, and must not create syntax conflicts with unrelated hooks.

## Recommended Approach

Use a two-part user-level auto-heal flow:

1. `hooks ensure`
   - Runs once at startup.
   - Checks whether all required `agent-metrics` hooks exist in the Claude settings file.
   - Writes only if the `agent-metrics` hook set is missing or incomplete.

2. `hooks watch`
   - Runs only while `agent-metrics` is active.
   - Watches the Claude settings file for changes.
   - Re-runs the same structural ensure logic whenever the file changes.
   - If `ccswitch` removes the managed hooks, the watcher re-adds only the missing `agent-metrics` entries.

This keeps the feature local, simple, and reversible without introducing a permanent OS-level daemon.

## Alternatives Considered

### 1. Startup-only ensure

Run `hooks ensure` only once inside `start-agent-metrics.ps1`.

Pros:

- simplest implementation
- no long-running watcher

Cons:

- fails to repair hooks after a later `ccswitch` hot switch in the same session

### 2. Runtime watcher with startup ensure

Run `hooks ensure` once, then keep a watcher process alive while `agent-metrics` is running.

Pros:

- repairs hooks after hot switching
- no permanent background service
- fits the user requirement directly

Cons:

- adds one more managed process
- needs debounce and self-write protection

### 3. Machine-level managed settings

Write hooks into `C:\ProgramData\ClaudeCode\managed-settings.json`.

Pros:

- strongest persistence

Cons:

- requires higher privileges
- wider blast radius than needed
- not aligned with the current single-user goal

Recommendation: option 2.

## Functional Design

### 1. Hook Ownership Model

`agent-metrics` already generates a deterministic hook command shape:

- `node <repo>/apps/cli/dist/index.js hooks collect --hook-event-name <event> --repo-root <repo>`

This command signature remains the ownership marker. Auto-heal logic must only manage hooks matching that command family. Other hooks remain untouched.

### 2. Settings Ensure Command

Add a new CLI command:

- `agent-metrics hooks ensure --scope global --repo-root <repo>`

Behavior:

- resolve the Claude settings path
- read the current JSON object if present
- return a non-destructive result if the file is missing, empty, valid, or already complete
- merge the required `agent-metrics` hook entries into the `hooks` tree
- write the file only when the resulting structure differs
- print a simple status such as `created`, `updated`, `unchanged`, or `invalid-json`

The ensure command becomes the shared engine used by both installer flows and the runtime watcher.

### 3. Settings Watch Command

Add a new CLI command:

- `agent-metrics hooks watch --scope global --repo-root <repo>`

Behavior:

- watch the Claude settings path and its parent directory
- debounce burst writes from external tools
- on each stable change, re-run the ensure logic
- if the file is temporarily invalid JSON, log and wait for the next change instead of overwriting it
- keep running until the parent startup script stops it

The watcher is not responsible for metrics collection, parsing, or the dashboard. Its only job is settings self-heal.

### 4. Startup Script Integration

`start-agent-metrics.ps1` should:

1. bootstrap dependencies/builds as today
2. run `hooks ensure`
3. start the settings watcher if not already running
4. start the parser, core API, and dashboard

The script must manage watcher PID/log files in `.runtime`, parallel to parser/core/dashboard management.

### 5. Merge Rules

The merge algorithm must obey these rules:

- never replace the full settings document
- never replace the full `hooks` object
- never delete non-`agent-metrics` hooks
- preserve existing matcher objects and foreign commands as-is
- for a given event and matcher, append only the missing `agent-metrics` command hooks
- avoid duplicate insertion of equivalent `agent-metrics` hooks
- permit updates when the generated command arguments change in a future release

### 6. Invalid JSON Handling

If the settings file cannot be parsed as a JSON object:

- `hooks ensure` reports `invalid-json`
- `hooks watch` logs the parse failure
- neither command overwrites the file

This avoids turning another tool's partial write into data loss.

### 7. Self-Write Suppression

The watcher must avoid entering a write loop when it updates the settings file itself. Acceptable approaches include:

- caching a last-written content hash
- caching last write timestamp plus content equality
- ignoring immediate duplicate change notifications for unchanged parsed content

The implementation should choose the smallest reliable mechanism.

## Data Flow

1. User runs `.\start-agent-metrics.ps1`
2. Script runs `agent-metrics hooks ensure`
3. Script starts `agent-metrics hooks watch`
4. User hot-switches provider with `ccswitch`
5. `ccswitch` rewrites `~/.claude/settings.json`
6. Watcher detects the change, re-reads the file, and structurally merges back missing `agent-metrics` hooks
7. Claude hooks remain active without manual repair

## Files Likely Affected

- `apps/cli/src/hooks/install.ts`
- `apps/cli/src/hooks/register.ts`
- new watcher-related hook CLI file(s) under `apps/cli/src/hooks/`
- `apps/cli/src/hooks/*.test.ts`
- `start-agent-metrics.ps1`
- `README.md`
- optional operator doc under `docs/manual/`

## Testing Strategy

Automated coverage should include:

- ensure creates a missing settings file
- ensure fills in missing `agent-metrics` hooks without removing foreign hooks
- ensure is idempotent when hooks are already complete
- ensure reports invalid JSON without overwriting the file
- watcher reacts to an external settings rewrite and restores missing hooks
- watcher does not duplicate hooks across repeated changes
- watcher does not loop infinitely on its own writes
- startup wiring invokes ensure before runtime services

Manual acceptance should include:

1. Start `agent-metrics`.
2. Confirm the Claude settings file contains `agent-metrics` hook entries.
3. Trigger a `ccswitch` hot switch that rewrites the settings file.
4. Confirm the watcher restores the `agent-metrics` hook entries automatically.
5. Confirm unrelated hooks remain intact.
6. Confirm Claude tool activity still appears in the dashboard after the switch.

## Risks

### 1. File Watch Event Noise

Windows file watchers can emit repeated or partial notifications. The watcher needs debounce logic and content-based equality checks.

### 2. Repository Path Drift

If the project directory moves, the existing hook commands may point at an old CLI path. Ensure logic should refresh managed hooks to the current `repoRoot`.

### 3. Concurrent Writers

Another tool may rewrite the settings file at nearly the same time. The merge logic should always re-read current disk content before each write and only apply a minimal patch.

## Success Criteria

- Starting `agent-metrics` no longer requires manual Claude settings edits in the normal case.
- A `ccswitch` hot switch during an active `agent-metrics` session does not leave hooks broken.
- Other settings and other hooks remain intact after auto-heal.
- Invalid settings JSON is never silently overwritten.
- The behavior is observable through logs and reproducible through tests.
