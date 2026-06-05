# Agent Metrics Desktop Orb And Peek Card Design

Date: 2026-06-05
Status: Ready for review

## Summary

Extend the existing packaged desktop application so the same `AgentMetrics.exe` can expose multiple coordinated desktop surfaces instead of only the main dashboard window and current floating detail window. The new experience adds a Windows-first desktop orb that can dock to the screen edge, partially hide, reveal itself on pointer proximity, and open a lightweight peek card for at-a-glance metrics. The orb and peek card are not separate products. They are additional entry points inside the same desktop shell, sharing the current runtime supervisor, dashboard data sources, settings storage, and packaged application lifecycle.

The first version keeps the scope narrow. It adds a tray-backed orb, a hover preview card, and a path from that card into the existing detail floating window. It does not redesign the whole dashboard, add cross-platform floating UI parity, or create a second telemetry pipeline.

## Goals

- Keep the feature inside the current packaged desktop app rather than creating a parallel app mode.
- Provide both a tray entry point and a draggable desktop orb on Windows.
- Let the orb dock to the left or right screen edge and partially hide when inactive.
- Show a lightweight peek card on hover, with click-to-pin behavior for longer inspection.
- Reuse the current floating detail window as the expanded drill-down surface.
- Keep desktop data consistent with the current browser and desktop dashboard refresh cadence.
- Reuse the current local runtime, API contracts, and desktop settings infrastructure wherever possible.
- Define the state machine and settings model cross-platform even though the orb UI only launches on Windows in the first version.

## Non-Goals

- Shipping a separate floating-only desktop application.
- Replacing the main dashboard window or current floating detail window.
- Building a fully custom widget framework with skinning, themes, and animation tooling in the first version.
- Enabling orb and peek card UI on macOS in the first phase.
- Adding session lists, trend charts, or model breakdowns to the peek card.
- Introducing a new telemetry aggregation backend just for the orb feature.

## Recommended Approach

Use a multi-window desktop shell extension inside the existing Electron app.

Why this approach:

- It matches the current desktop packaging model and keeps everything inside one desktop app.
- It reuses the existing tray, floating window, settings, and runtime supervision foundation.
- It keeps responsibilities clear by giving each surface one job instead of forcing one window to morph through too many incompatible states.
- It keeps future macOS support open because the controller and settings model stay cross-platform even when the Windows-only orb UI is gated.

Alternatives considered:

1. Single-window multi-state surface
   - Fewer windows.
   - Rejected for the first version because drag, hover, edge hiding, pinning, and detail expansion would create a fragile state machine inside one surface.

2. Web-only surface orchestration
   - Higher React reuse.
   - Rejected because system-level edge docking, partial hiding, pointer hit areas, and non-rectangular desktop affordances are better managed from the Electron shell.

## Architecture

### Desktop Shell Surfaces

The current desktop shell grows from two user-visible windows into four coordinated surfaces:

1. `Main Window`
   - Full desktop dashboard.
   - Continues to own settings, full inspection, and fallback navigation.

2. `Detail Floating Window`
   - Existing compact always-on-top detail surface.
   - Remains the expanded view opened from the peek card.

3. `Orb Window`
   - New small frameless Windows-only surface.
   - Owns dragging, docking, partial hiding, and pointer-based reveal behavior.
   - Does not render dense metrics directly.

4. `Peek Card Window`
   - New lightweight Windows-only preview surface opened near the orb.
   - Shows a compact metric summary and can be pinned temporarily.
   - Opens the detail floating window on demand.

### Shared Desktop Controller

Add a desktop surface controller in the Electron main process to coordinate:

- creation and destruction of the orb and peek card windows
- current surface state
- pointer-driven transitions between orb and peek card
- docking and hidden-offset calculations
- settings persistence for orb-related fields
- tray recovery actions such as reset position and reopen orb

This controller should own window orchestration rather than scattering orb behavior between tray code, main window code, and renderer code.

### Shared Data Snapshot

Add a desktop-level in-memory metrics snapshot that stores:

- the latest successful overview payload reduced to orb-card fields
- the timestamp of the latest refresh
- whether the snapshot is stale
- the latest runtime status needed for desktop surfaces

The main dashboard, detail floating window, and peek card keep using the current local API contracts, but the orb card reads from the shared desktop snapshot rather than starting its own independent fetch loop every time it appears.

## Window And Interaction Model

### Surface Roles

- Tray remains the guaranteed recovery surface.
- Orb is the always-available desktop shortcut on Windows.
- Peek card is the quick inspection surface.
- Detail floating window is the drill-down surface.
- Main window remains the full management surface.

### Primary Interaction Flow

1. Desktop app launches and starts the current runtime chain.
2. On Windows, if orb is enabled, the orb appears near the bottom-right of the primary display or at the restored saved position.
3. The user drags the orb as needed.
4. When the orb reaches the left or right edge, it docks and partially hides.
5. When the pointer approaches or hovers the orb hot zone, the peek card opens.
6. If the user simply hovers, the card closes after the pointer leaves the combined orb-plus-card region.
7. If the user clicks to pin, the card stays open until dismissed.
8. If the user clicks expand, the existing detail floating window opens and the peek card closes.
9. Tray actions can always reopen the main window, detail window, or orb.

### Docking And Partial Hide

First version rules:

- support only left-edge and right-edge docking
- keep a small visible sliver when hidden
- reveal the orb fully when the pointer nears the edge hot zone
- re-hide after inactivity if the card is not open and not pinned
- clamp orb position back into the visible display area when display bounds change

Top and bottom docking are intentionally excluded from the first version.

