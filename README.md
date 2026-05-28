# Agent Metrics

Local-first metrics dashboard for Claude Code hooks.

## Quick Start

```powershell
cd D:\projects\dev\agent-metrics
corepack pnpm install
.\start-agent-metrics.ps1
```

`start-agent-metrics.ps1` now ensures the Claude user hooks and starts a runtime watcher that restores missing `agent-metrics` hooks if another tool rewrites `~/.claude/settings.json`.

Ignoring local runtime data in `.gitignore` does not break startup. If someone clones the repo fresh, the app recreates the needed local data files and state directories on first run.

After startup, open Claude Code in any workspace and trigger a few real tools such as `Read`, `Search/Grep`, `Edit`, and `Bash`.

## How Collection Works

- Claude Code hooks call the local ingress collector in `apps/cli`.
- Raw hook envelopes append to `data/hooks/raw/claude-code.jsonl`.
- `agent-metrics hooks parse --follow` converts raw envelopes into normalized events at `data/events/events.jsonl`.
- `apps/core` ingests normalized events into SQLite on API requests.
- `apps/dashboard` renders sessions, tool rankings, edit metrics, and a session timeline.

## Dashboard Behavior

- The dashboard defaults to the current calendar day (`Today`) when it first loads.
- The hero toolbar switches the global dashboard scope between natural calendar views, rolling window views, and lifetime.
- Selected aggregate panels can override the global scope without changing the rest of the dashboard.
- `Updated` shows the backend `updatedAt` value formatted as a full local date-time.

## Commands

- `corepack pnpm test`
- `corepack pnpm build`
- `corepack pnpm lint`
- `node .\apps\cli\dist\index.js hooks print-config --repo-root D:\projects\dev\agent-metrics`
- `node .\apps\cli\dist\index.js hooks ensure --scope global --repo-root D:\projects\dev\agent-metrics`
- `node .\apps\cli\dist\index.js hooks install --scope global --repo-root D:\projects\dev\agent-metrics`
- `node .\apps\cli\dist\index.js hooks watch --scope global --repo-root D:\projects\dev\agent-metrics`

## Manual Install

- Manual sample config: `docs/manual/claude-hooks-global.sample.json`
- One-click Windows fallback: `.\install-claude-hooks.ps1`
- Parser runtime notes: `docs/manual/phase2-parser-flow.md`

## Safe Sharing

- `git clone` remains runnable after ignoring local telemetry data.
- A fresh machine can still start with:

```powershell
corepack pnpm install
.\start-agent-metrics.ps1
```

- To create a share-safe source package without local SQLite, event logs, or hook state:

```powershell
.\export-agent-metrics-share.ps1 -Zip
```

## Hooks-First Verification

1. Run `.\start-agent-metrics.ps1`
2. Confirm the startup output reports Claude hook ensure and watcher startup
3. Open Claude Code in a test workspace
4. Trigger `Read`, `Search/Grep`, `Edit`, and `Bash`
5. Optionally rewrite `~/.claude/settings.json` without the `agent-metrics` hooks and confirm they are restored
6. Confirm:
   - the app starts and the dashboard is serving
   - the default dashboard view is the current calendar day
   - switching the hero toolbar to calendar week updates the global scope
   - switching the hero toolbar to rolling week updates the global scope
   - switching the hero toolbar to lifetime updates the global scope
   - one aggregate panel can override the global scope without changing the other panels
   - `data/hooks/raw/claude-code.jsonl` grows
   - `data/events/events.jsonl` grows
   - `data/hooks/state/parser-state.json` advances
   - the dashboard shows real tool names
   - the session timeline matches the actions you took

## Recovery

If raw hooks are growing but normalized events stop moving:

1. Stop the managed parser process.
2. Delete `data/hooks/state/parser-state.json`.
3. Run `node .\apps\cli\dist\index.js hooks parse --repo-root D:\projects\dev\agent-metrics`.
4. Restart `.\start-agent-metrics.ps1`.
