# Agent Metrics

Local-first metrics dashboard for Claude Code hooks.

## Quick Start

```powershell
cd D:\projects\dev\agent-metrics
corepack pnpm install
.\start-agent-metrics.ps1
.\install-claude-hooks.ps1
```

After the one-time hook install, open Claude Code in any workspace and trigger a few real tools such as `Read`, `Search/Grep`, `Edit`, and `Bash`.

## How Collection Works

- Claude Code hooks call the local collector in `apps/cli`.
- Raw hook payloads append to `data/hooks/raw/claude-code.jsonl`.
- Normalized events append to `data/events/events.jsonl`.
- `apps/core` ingests normalized events into SQLite.
- `apps/dashboard` renders sessions, tool rankings, edit metrics, and a session timeline.

## Commands

- `corepack pnpm test`
- `corepack pnpm build`
- `corepack pnpm lint`
- `node .\apps\cli\dist\index.js hooks print-config --repo-root D:\projects\dev\agent-metrics`
- `node .\apps\cli\dist\index.js hooks install --scope global --repo-root D:\projects\dev\agent-metrics`

## Manual Install

- Manual sample config: `docs/manual/claude-hooks-global.sample.json`
- One-click Windows installer: `.\install-claude-hooks.ps1`

## Hooks-First Verification

1. Run `.\start-agent-metrics.ps1`
2. Run `.\install-claude-hooks.ps1`
3. Open Claude Code in a test workspace
4. Trigger `Read`, `Search/Grep`, `Edit`, and `Bash`
5. Confirm:
   - `data/hooks/raw/claude-code.jsonl` grows
   - `data/events/events.jsonl` grows
   - the dashboard shows real tool names
   - the session timeline matches the actions you took
