# Phase 7 legacy parity checklist (2026-07-20)

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` §16.9 / Phase 7.

Production entry is `apps/desktop/src/main-v2.ts` (`package.json` `"main": "dist/main-v2.js"`).
Legacy orb / peek / floating code is quarantined under `apps/desktop/src/legacy/` (`main.ts`, `preload.cts`, `orb-*`, `window-state.ts`, `settings.ts`, `tray.ts`). Dashboard legacy surfaces use `legacyDesktopBridge.ts`; v2 Main/Widget use `desktop-mode.ts` + `preload-v2.cts` only.

| Legacy capability | Target | Automated evidence | Native evidence |
|---|---|---|---|
| orb compact indicator | Widget `collapsed` | `widget-state.test.ts` (§16.4 pin/collapsed), `widget-layout.test.ts`, `WidgetPage` | Windows x64 packaged smoke **Passed** (`smoke-win32-x64-2026-07-20.json`); macOS still **Pending** |
| orb hover expansion | collapsed → expanded | `widget-state.test.ts` (`shouldOpen` / pointer-enter), constants §16.4 | pointer hover smoke — **still needed** |
| orb click/pin | collapsed → pinned | `widget-state.test.ts` (§16.4 pin from collapsed) | pointer click smoke — **still needed** |
| peek-card metrics | Widget expanded content | contracts `WidgetSnapshotResponse` + `WidgetPage` | screenshot optional — **still needed** |
| floating persistence | pinned + anchor bounds | `desktop-settings-v2.test.ts`, `widget-layout.test.ts` (pinned geometry, clamp) | restart smoke — **still needed** |
| drag / dock / edge recovery | Widget controller/layout | `widget-layout.test.ts`, display-removed hooks in `main-v2.ts` | multi-display smoke — **still needed** |
| open full Dashboard | `showMainWindow` IPC | contracts IPC table + `main-v2` handlers, `getAgentMetricsMainBridge` | IPC smoke — **still needed** |
| tray show/hide/reset | single Widget commands | `main-v2` tray menu | packaged smoke — **still needed** |
| startup visibility | settings v2 migration | `desktop-settings-v2.test.ts` (see below) | real settings file on packaged app — **still needed** |
| always-on-top | Widget `setAlwaysOnTop` | controller path in `main-v2.ts`; smoke asserts `isAlwaysOnTop` when API available | Windows x64 smoke asserts always-on-top + marker; macOS **Pending** |
| ≤1 Main + ≤1 Widget | product window invariant | `product-windows.test.ts` + `enumerateProductWindows` in `main-v2` smoke | Windows x64 smoke **Passed**; macOS **Pending** |

## Phase 7 code status (2026-07-20)

- **Done:** `main-v2.ts` creates only Main + Widget windows; smoke path calls `enumerateProductWindows` + `assertProductWindowInvariant`.
- **Done:** Legacy desktop modules moved to `apps/desktop/src/legacy/`.
- **Done:** `preload-v2.cts` exposes Widget/Main IPC only; orb/peek APIs isolated in `legacy/preload.cts` + `legacyDesktopBridge.ts`.
- **Done:** `desktop-mode.ts` split — `getAgentMetricsMainBridge` / `getAgentMetricsWidgetBridge` for v2; legacy orb/peek in `getLegacyDesktopBridge`.
- **Done:** §16.4 transition rows covered in `widget-state.test.ts` and `widget-layout.test.ts` (timers/drag threshold exercised in `main-v2.ts`, not unit-tested here per user request).
- **Done (plumbing):** `smoke-package.mjs` writes JSON evidence to `docs/superpowers/notes/evidence/`; desktop smoke writes `desktop-smoke-ok.json` under `AGENT_METRICS_DATA_ROOT`. See [Phase 8 native evidence ledger](./2026-07-20-phase8-native-evidence-ledger.md).

## Phase 7 follow-up fixes (2026-07-20)

Follow-up audit fixes addressing spec §16.4/§16.5/§16.8/§16.9 gaps. Test evidence: `corepack pnpm --filter @agent-metrics/desktop test` → 18 files / 115 tests green; `corepack pnpm typecheck` → exit 0.

| Fix | Spec | Evidence |
|---|---|---|
| **B2 crash/reload recovery** | §16.5 line 1385 | `recoverWidgetStateAfterReload` pure helper in `widget-state.ts` + 3 unit tests (benign reload preserves mode; crash re-asserts persisted mode + clears transient interaction; hidden stays hidden); `attachRendererRecovery` in `main-v2.ts` wires `webContents.on("render-process-gone")` for both windows, reloads the existing single BrowserWindow (never creates a second) |
| **B1 macOS native behavior** | §19 line 1674 | `createTray` applies `setTemplateImage(true)` on darwin; Widget window applies `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })` on darwin. (Native smoke execution still required per OS — see B1 note below) |
| **O1 `open-main` transition wired** | §16.4 line 1346 | `showMainWindow()` now dispatches `reduceWidgetState({ type: "open-main", mode: settings.widgetModeAfterOpenMain })` and re-positions the Widget; does not rewrite `widgetModeOnStartup` |
| **O2 settings migration per §16.8 table** | §16.8 lines 1496-1504 | `migrateLegacySettings` reads `preferredSurface` for `widgetEnabled`/`showWidgetOnStartup`/`widgetModeOnStartup`; `widgetBounds` re-derived as collapsed size at dock edge via `deriveWidgetBounds`; `widgetDockEdge` falls back to nearest edge from legacy bounds; `widgetModeAfterOpenMain` defaults to `collapsed`. 2 new migration tests cover `preferredSurface` divergence and disable-forces-hide |
| **O3 `ACTIVATION_SUPPRESSION_MS` consumed** | §16.4 line 1358 | `onWidgetPointerEnter` suppresses auto-open for `ACTIVATION_SUPPRESSION_MS` after a drag ends; `endWidgetPointer` records `widgetLastDragEndedAt` |
| **O4 tray/widget reset position** | §16.4 line 1350, §16.9 line 1531 | `resetWidgetPosition()` resets anchor to center + persists; tray menu and Widget context menu both expose "Reset Position" |
| **O5 single-instance lock** | §16.1 at-most-one invariant | `requestSingleInstanceLock()` + `second-instance` focuses existing Main window; duplicate process quits |
| **O6 controller uses exported constants** | §16.4 | `main-v2.ts` imports `OPEN_DELAY_MS`/`CLOSE_DELAY_MS`/`DRAG_THRESHOLD_PX` from `widget-state.ts`; removed duplicate `WIDGET_CLOSE_DELAY_MS` and hardcoded `120`/`5` literals |

### Remaining macOS evidence gap (B1 platform blocker)

The darwin code paths (template tray image, all-workspace visibility) are now implemented in `main-v2.ts`, but spec §19 line 1674 requires native execution evidence — "macOS cannot be marked supported solely because electron-builder creates an artifact." A packaged macOS Widget creation/interaction smoke must still run on a darwin host. This is the sole remaining Phase 7 blocker and cannot be resolved from a win32 host.

## Settings migration — automated vs packaged

**Automated (fixtures):** `apps/desktop/src/desktop-settings-v2.test.ts` covers legacy orb/floating field migration into v2 settings and atomic v2-only writes. This is the automated evidence for settings migration logic.

**Still needed:** validate migration against a **real user settings file sample** inside a packaged app (not just unit fixtures). No such sample has been run in this session.

## Removal gate

Do not delete `legacy/main.ts`, `legacy/orb-*`, `legacy/preload.cts`, or Dashboard `LegacyDesktopSurfaces` until:

1. Every row above has automated **or** named native-platform assertion.
2. Windows and macOS Widget creation/interaction smoke have been executed at least once per OS (ledger rows **Passed**).
3. Settings migration v2 has been validated on a real user settings file sample.

## What still blocks declaring Phase 7 complete

- **macOS** Widget creation/interaction smoke (ledger `darwin/*` still Pending). The darwin code paths (template tray image, all-workspace visibility) are implemented but require native execution evidence per spec §19 line 1674. This is a platform blocker that cannot be resolved from a win32 host.
- Named native pointer/tray/multi-display/restart interaction smokes beyond Main+Widget creation (unit coverage exists; packaged pointer matrix not yet recorded).
- Real user settings file sample on a packaged app.

Windows x64 packaged Main/Widget creation smoke is recorded: `docs/superpowers/notes/evidence/smoke-win32-x64-2026-07-20.json`.
