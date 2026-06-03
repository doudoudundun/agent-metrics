# Agent Metrics Desktop Dashboard Design

Date: 2026-05-30
Status: Ready for review

## Summary

Add a cross-platform desktop application for Agent Metrics that targets both Windows and macOS without replacing the current browser-based workflow. The desktop app will preserve the existing monorepo, telemetry ingestion pipeline, local API, and React dashboard foundation. It will add a new desktop container that can run in the background, expose a tray or menu bar entry, and show an always-on-top floating dashboard window.

The first deliverable is a daily-usable desktop edition rather than a release-hardened consumer app. It includes tray or menu bar residency, a floating window mode, settings, launch-at-login, window state restore, and packaged installers. It does not include auto-update, code signing, notarization, or a major rewrite of the current service architecture.

## Goals

- Preserve the current `apps/cli`, `apps/core`, `apps/dashboard`, adapters, and data storage pipeline.
- Add a new desktop runtime that works on both Windows and macOS.
- Support both tray or menu bar residency and an always-on-top floating dashboard window.
- Allow the desktop app to keep running after the main window closes, with a user setting to change that behavior.
- Reuse the current dashboard UI where practical, while allowing desktop-specific layout changes.
- Keep the browser-served dashboard workflow intact for development, debugging, and fallback use.

## Non-Goals

- Rewriting the backend into Rust, native code, or Electron-only APIs.
- Removing the current local HTTP API boundary in the first version.
- Implementing Linux support in this project phase.
- Adding auto-update, crash reporting infrastructure, signing, notarization, or store distribution.
- Redesigning the entire dashboard information architecture.

## Recommended Approach

Use Electron as a new `apps/desktop` application within the existing workspace.

Why this approach:

- It preserves the existing Node and TypeScript architecture with the least disruption.
- It can directly manage the current CLI and API processes without a service rewrite.
- Tray, menu bar, background runtime, always-on-top windows, persisted settings, and packaging are all mature in the Electron ecosystem.
- The team can keep the current Vite and React dashboard flow and incrementally add desktop-specific UI affordances.

Alternatives considered:

1. Tauri with Node sidecars
   - Better package size potential.
   - Higher orchestration complexity because the current runtime is already centered around Node processes.

2. Smaller desktop shells such as Wails or Neutralino
   - Lighter in some cases.
   - Weaker fit for the current monorepo and lower confidence for tray plus process management polish.

## Architecture

### New Workspace App

Add `apps/desktop` with these responsibilities:

- Electron main process
  - Owns app lifecycle.
  - Creates and manages the main window and floating window.
  - Manages tray or menu bar integration.
  - Starts, monitors, and stops the existing local runtime processes.
  - Reads and writes desktop settings.
  - Configures launch-at-login behavior.

- Electron preload
  - Exposes a small, explicit bridge from the renderer to desktop capabilities.
  - Prevents the React app from directly using unrestricted Node APIs.

- Desktop renderer
  - Reuses the dashboard React UI and API calls where possible.
  - Adds desktop-only controls such as mode switching, runtime status, and settings entry points.

### Existing Apps Stay Intact

- `apps/cli` remains responsible for hooks ensure, watch, and parse.
- `apps/core` remains the local Fastify API and SQLite ingestion layer.
- `apps/dashboard` remains the base React dashboard and can continue serving the browser version.

The desktop app wraps the existing system. It does not replace it.

## Runtime Model

On desktop app startup:

1. Electron launches.
2. Electron resolves a managed runtime directory and ports.
3. Electron ensures the required background services are running:
   - hook watcher
   - parser follow process
   - local core API
4. The renderer loads the dashboard against the local API endpoint.
5. Tray or menu bar controls become available immediately after bootstrap.

The managed services remain separate child processes in the first version. Electron acts as the supervisor. This keeps the current boundaries stable and reduces migration risk.

## Window Model

### Main Window

- Full dashboard experience.
- Intended for detailed inspection and settings.
- Can be hidden instead of closed.
- Restores last known size and position.

### Floating Window

- Separate always-on-top window.
- Compact dashboard presentation for at-a-glance monitoring.
- Remembers size and position.
- Can be shown or hidden independently of the main window.
- Uses a simplified layout rather than the full dense dashboard.

### Tray or Menu Bar

- Persistent control surface when the app runs in the background.
- Supports:
  - Show main window
  - Show or hide floating window
  - Open settings
  - Open data directory
  - Quit app

## User Settings

