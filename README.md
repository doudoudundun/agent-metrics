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

## Desktop App

- Browser dashboard development still works with `corepack pnpm dev`.
- Start desktop development: `corepack pnpm dev:desktop`
- Package a macOS Apple Silicon app bundle: `corepack pnpm package:desktop:mac`
- Package a macOS Intel app bundle: `corepack pnpm package:desktop:mac:x64`
- Package a Windows x64 desktop build: `corepack pnpm package:desktop:win`
- Package a Windows ARM64 desktop build: `corepack pnpm package:desktop:win:arm64`

The desktop app preserves the existing local telemetry pipeline. The browser dashboard still works and remains the default fallback for debugging.

Current verified release artifacts:

- Apple Silicon macOS: `apps/desktop/release/AgentMetrics-mac-arm64.zip`
- Intel macOS: `apps/desktop/release/AgentMetrics-mac-x64.zip`
- Windows x64: `apps/desktop/release/AgentMetrics-win-x64.zip`
- Windows ARM64: `apps/desktop/release/AgentMetrics-win-arm64.zip`

Compatibility notes:

- `mac-arm64` works on Apple Silicon Macs such as M1, M2, M3, and M4 Mac mini models.
- `mac-arm64` does not run on Intel Mac mini models.
- `win-arm64` is for Windows on ARM devices only.
- Most Windows desktops and laptops need the `win:x64` build.

## Desktop Install And Use

### Pick The Right Package

- Apple Silicon Mac mini, MacBook, or iMac (`M1`, `M2`, `M3`, `M4`): use `AgentMetrics-mac-arm64.zip`
- Intel Mac mini or Intel MacBook: use `AgentMetrics-mac-x64.zip`
- Most Windows desktops and laptops: use `AgentMetrics-win-x64.zip`
- Windows on ARM devices: use `AgentMetrics-win-arm64.zip`

### Install On macOS

1. Download the correct macOS zip package.
2. Double-click the zip file to extract it.
3. Drag `AgentMetrics.app` into `Applications`.
4. Open `AgentMetrics.app`.
5. If macOS blocks the first launch, open `System Settings -> Privacy & Security` and choose `Open Anyway`.

### Install On Windows

1. Download the correct Windows zip package.
2. Right-click the zip file and extract it.
3. Open the extracted folder such as `win-unpacked`.
4. Double-click `AgentMetrics.exe`.
5. If Windows SmartScreen appears, click `More info`, then click `Run anyway`.

### Two Ways To Open The App

The desktop app supports two working modes:

1. Main dashboard window
2. Floating always-on-top window

### Main Dashboard Window

Use this mode when you want the full dashboard.

How to open it:

- macOS: click the menu bar icon and choose `Open Dashboard`
- Windows: click the tray icon and choose `Open Dashboard`
- A single click on the tray or menu bar icon also opens the main dashboard

What it is for:

- viewing the full dashboard
- reviewing sessions, rankings, charts, and detailed metrics
- changing time ranges and exploring data in depth

### Floating Always-On-Top Window

Use this mode when you want a compact desktop monitor that stays visible while you work.

How to open it:

- macOS: click the menu bar icon and choose `Show or Hide Floating Window`
- Windows: click the tray icon and choose `Show or Hide Floating Window`

What it is for:

- keeping a live summary visible on the desktop
- checking sessions, turns, and tokens at a glance
- monitoring activity without opening the full dashboard

### Windows desktop orb

The packaged desktop app can expose a tray-backed orb on Windows. The orb can dock to the left or right edge, partially hide, and reveal a lightweight metrics card on hover. Use the tray menu to reopen the orb or reset its position if it moves off-screen.

### Close, Hide, And Quit

- Closing the main dashboard window does not quit the app by default.
- Closing the main dashboard window hides it to the tray on Windows or the menu bar on macOS.
- Closing the floating window hides only the floating window.
- To fully exit the app, open the tray or menu bar menu and choose `Quit`.

### What Happens After Launch

- The desktop app starts the existing local telemetry pipeline instead of replacing it.
- The browser dashboard remains available for debugging and development.
- Window size and position are remembered between launches.
- The floating window can be moved and reopened independently from the main dashboard.

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
