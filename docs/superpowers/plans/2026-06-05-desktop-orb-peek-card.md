# Desktop Orb And Peek Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows-first desktop orb and hover peek card to the existing packaged desktop app without creating a second desktop product or changing the current telemetry pipeline.

**Architecture:** Extend the current Electron shell with a dedicated surface controller that manages two new Windows-only windows: an orb window and a peek card window. Reuse the existing runtime supervisor, settings store, floating detail window, and dashboard renderer, and introduce a shared desktop metrics snapshot so the orb card, detail window, and full dashboard stay in sync.

**Tech Stack:** TypeScript, Electron, React, Vite, Vitest, existing desktop preload bridge, existing local Fastify API, existing dashboard components

---

## File Map

### Desktop shell orchestration

- Create: `apps/desktop/src/orb-state.ts`
- Create: `apps/desktop/src/orb-state.test.ts`
- Create: `apps/desktop/src/orb-snapshot.ts`
- Create: `apps/desktop/src/orb-snapshot.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/tray.ts`

Responsibility:

- define orb and peek-card state transitions
- manage Windows-only orb and card windows
- expose orb controls to the renderer
- maintain a shared desktop metrics snapshot
- expand tray recovery actions

### Desktop settings and geometry

- Modify: `apps/desktop/src/window-state.ts`
- Modify: `apps/desktop/src/window-state.test.ts`
- Modify: `apps/desktop/src/settings.ts`

Responsibility:

- persist orb settings
- sanitize saved orb geometry
- clamp orb bounds when displays change

### Dashboard desktop renderer

- Create: `apps/dashboard/src/components/OrbSurface.tsx`
- Create: `apps/dashboard/src/components/OrbSurface.test.tsx`
- Create: `apps/dashboard/src/components/PeekCardDashboard.tsx`
- Create: `apps/dashboard/src/components/PeekCardDashboard.test.tsx`
- Modify: `apps/dashboard/src/desktop-mode.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/styles.css`
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/api.test.ts`

Responsibility:

- add a dedicated orb renderer mode
- add a dedicated peek-card renderer mode
- keep the existing desktop-main and desktop-floating modes intact
- render the agreed compact metric set
- route orb actions through the desktop bridge

### Documentation

- Modify: `README.md`

Responsibility:

- document Windows orb support, tray recovery, and desktop verification steps

## Task 1: Extend desktop settings for orb persistence

**Files:**
- Modify: `apps/desktop/src/window-state.ts`
- Modify: `apps/desktop/src/window-state.test.ts`
- Modify: `apps/desktop/src/settings.ts`
- Test: `apps/desktop/src/window-state.test.ts`

- [ ] **Step 1: Write the failing orb settings tests**

```ts
import { describe, expect, it } from "vitest";
import { sanitizeDesktopSettings, defaultDesktopSettings } from "./window-state";