Persist desktop settings in an app-owned config file rather than mixing them into telemetry data.

Settings for the first version:

- close behavior
  - `hide-to-tray`
  - `quit-app`
- launch at login
- show main window on startup
- reopen floating window on startup
- default preferred surface
  - `main-window`
  - `floating-window`
- floating window bounds
- main window bounds
- last selected source filter if reused from the current dashboard

If a saved window position becomes invalid because displays changed, the app should clamp the window back into a visible screen area.

## Dashboard Adaptation

The existing dashboard should be split conceptually into:

- shared dashboard views and data-fetching logic
- browser-shell behavior
- desktop-shell behavior

Expected desktop-specific changes:

- Add a compact layout for the floating window.
- Add a visible runtime status indicator.
- Add desktop controls for opening settings and switching between full and compact views.
- Reduce visual density in the floating mode so key metrics remain readable in a small surface.

The browser dashboard remains supported and should not require the desktop app to function.

## Data Flow

The first version keeps the current data path:

1. Agent hooks emit raw local telemetry.
2. `apps/cli` watcher and parser normalize telemetry into event logs.
3. `apps/core` ingests normalized events into SQLite and serves API responses.
4. Desktop renderer fetches from local HTTP endpoints just like the browser dashboard.

This is intentionally conservative. It means desktopization does not disturb ingestion correctness.

## Failure Handling

The desktop app should degrade safely when managed services fail.

Required behavior:

- If the core API fails to start, surface a clear desktop error state and expose a retry action.
- If the parser or watcher exits unexpectedly, mark runtime as degraded and attempt bounded automatic restart.
- If a child process repeatedly crashes, stop tight restart loops and show a clear problem state in the main window and tray label where possible.
- If the dashboard renderer cannot reach the API, it should show stale-data messaging instead of failing silently.
- Quitting the desktop app should stop only the child processes it started and should not kill unrelated user processes.

## Packaging

The desktop app should produce:

- a macOS app bundle for local use and iterative testing
- a Windows installer or unpacked desktop build suitable for local installation testing

Packaging scope for this phase:

- app metadata
- icons
- per-platform build scripts
- inclusion of required runtime assets

Packaging scope excluded from this phase:

- auto-update service
- production signing and notarization

## Testing Strategy

### Automated

- Unit tests for settings serialization and migration.
- Unit tests for process supervisor behavior with mocked child process outcomes.
- Unit tests for window mode state transitions.
- Renderer tests for compact floating layout behavior where practical.

### Manual

Windows and macOS verification should confirm:

- app launches and starts the managed runtime
- main window loads current dashboard data
- floating window can be shown, hidden, moved, and restored
- closing the main window follows the configured close behavior
- tray or menu bar actions work
- launch-at-login setting persists
- existing browser-based startup path still works
- existing telemetry collection pipeline still records data correctly

## Risks And Mitigations

- Electron increases package size and memory footprint.
  - Accept this for the first version in exchange for lower implementation risk.

- Running multiple child processes from a desktop host can create shutdown edge cases.
  - Mitigate with explicit PID ownership, bounded restarts, and clean app lifecycle hooks.

- The current dashboard may feel too dense in a small floating surface.
  - Mitigate by creating a compact view rather than forcing the existing layout into a tiny window.

- Existing start scripts are currently oriented around development and browser serving.
  - Mitigate by introducing a desktop-owned process supervisor instead of reusing shell scripts directly.

## Implementation Boundaries

To avoid damaging the current framework:

- Do not replace the current browser dashboard startup flow.
- Do not merge desktop settings into telemetry storage.
- Do not rewrite the current API layer before the desktop app is proven.
- Prefer additive changes over invasive refactors.
- Extract shared dashboard modules only where reuse is needed by the desktop renderer.

## Milestones

1. Add `apps/desktop` scaffold and Electron dev loop.
2. Implement process supervision for the current runtime chain.
3. Load the existing dashboard inside the desktop shell.
4. Add tray or menu bar controls and close-behavior settings.
5. Add the compact floating window.
6. Persist settings and restore window state.
7. Produce testable macOS and Windows packages.

## Open Decisions Resolved In This Spec

- Desktop stack: Electron
- Supported platforms in scope: Windows and macOS
- Product shape: tray or menu bar plus floating window
- Framework preservation: keep existing monorepo and service architecture
- Close behavior: configurable, default to background hide
- Delivery target: daily-usable desktop edition, not release-hardened distribution