## Surface State Machine

Define a cross-platform state model even though Windows is the only platform that renders the orb surfaces in the first version.

### States

- `orbHidden`
  - Orb UI disabled or temporarily hidden.
- `orbDocked`
  - Orb visible and available, possibly partially hidden against a screen edge.
- `peekVisible`
  - Peek card shown by hover and not pinned.
- `peekPinned`
  - Peek card explicitly pinned by the user.
- `detailVisible`
  - Existing detail floating window open from the orb flow.
- `mainVisible`
  - Main dashboard window open.

### Transition Rules

- App startup on Windows:
  - `enableOrb` and `showOrbOnStartup` true -> `orbDocked`
  - otherwise -> `orbHidden`
- Hover over orb -> `peekVisible`
- Leave combined orb-plus-card region while not pinned -> `orbDocked`
- Click pin while peek visible -> `peekPinned`
- Dismiss pinned card -> `orbDocked`
- Expand detail from peek visible or pinned -> `detailVisible`
- Open main window from tray or card -> `mainVisible`
- Close main window -> return to previous orb-related state if orb is enabled

### Timing Guidance

- hover-open delay: about `120-180ms`
- hover-close delay: about `250-400ms`

These delays are short enough for quick inspection while reducing accidental flicker when moving between the orb and the card.

## Peek Card Data And Refresh Strategy

The peek card intentionally excludes session rows. The first version only shows:

- total tokens
- total tool calls
- AI coding output
  - edit operation count
  - affected file count
  - insertions
  - deletions
- AI coding efficiency
  - success rate
  - failed executions
  - average duration

The card should reuse the same underlying data cadence as the current browser and desktop dashboard behavior. The implementation should prefer:

- event-driven refresh when new desktop snapshot data arrives
- low-cost fallback polling aligned with the current dashboard cadence
- stale-data display instead of blank states when refresh fails after a successful load

The card only needs three display states:

- `loading`
- `ready`
- `stale`

Large blocking error panels are out of scope for this surface.

## Settings Model

Extend desktop settings with orb-related fields while keeping existing settings intact.

### New Persistent Fields

- `enableOrb`
  - global capability switch
- `showOrbOnStartup`
  - startup behavior switch
- `orbBounds`
  - orb size and position
- `orbDockEdge`
  - `left` or `right`
- `orbCollapsed`
  - whether the orb should restore in partially hidden mode

### Existing Fields Reused

- `closeBehavior`
- `launchAtLogin`
- `showMainWindowOnStartup`
- `reopenFloatingWindowOnStartup`
- `preferredSurface`
- `mainWindowBounds`
- `floatingWindowBounds`

### Non-Persistent Runtime Fields

- `peekPinned`
- temporary hover-open state
- pending hide timers

Those runtime fields should not survive app restart.

## Platform Strategy

### Windows

Enable the full surface set:

- tray
- main window
- detail floating window
- orb window
- peek card window

### macOS

Keep the current desktop shell behavior:

- tray or menu bar
- main window
- detail floating window

Do not render the orb or peek card yet, but keep the controller interfaces and settings schema compatible so later support does not require a protocol redesign.

## Implementation Boundaries

The first version includes:

- orb window creation and lifecycle
- peek card creation and lifecycle
- tray controls for orb recovery
- drag, dock, and partial-hide behavior
- hover preview and click-to-pin behavior
- peek card metric rendering
- open-detail action into the existing floating window
- Windows-only surface gating

The first version excludes:

- macOS orb UI
- top or bottom docking
- session lists in the card
- card-level trend charts
- customizable orb skins
- advanced animation choreography
- deep per-monitor policy tuning beyond safe clamping and restore

## Testing Strategy

### Automated

- settings serialization and migration tests for orb fields
- state-machine tests for hover, pin, dismiss, and expand transitions
- docking and bounds-clamping tests
- main-process window coordination tests with mocked BrowserWindow behavior
- desktop snapshot refresh tests for loading, ready, and stale transitions
- renderer tests for peek card metric layout and compact state behavior

### Manual

Windows verification should confirm:

- orb appears at startup when enabled
- orb can be dragged and restored after restart
- orb docks to left and right edges
- orb partially hides and reappears on pointer proximity
- hover opens the card without flicker
- click pins the card and allows inspection
- card dismisses correctly
- card opens the detail floating window
- tray can reopen orb and reset orb position
- card numbers match the existing dashboard metrics
- stale data appears gracefully when refresh fails

macOS verification should confirm:

- no orb surfaces are created
- existing tray, main window, and detail floating window behavior remain intact

## Risks And Mitigations

- Multi-window hover behavior can flicker or close too aggressively.
  - Mitigate with a unified orb-plus-card hit region model and short delayed close timers.

- Edge docking can break after display resolution or monitor changes.
  - Mitigate with bounds clamping and a tray-level reset position action.

- Separate surfaces can drift out of sync on refresh timing.
  - Mitigate with a shared desktop metrics snapshot and event-driven updates.

- The first version can become overly ambitious if too much dashboard content is moved into the card.
  - Mitigate by keeping the card limited to summary metrics and preserving the detail floating window for expansion.

## Milestones

1. Extend desktop settings and add a desktop surface controller.
2. Add orb window creation, persistence, docking, and recovery controls.
3. Add peek card window, hover behavior, pinning, and compact metric layout.
4. Introduce shared desktop metrics snapshot wiring for orb surfaces.
5. Connect card expansion to the existing detail floating window.
6. Gate orb surfaces to Windows while preserving cross-platform controller contracts.
7. Validate packaged Windows behavior and confirm macOS non-regression.