describe("orb desktop settings", () => {
  it("defaults the orb to enabled on Windows-compatible settings", () => {
    expect(defaultDesktopSettings().enableOrb).toBe(true);
    expect(defaultDesktopSettings().showOrbOnStartup).toBe(true);
    expect(defaultDesktopSettings().orbDockEdge).toBe("right");
  });

  it("drops invalid orb bounds and preserves valid persisted values", () => {
    expect(
      sanitizeDesktopSettings({
        enableOrb: false,
        showOrbOnStartup: true,
        orbDockEdge: "left",
        orbCollapsed: true,
        orbBounds: { x: 1200, y: 620, width: 56, height: 56 }
      })
    ).toMatchObject({
      enableOrb: false,
      showOrbOnStartup: true,
      orbDockEdge: "left",
      orbCollapsed: true,
      orbBounds: { x: 1200, y: 620, width: 56, height: 56 }
    });

    expect(
      sanitizeDesktopSettings({
        orbBounds: { x: 10, y: 10, width: -1, height: 56 }
      }).orbBounds
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @agent-metrics/desktop exec vitest run src/window-state.test.ts`

Expected: FAIL because `enableOrb`, `showOrbOnStartup`, `orbDockEdge`, `orbCollapsed`, and `orbBounds` do not exist yet.

- [ ] **Step 3: Add orb fields to the desktop settings model**

```ts
export type OrbDockEdge = "left" | "right";

export type DesktopSettings = {
  closeBehavior: "hide-to-tray" | "quit-app";
  launchAtLogin: boolean;
  showMainWindowOnStartup: boolean;
  reopenFloatingWindowOnStartup: boolean;
  preferredSurface: "main-window" | "floating-window" | "orb";
  enableOrb: boolean;
  showOrbOnStartup: boolean;
  orbDockEdge: OrbDockEdge;
  orbCollapsed: boolean;
  orbBounds: WindowBounds | null;
  mainWindowBounds: WindowBounds | null;
  floatingWindowBounds: WindowBounds | null;
};

export function defaultDesktopSettings(): DesktopSettings {
  return {
    closeBehavior: "hide-to-tray",
    launchAtLogin: false,
    showMainWindowOnStartup: true,
    reopenFloatingWindowOnStartup: false,
    preferredSurface: "main-window",
    enableOrb: true,
    showOrbOnStartup: true,
    orbDockEdge: "right",
    orbCollapsed: false,
    orbBounds: null,
    mainWindowBounds: null,
    floatingWindowBounds: { x: 80, y: 80, width: 440, height: 320 }
  };
}
```

- [ ] **Step 4: Sanitize orb persistence values**

```ts
export function sanitizeDesktopSettings(value: unknown): DesktopSettings {
  const defaults = defaultDesktopSettings();

  if (!isRecord(value)) {
    return defaults;
  }

  return {
    closeBehavior:
      value.closeBehavior === "hide-to-tray" || value.closeBehavior === "quit-app"
        ? value.closeBehavior
        : defaults.closeBehavior,
    launchAtLogin:
      typeof value.launchAtLogin === "boolean" ? value.launchAtLogin : defaults.launchAtLogin,
    showMainWindowOnStartup:
      typeof value.showMainWindowOnStartup === "boolean"
        ? value.showMainWindowOnStartup
        : defaults.showMainWindowOnStartup,
    reopenFloatingWindowOnStartup:
      typeof value.reopenFloatingWindowOnStartup === "boolean"
        ? value.reopenFloatingWindowOnStartup
        : defaults.reopenFloatingWindowOnStartup,
    preferredSurface:
      value.preferredSurface === "main-window" ||
      value.preferredSurface === "floating-window" ||
      value.preferredSurface === "orb"
        ? value.preferredSurface
        : defaults.preferredSurface,
    enableOrb: typeof value.enableOrb === "boolean" ? value.enableOrb : defaults.enableOrb,
    showOrbOnStartup:
      typeof value.showOrbOnStartup === "boolean"
        ? value.showOrbOnStartup
        : defaults.showOrbOnStartup,
    orbDockEdge: value.orbDockEdge === "left" ? "left" : defaults.orbDockEdge,
    orbCollapsed:
      typeof value.orbCollapsed === "boolean" ? value.orbCollapsed : defaults.orbCollapsed,
    orbBounds: sanitizeWindowBounds(value.orbBounds),
    mainWindowBounds: sanitizeWindowBounds(value.mainWindowBounds),
    floatingWindowBounds:
      sanitizeWindowBounds(value.floatingWindowBounds) ?? defaults.floatingWindowBounds
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `corepack pnpm --filter @agent-metrics/desktop exec vitest run src/window-state.test.ts`

Expected: PASS with the new orb settings assertions passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/window-state.ts apps/desktop/src/window-state.test.ts apps/desktop/src/settings.ts
git commit -m "feat: add orb desktop settings"
```

## Task 2: Add orb state machine and shared desktop metrics snapshot

**Files:**
- Create: `apps/desktop/src/orb-state.ts`
- Create: `apps/desktop/src/orb-state.test.ts`
- Create: `apps/desktop/src/orb-snapshot.ts`
- Create: `apps/desktop/src/orb-snapshot.test.ts`
- Test: `apps/desktop/src/orb-state.test.ts`
- Test: `apps/desktop/src/orb-snapshot.test.ts`

- [ ] **Step 1: Write the failing orb state-machine tests**

```ts
import { describe, expect, it } from "vitest";
import {
  createOrbSurfaceState,
  hoverOrb,
  leaveOrbRegion,
  pinPeekCard,
  dismissPeekCard,
  expandOrbDetail
} from "./orb-state";

describe("orb surface state", () => {
  it("moves from docked to hover, pinned, and detail states", () => {
    const initial = createOrbSurfaceState("orbDocked");
    expect(hoverOrb(initial).mode).toBe("peekVisible");
    expect(pinPeekCard(hoverOrb(initial)).mode).toBe("peekPinned");
    expect(expandOrbDetail(pinPeekCard(hoverOrb(initial))).mode).toBe("detailVisible");
  });

  it("returns to docked after leaving or dismissing the card", () => {
    expect(leaveOrbRegion(createOrbSurfaceState("peekVisible")).mode).toBe("orbDocked");
    expect(dismissPeekCard(createOrbSurfaceState("peekPinned")).mode).toBe("orbDocked");
  });
});
```

- [ ] **Step 2: Write the failing snapshot tests**

```ts
import { describe, expect, it } from "vitest";
import { createDesktopMetricsSnapshot, updateDesktopMetricsSnapshot } from "./orb-snapshot";

describe("desktop metrics snapshot", () => {
  it("stores the reduced orb metric payload and marks it fresh", () => {
    const snapshot = updateDesktopMetricsSnapshot(
      createDesktopMetricsSnapshot(),
      {
        totalTokens: 1200,
        totalToolCalls: 21,
        editOperationCount: 3,
        affectedFileCount: 2,
        insertions: 80,
        deletions: 11,
        successRate: 0.75,
        failedExecutions: 1,
        averageDurationMs: 420
      },
      "2026-06-05T06:00:00.000Z"
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.metrics.totalTokens).toBe(1200);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `corepack pnpm --filter @agent-metrics/desktop exec vitest run src/orb-state.test.ts src/orb-snapshot.test.ts`

Expected: FAIL because `orb-state.ts` and `orb-snapshot.ts` do not exist yet.

- [ ] **Step 4: Implement the orb state helpers**

```ts
export type OrbSurfaceMode =
  | "orbHidden"
  | "orbDocked"
  | "peekVisible"
  | "peekPinned"
  | "detailVisible"
  | "mainVisible";

export type OrbSurfaceState = {
  mode: OrbSurfaceMode;
};

export function createOrbSurfaceState(mode: OrbSurfaceMode): OrbSurfaceState {
  return { mode };
}

export function hoverOrb(state: OrbSurfaceState): OrbSurfaceState {
  return state.mode === "orbDocked" ? { mode: "peekVisible" } : state;
}

export function leaveOrbRegion(state: OrbSurfaceState): OrbSurfaceState {
  return state.mode === "peekVisible" ? { mode: "orbDocked" } : state;
}

export function pinPeekCard(state: OrbSurfaceState): OrbSurfaceState {
  return state.mode === "peekVisible" ? { mode: "peekPinned" } : state;
}

export function dismissPeekCard(state: OrbSurfaceState): OrbSurfaceState {
  return state.mode === "peekPinned" ? { mode: "orbDocked" } : state;
}

export function expandOrbDetail(state: OrbSurfaceState): OrbSurfaceState {
  return state.mode === "peekVisible" || state.mode === "peekPinned"
    ? { mode: "detailVisible" }
    : state;
}
```

- [ ] **Step 5: Implement the shared snapshot reducer**

```ts
export type DesktopOrbMetrics = {
  totalTokens: number;
  totalToolCalls: number;
  editOperationCount: number;
  affectedFileCount: number;
  insertions: number;
  deletions: number;
  successRate: number;
  failedExecutions: number;
  averageDurationMs: number;
};

export type DesktopMetricsSnapshot = {
  status: "loading" | "ready" | "stale";
  metrics: DesktopOrbMetrics;
  updatedAt: string | null;
};

export function createDesktopMetricsSnapshot(): DesktopMetricsSnapshot {
  return {
    status: "loading",
    metrics: {
      totalTokens: 0,
      totalToolCalls: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      successRate: 0,
      failedExecutions: 0,
      averageDurationMs: 0
    },
    updatedAt: null
  };
}

export function updateDesktopMetricsSnapshot(
  _current: DesktopMetricsSnapshot,
  metrics: DesktopOrbMetrics,
  updatedAt: string
): DesktopMetricsSnapshot {
  return {
    status: "ready",
    metrics,
    updatedAt
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm --filter @agent-metrics/desktop exec vitest run src/orb-state.test.ts src/orb-snapshot.test.ts`

Expected: PASS with both new test files green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/orb-state.ts apps/desktop/src/orb-state.test.ts apps/desktop/src/orb-snapshot.ts apps/desktop/src/orb-snapshot.test.ts
git commit -m "feat: add orb state and snapshot helpers"
```

## Task 3: Extend the desktop bridge and tray for orb controls

**Files:**
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/dashboard/src/desktop-mode.ts`
- Modify: `apps/desktop/src/tray.ts`
- Test: `apps/dashboard/src/App.test.tsx`

- [ ] **Step 1: Write a failing desktop bridge expectation in the dashboard tests**

```ts
type AgentMetricsDesktopBridge = {
  getRuntimeStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  showMainWindow: () => Promise<void>;
  toggleFloatingWindow: () => Promise<{ visible: boolean }>;
  showOrb: () => Promise<void>;
  hideOrb: () => Promise<void>;
  pinPeekCard: () => Promise<void>;
  expandOrbDetail: () => Promise<void>;
};
```

Add an assertion in `apps/dashboard/src/App.test.tsx` that orb actions are only shown when `window.agentMetricsDesktop` contains the new methods.

- [ ] **Step 2: Run the failing dashboard test**

Run: `corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/App.test.tsx --testNamePattern "shows desktop actions only when the preload bridge is available"`

Expected: FAIL because the dashboard bridge types and mock bridge do not yet include orb actions.

- [ ] **Step 3: Extend the preload bridge**

```ts
export type AgentMetricsDesktopBridge = {
  getRuntimeStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  showMainWindow: () => Promise<void>;
  toggleFloatingWindow: () => Promise<{ visible: boolean }>;
  showOrb: () => Promise<void>;
  hideOrb: () => Promise<void>;
  pinPeekCard: () => Promise<void>;
  expandOrbDetail: () => Promise<void>;
};

const desktopBridge: AgentMetricsDesktopBridge = {
  getRuntimeStatus: () => ipcRenderer.invoke("desktop:get-runtime-status"),
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  updateSettings: (patch) => ipcRenderer.invoke("desktop:update-settings", patch),
  showMainWindow: () => ipcRenderer.invoke("desktop:show-main-window").then(() => undefined),
  toggleFloatingWindow: () =>
    ipcRenderer.invoke("desktop:toggle-floating-window") as Promise<{ visible: boolean }>,
  showOrb: () => ipcRenderer.invoke("desktop:show-orb").then(() => undefined),
  hideOrb: () => ipcRenderer.invoke("desktop:hide-orb").then(() => undefined),
  pinPeekCard: () => ipcRenderer.invoke("desktop:pin-peek-card").then(() => undefined),
  expandOrbDetail: () => ipcRenderer.invoke("desktop:expand-orb-detail").then(() => undefined)
};
```

- [ ] **Step 4: Mirror the new bridge contract in the dashboard desktop-mode types**

```ts
export type AgentMetricsDesktopBridge = {
  getRuntimeStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  showMainWindow: () => Promise<void>;
  toggleFloatingWindow: () => Promise<{ visible: boolean }>;
  showOrb: () => Promise<void>;
  hideOrb: () => Promise<void>;
  pinPeekCard: () => Promise<void>;
  expandOrbDetail: () => Promise<void>;
};
```

- [ ] **Step 5: Expand tray recovery actions**

```ts
export function createDesktopTray({
  showMainWindow,
  toggleFloatingWindow,
  showOrb,
  resetOrbPosition,
  openSettings,
  quitApp
}: {
  showMainWindow: () => void;
  toggleFloatingWindow: () => void;
  showOrb: () => void;
  resetOrbPosition: () => void;
  openSettings: () => void;
  quitApp: () => void;
}) {
  const tray = new Tray(createTrayIcon());

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dashboard", click: showMainWindow },
      { label: "Show or Hide Floating Window", click: toggleFloatingWindow },
      { label: "Show Orb", click: showOrb },
      { label: "Reset Orb Position", click: resetOrbPosition },
      { label: "Open Settings", click: openSettings },
      { type: "separator" },
      { label: "Quit", click: quitApp }
    ])
  );

  return tray;
}
```

- [ ] **Step 6: Re-run the dashboard bridge test**

Run: `corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/App.test.tsx --testNamePattern "shows desktop actions only when the preload bridge is available"`

Expected: PASS after the mock bridge and renderer types are updated.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/preload.ts apps/desktop/src/tray.ts apps/dashboard/src/desktop-mode.ts apps/dashboard/src/App.test.tsx
git commit -m "feat: add orb desktop bridge actions"
```

## Task 4: Add orb and peek-card window orchestration to the desktop shell

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/runtime-paths.ts`
- Modify: `apps/desktop/src/runtime-paths.test.ts`
- Test: `apps/desktop/src/runtime-paths.test.ts`
- Test: `apps/desktop/src/runtime/process-supervisor.test.ts`

- [ ] **Step 1: Write a failing runtime-paths test for orb support**

```ts
it("resolves the packaged orb surface against the desktop runtime", () => {
  expect(
    resolveDesktopRuntimePaths({
      currentDir: "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\app.asar\\dist",
      isPackaged: true,
      userDataPath: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics"
    })
  ).toMatchObject({
    coreApiBaseUrl: "http://127.0.0.1:45183"
  });
});
```

Add new tests in `apps/desktop/src/runtime-paths.test.ts` for both `surface=desktop-orb` and `surface=desktop-orb-peek`.

- [ ] **Step 2: Run the failing desktop runtime-paths test**

Run: `corepack pnpm --filter @agent-metrics/desktop exec vitest run src/runtime-paths.test.ts`

Expected: FAIL until the new surface URL or additional controller wiring is added.

- [ ] **Step 3: Add orb window and peek card window references to `main.ts`**

```ts
let orbWindow: BrowserWindowLike | null = null;
let peekCardWindow: BrowserWindowLike | null = null;
let orbState = createOrbSurfaceState("orbHidden");
let desktopSnapshot = createDesktopMetricsSnapshot();
```

Create helpers in `main.ts`:

```ts
function showOrbWindow(): void {
  if (orbWindow === null) {
    return;
  }

  orbWindow.show();
  orbState = createOrbSurfaceState("orbDocked");
}

function hideOrbWindow(): void {
  orbWindow?.hide();
  if (orbState.mode !== "detailVisible" && orbState.mode !== "mainVisible") {
    orbState = createOrbSurfaceState("orbHidden");
  }
}
```

- [ ] **Step 4: Register the new IPC handlers**

```ts
ipcMain.handle("desktop:show-orb", async () => {
  showOrbWindow();
});
ipcMain.handle("desktop:hide-orb", async () => {
  hideOrbWindow();
});
ipcMain.handle("desktop:pin-peek-card", async () => {
  orbState = pinPeekCard(orbState);
});
ipcMain.handle("desktop:expand-orb-detail", async () => {
  orbState = expandOrbDetail(orbState);
  if (floatingWindow !== null) {
    floatingWindow.show();
    floatingWindow.focus();
  }
});
```

- [ ] **Step 5: Create Windows-only orb and peek card windows during bootstrap**

```ts
if (process.platform === "win32" && settings.enableOrb) {
  orbWindow = new BrowserWindow({
    width: 56,
    height: 56,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: settings.showOrbOnStartup,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  peekCardWindow = new BrowserWindow({
    width: 320,
    height: 220,
    frame: false,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await orbWindow.loadURL(buildDashboardUrl(runtimePaths.dashboardEntryUrl, "desktop-orb"));
  await peekCardWindow.loadURL(
    buildDashboardUrl(runtimePaths.dashboardEntryUrl, "desktop-orb-peek")
  );
}
```

Keep the orb and card UI Windows-gated even though the types stay cross-platform.

- [ ] **Step 6: Re-run the desktop tests**

Run: `corepack pnpm --filter @agent-metrics/desktop exec vitest run src/runtime-paths.test.ts src/runtime/process-supervisor.test.ts`

Expected: PASS or only known pre-existing failures unrelated to orb wiring. If a test expects old env-path formatting, update the test to match the current behavior before continuing.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main.ts apps/desktop/src/runtime-paths.ts apps/desktop/src/runtime-paths.test.ts
git commit -m "feat: wire orb windows into desktop shell"
```

## Task 5: Add the orb and peek-card renderer surfaces

**Files:**
- Create: `apps/dashboard/src/components/OrbSurface.tsx`
- Create: `apps/dashboard/src/components/OrbSurface.test.tsx`
- Create: `apps/dashboard/src/components/PeekCardDashboard.tsx`
- Create: `apps/dashboard/src/components/PeekCardDashboard.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/styles.css`
- Modify: `apps/dashboard/src/desktop-mode.ts`
- Test: `apps/dashboard/src/components/OrbSurface.test.tsx`
- Test: `apps/dashboard/src/components/PeekCardDashboard.test.tsx`

- [ ] **Step 1: Write the failing orb surface test**

```tsx
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrbSurface } from "./OrbSurface";

describe("OrbSurface", () => {
  it("renders a compact orb affordance and forwards hover and click handlers", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const onClick = vi.fn();

    render(
      <OrbSurface
        collapsed
        stale={false}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
      />
    );

    const button = screen.getByRole("button", { name: "Open desktop peek card" });
    fireEvent.pointerEnter(button);
    fireEvent.pointerLeave(button);
    fireEvent.click(button);

    expect(button).toBeInTheDocument();
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Write the failing peek-card component test**

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PeekCardDashboard } from "./PeekCardDashboard";

describe("PeekCardDashboard", () => {
  it("renders the compact orb metrics without session rows", () => {
    render(
      <PeekCardDashboard
        status="ready"
        metrics={{
          totalTokens: 45678,
          totalToolCalls: 174,
          editOperationCount: 12,
          affectedFileCount: 9,
          insertions: 240,
          deletions: 51,
          successRate: 0.91,
          failedExecutions: 3,
          averageDurationMs: 820
        }}
      />
    );

    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    expect(screen.getByText("45,678")).toBeInTheDocument();
    expect(screen.queryByText("Recent sessions")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the failing tests**

Run: `corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/components/OrbSurface.test.tsx src/components/PeekCardDashboard.test.tsx`

Expected: FAIL because `OrbSurface.tsx` and `PeekCardDashboard.tsx` do not exist yet.

- [ ] **Step 4: Implement the orb surface component**

```tsx
type OrbSurfaceProps = {
  collapsed: boolean;
  stale: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onClick?: () => void;
};

export function OrbSurface({
  collapsed,
  stale,
  onPointerEnter,
  onPointerLeave,
  onClick
}: OrbSurfaceProps) {
  return (
    <main className="orb-surface" data-collapsed={collapsed}>
      <button
        type="button"
        className="orb-surface__button"
        aria-label="Open desktop peek card"
        data-stale={stale}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
      >
        <span className="orb-surface__pulse" />
        <span className="orb-surface__label">AM</span>
      </button>
    </main>
  );
}
```

- [ ] **Step 5: Implement the peek-card dashboard component**

```tsx
type PeekCardDashboardProps = {
  status: "loading" | "ready" | "stale";
  metrics: {
    totalTokens: number;
    totalToolCalls: number;
    editOperationCount: number;
    affectedFileCount: number;
    insertions: number;
    deletions: number;
    successRate: number;
    failedExecutions: number;
    averageDurationMs: number;
  };
  onPin?: () => void;
  onExpand?: () => void;
};

export function PeekCardDashboard({
  status,
  metrics,
  onPin,
  onExpand
}: PeekCardDashboardProps) {
  return (
    <section className="peek-card-dashboard" aria-label="Desktop orb peek card">
      <header className="peek-card-dashboard__header">
        <div>
          <p className="peek-card-dashboard__eyebrow">Desktop Orb</p>
          <h1>Agent Metrics</h1>
        </div>
        <div className="peek-card-dashboard__actions">
          <button type="button" onClick={onPin}>Pin</button>
          <button type="button" onClick={onExpand}>Expand</button>
        </div>
      </header>
      <div className="peek-card-dashboard__grid">
        <article><span>Total Tokens</span><strong>{metrics.totalTokens.toLocaleString()}</strong></article>
        <article><span>Tool Calls</span><strong>{metrics.totalToolCalls.toLocaleString()}</strong></article>
        <article><span>Edits</span><strong>{metrics.editOperationCount.toLocaleString()}</strong></article>
        <article><span>Files</span><strong>{metrics.affectedFileCount.toLocaleString()}</strong></article>
        <article><span>Insertions</span><strong>{metrics.insertions.toLocaleString()}</strong></article>
        <article><span>Deletions</span><strong>{metrics.deletions.toLocaleString()}</strong></article>
        <article><span>Success Rate</span><strong>{Math.round(metrics.successRate * 100)}%</strong></article>
        <article><span>Failures</span><strong>{metrics.failedExecutions.toLocaleString()}</strong></article>
        <article><span>Avg Duration</span><strong>{metrics.averageDurationMs.toLocaleString()} ms</strong></article>
      </div>
      {status === "stale" ? <p className="peek-card-dashboard__stale">Showing stale data</p> : null}
    </section>
  );
}
```

- [ ] **Step 6: Add dedicated desktop orb and peek surface branches in `App.tsx`**

```tsx
const desktopSurface = initialSurface ?? resolveDesktopSurface(window.location.search).surface;
const isOrbSurface = desktopSurface === "desktop-orb";
const isPeekSurface = desktopSurface === "desktop-orb-peek";

if (isOrbSurface) {
  return (
    <OrbSurface
      collapsed={Boolean(desktopApi)}
      stale={Boolean(staleMessage)}
      onPointerEnter={() => void desktopApi?.showOrb()}
      onPointerLeave={() => void desktopApi?.hideOrb()}
      onClick={() => void desktopApi?.pinPeekCard()}
    />
  );
}

if (isPeekSurface) {
  return (
    <PeekCardDashboard
      status={overview === null ? "loading" : staleMessage ? "stale" : "ready"}
      metrics={{
        totalTokens: overview?.totalTokens ?? 0,
        totalToolCalls: overview?.totalToolCalls ?? 0,
        editOperationCount: overview?.editOperationCount ?? 0,
        affectedFileCount: overview?.affectedFileCount ?? 0,
        insertions: overview?.insertions ?? 0,
        deletions: overview?.deletions ?? 0,
        successRate: overview?.successRate ?? 0,
        failedExecutions: overview?.failedExecutions ?? 0,
        averageDurationMs: toolAverageDuration(baseTools.rows)
      }}
      onPin={() => void desktopApi?.pinPeekCard()}
      onExpand={() => void desktopApi?.expandOrbDetail()}
    />
  );
}
```

- [ ] **Step 7: Update desktop surface parsing and styles**

```ts
export type DesktopSurface =
  | "browser"
  | "desktop-main"
  | "desktop-floating"
  | "desktop-orb"
  | "desktop-orb-peek";

if (
  surface === "desktop-main" ||
  surface === "desktop-floating" ||
  surface === "desktop-orb" ||
  surface === "desktop-orb-peek"
) {
  return { isDesktop: true, surface };
}
```

Add compact styles to `apps/dashboard/src/styles.css` for `.orb-surface`, `.orb-surface__button`, and `.peek-card-dashboard` so the orb looks intentional and the card fits inside a small window without sessions or charts.

- [ ] **Step 8: Re-run the new dashboard tests**

Run: `corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/components/OrbSurface.test.tsx src/components/PeekCardDashboard.test.tsx`

Expected: PASS with the orb affordance and compact metric-only card rendering.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/components/OrbSurface.tsx apps/dashboard/src/components/OrbSurface.test.tsx apps/dashboard/src/components/PeekCardDashboard.tsx apps/dashboard/src/components/PeekCardDashboard.test.tsx apps/dashboard/src/App.tsx apps/dashboard/src/main.tsx apps/dashboard/src/styles.css apps/dashboard/src/desktop-mode.ts
git commit -m "feat: add desktop orb renderer surfaces"
```

## Task 6: Wire orb interactions, stale refresh handling, and documentation

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/dashboard/src/api.ts`
- Modify: `apps/dashboard/src/api.test.ts`
- Modify: `README.md`
- Test: `apps/dashboard/src/api.test.ts`

- [ ] **Step 1: Write the failing API test for orb-card desktop refresh**

```ts
it("resolves the desktop apiBase when orb peek mode is active", () => {
  const desktopWindow = {
    location: {
      search: "?surface=desktop-orb-peek&apiBase=http%3A%2F%2F127.0.0.1%3A45183"
    }
  } as Window;

  expect(resolveApiPath("/api/overview", desktopWindow)).toBe(
    "http://127.0.0.1:45183/api/overview"
  );
});
```

- [ ] **Step 2: Run the failing API test if the surface is not yet supported**

Run: `corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/api.test.ts`

Expected: FAIL if `desktop-orb-peek` routing or new actions introduced a regression.

- [ ] **Step 3: Add main-process hover, pin, and stale snapshot behavior**

In `apps/desktop/src/main.ts`, add timers and state updates like:

```ts
let hoverOpenTimer: NodeJS.Timeout | null = null;
let hoverCloseTimer: NodeJS.Timeout | null = null;

function schedulePeekCardOpen(): void {
  if (peekCardWindow === null || orbWindow === null) {
    return;
  }

  clearTimeout(hoverCloseTimer ?? undefined);
  hoverOpenTimer = setTimeout(() => {
    orbState = hoverOrb(orbState);
    peekCardWindow?.show();
    peekCardWindow?.focus();
  }, 150);
}

function schedulePeekCardClose(): void {
  if (orbState.mode === "peekPinned") {
    return;
  }

  clearTimeout(hoverOpenTimer ?? undefined);
  hoverCloseTimer = setTimeout(() => {
    orbState = leaveOrbRegion(orbState);
    peekCardWindow?.hide();
  }, 320);
}
```

Use the shared snapshot to keep showing the last successful metrics if refresh fails, and mark the snapshot stale instead of clearing it.

- [ ] **Step 4: Preserve the existing API base-path behavior and README guidance**

Keep `resolveApiPath` compatible with both `desktop-main` and `desktop-orb-peek`, then add a README section like:

```md
### Windows desktop orb

The packaged desktop app can expose a tray-backed orb on Windows. The orb can dock to the left or right edge, partially hide, and reveal a lightweight metrics card on hover. Use the tray menu to reopen the orb or reset its position if it moves off-screen.
```

- [ ] **Step 5: Re-run the dashboard API test**

Run: `corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/api.test.ts`

Expected: PASS with no regression to `desktop-main`, `desktop-floating`, or `desktop-orb-peek` API routing.

- [ ] **Step 6: Run the focused desktop and dashboard verification suite**

Run:

```bash
corepack pnpm --filter @agent-metrics/desktop exec vitest run src/window-state.test.ts src/orb-state.test.ts src/orb-snapshot.test.ts src/runtime-paths.test.ts
corepack pnpm --filter @agent-metrics/dashboard exec vitest run src/api.test.ts src/components/PeekCardDashboard.test.tsx
```

Expected:

- all new orb-focused tests pass
- no new failures appear in the focused desktop and dashboard suites

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main.ts apps/dashboard/src/api.ts apps/dashboard/src/api.test.ts README.md
git commit -m "feat: complete desktop orb interactions"
```

## Spec Coverage Check

- Same packaged desktop app: covered by Tasks 3 through 6.
- Windows-first orb and peek card: covered by Tasks 4 through 6.
- Tray plus orb plus detail window coordination: covered by Tasks 3, 4, and 6.
- Orb persistence and docking settings: covered by Task 1.
- Hover, pin, expand state machine: covered by Tasks 2 and 6.
- Compact metric-only card: covered by Task 5.
- Shared refresh cadence and stale handling: covered by Tasks 2 and 6.
- macOS contract preservation without orb UI: covered by Task 4 via platform gating and Task 6 via compatibility checks.

## Self-Review Notes

- No `TODO`, `TBD`, or placeholder steps remain.
- All newly introduced bridge methods are reflected in both `preload.ts` and `desktop-mode.ts`.
- The plan keeps the orb card metrics limited to the approved data set and does not add session rows or charts.
- The plan only introduces Windows orb UI while keeping the cross-platform controller and settings schema aligned with the spec.
