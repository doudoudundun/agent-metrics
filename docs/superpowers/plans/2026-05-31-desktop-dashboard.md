# Agent Metrics Desktop Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows and macOS desktop edition of Agent Metrics that preserves the current collection and browser dashboard stack while introducing tray residency, a floating always-on-top window, persisted settings, and packaged builds.

**Architecture:** Add a new `apps/desktop` Electron supervisor that starts and owns the existing `apps/cli` watcher/parser and `apps/core` API processes. Keep `apps/dashboard` as the only dashboard renderer, and extend it with desktop-aware compact mode and a small preload bridge so the browser workflow stays intact while Electron can host both the full dashboard and the floating view.

**Tech Stack:** TypeScript, Electron, electron-builder, React, Vite, Vitest, Fastify, existing workspace packages

---

## File Map

### Desktop workspace app

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/settings.ts`
- Create: `apps/desktop/src/runtime/process-supervisor.ts`
- Create: `apps/desktop/src/runtime/process-supervisor.test.ts`
- Create: `apps/desktop/src/window-state.ts`
- Create: `apps/desktop/src/window-state.test.ts`
- Create: `apps/desktop/src/tray.ts`

Responsibility:

- own the Electron app lifecycle
- manage tray, windows, settings, launch-at-login, and child-process supervision
- expose a minimal preload bridge to the dashboard renderer

### Dashboard desktop adaptations

- Create: `apps/dashboard/src/desktop-mode.ts`
- Create: `apps/dashboard/src/components/FloatingDashboard.tsx`
- Create: `apps/dashboard/src/components/FloatingDashboard.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/styles.css`

Responsibility:

- allow the same dashboard app to run in browser mode, full desktop mode, and compact floating mode
- show runtime status and desktop controls only when the preload bridge exists
- keep the default browser path unchanged

### Workspace integration

- Modify: `package.json`
- Modify: `README.md`

Responsibility:

- add desktop dev, build, test, and packaging scripts
- document the new desktop workflow without replacing the current browser workflow

## Task 1: Scaffold the desktop workspace app and root scripts

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Modify: `package.json`
- Test: `apps/desktop/package.json`

- [ ] **Step 1: Add a failing workspace script check**

Run: `corepack pnpm --filter @agent-metrics/desktop test`

Expected: FAIL with `No projects matched the filters` because the desktop app does not exist yet.

- [ ] **Step 2: Create the desktop package manifest**

```json
{
  "name": "@agent-metrics/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "pnpm build && electron dist/main.js",
    "test": "vitest run src",
    "package:mac": "electron-builder --mac dir",
    "package:win": "electron-builder --win dir"
  },
  "dependencies": {
    "electron": "^33.2.1",
    "electron-builder": "^25.1.8"
  }
}
```

- [ ] **Step 3: Create the desktop TypeScript config**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Wire the desktop scripts into the root workspace**

```json
{
  "scripts": {
    "build": "corepack pnpm -r build",
    "dev": "corepack pnpm --parallel --filter @agent-metrics/core --filter @agent-metrics/dashboard dev",
    "dev:desktop": "corepack pnpm --parallel --filter @agent-metrics/core --filter @agent-metrics/dashboard --filter @agent-metrics/desktop dev",
    "lint": "corepack pnpm -r exec tsc --noEmit",
    "test": "corepack pnpm -r test",
    "test:desktop": "corepack pnpm --filter @agent-metrics/desktop test",
    "package:desktop:mac": "corepack pnpm --filter @agent-metrics/desktop package:mac",
    "package:desktop:win": "corepack pnpm --filter @agent-metrics/desktop package:win"
  }
}
```

- [ ] **Step 5: Run the workspace script check again**

Run: `corepack pnpm --filter @agent-metrics/desktop test`

Expected: FAIL with `No test files found` or a TypeScript entry error, which proves the workspace now resolves the desktop app.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/tsconfig.json
git commit -m "chore: scaffold desktop workspace app"
```

## Task 2: Add persisted desktop settings and window-state helpers

**Files:**
- Create: `apps/desktop/src/settings.ts`
- Create: `apps/desktop/src/window-state.ts`
- Create: `apps/desktop/src/window-state.test.ts`
- Test: `apps/desktop/src/window-state.test.ts`

- [ ] **Step 1: Write the failing window-state test**

```ts
import { describe, expect, it } from "vitest";
import { clampBoundsToDisplay, defaultDesktopSettings } from "./window-state";

describe("window state", () => {
  it("clamps an off-screen floating window back into the visible display", () => {
    expect(
      clampBoundsToDisplay(
        { x: -1800, y: -900, width: 420, height: 260 },
        { x: 0, y: 0, width: 1440, height: 900 }
      )
    ).toEqual({ x: 0, y: 0, width: 420, height: 260 });
  });

  it("returns hide-to-tray as the default close behavior", () => {
    expect(defaultDesktopSettings().closeBehavior).toBe("hide-to-tray");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `corepack pnpm --filter @agent-metrics/desktop test -- window-state`

Expected: FAIL with `Cannot find module './window-state'`.

- [ ] **Step 3: Implement the settings and bounds helpers**

```ts
export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopSettings = {
  closeBehavior: "hide-to-tray" | "quit-app";
  launchAtLogin: boolean;
  showMainWindowOnStartup: boolean;
  reopenFloatingWindowOnStartup: boolean;
  preferredSurface: "main-window" | "floating-window";
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
    mainWindowBounds: null,
    floatingWindowBounds: { x: 80, y: 80, width: 440, height: 320 }
  };
}

export function clampBoundsToDisplay(bounds: WindowBounds, display: WindowBounds): WindowBounds {
  return {
    x: Math.max(display.x, Math.min(bounds.x, display.x + display.width - bounds.width)),
    y: Math.max(display.y, Math.min(bounds.y, display.y + display.height - bounds.height)),
    width: Math.min(bounds.width, display.width),
    height: Math.min(bounds.height, display.height)
  };
}
```

- [ ] **Step 4: Add a JSON-backed settings store**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultDesktopSettings, type DesktopSettings } from "./window-state";

export async function loadDesktopSettings(filePath: string): Promise<DesktopSettings> {
  try {
    const raw = await readFile(filePath, "utf8");
    return { ...defaultDesktopSettings(), ...(JSON.parse(raw) as Partial<DesktopSettings>) };
  } catch {
    return defaultDesktopSettings();
  }
}

export async function saveDesktopSettings(
  filePath: string,
  settings: DesktopSettings
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(settings, null, 2));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `corepack pnpm --filter @agent-metrics/desktop test -- window-state`

Expected: PASS with 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/settings.ts apps/desktop/src/window-state.ts apps/desktop/src/window-state.test.ts
git commit -m "feat: add desktop settings and window state helpers"
```

## Task 3: Add a process supervisor for the existing runtime chain

**Files:**
- Create: `apps/desktop/src/runtime/process-supervisor.ts`
- Create: `apps/desktop/src/runtime/process-supervisor.test.ts`
- Test: `apps/desktop/src/runtime/process-supervisor.test.ts`

- [ ] **Step 1: Write the failing supervisor test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createProcessSupervisor } from "./process-supervisor";

describe("process supervisor", () => {
  it("starts watcher, parser, and core with repo-root arguments", async () => {
    const spawn = vi.fn(() => ({
      once: vi.fn(),
      on: vi.fn(),
      kill: vi.fn()
    }));

    const supervisor = createProcessSupervisor({
      repoRoot: "/repo",
      spawn
    });

    await supervisor.start();

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["hooks", "watch"]));
    expect(spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["hooks", "parse", "--follow"]));
    expect(spawn.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["dist/server.js"]));
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `corepack pnpm --filter @agent-metrics/desktop test -- process-supervisor`

Expected: FAIL with `Cannot find module './process-supervisor'`.

- [ ] **Step 3: Implement the supervisor with explicit child ownership**

```ts
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

type SpawnFn = typeof nodeSpawn;

export function createProcessSupervisor({
  repoRoot,
  spawn = nodeSpawn
}: {
  repoRoot: string;
  spawn?: SpawnFn;
}) {
  const children: ChildProcess[] = [];
  let status: "idle" | "running" | "stopped" = "idle";

  function startChild(command: string, args: string[], cwd: string): ChildProcess {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "pipe"
    });
    children.push(child);
    return child;
  }

  return {
    async start() {
      status = "running";
      startChild("node", [join(repoRoot, "apps/cli/dist/index.js"), "hooks", "watch", "--scope", "global", "--repo-root", repoRoot], join(repoRoot, "apps/cli"));
      startChild("node", [join(repoRoot, "apps/cli/dist/index.js"), "hooks", "parse", "--follow", "--repo-root", repoRoot], join(repoRoot, "apps/cli"));
      startChild("node", [join(repoRoot, "apps/core/dist/server.js")], join(repoRoot, "apps/core"));
    },
    getStatus() {
      return status;
    },
    async stop() {
      for (const child of children.splice(0)) {
        child.kill();
      }
      status = "stopped";
    }
  };
}
```

- [ ] **Step 4: Expand the test to cover shutdown**

```ts
it("kills only the children it started when the app shuts down", async () => {
  const firstChild = {
    once: vi.fn(),
    on: vi.fn(),
    kill: vi.fn()
  };
  const secondChild = {
    once: vi.fn(),
    on: vi.fn(),
    kill: vi.fn()
  };
  const thirdChild = {
    once: vi.fn(),
    on: vi.fn(),
    kill: vi.fn()
  };
  const spawn = vi.fn()
    .mockReturnValueOnce(firstChild)
    .mockReturnValueOnce(secondChild)
    .mockReturnValueOnce(thirdChild);

  const supervisor = createProcessSupervisor({
    repoRoot: "/repo",
    spawn
  });

  await supervisor.start();
  await supervisor.stop();

  expect(spawn).toHaveBeenCalledTimes(3);
  expect(firstChild.kill).toHaveBeenCalledTimes(1);
  expect(secondChild.kill).toHaveBeenCalledTimes(1);
  expect(thirdChild.kill).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 5: Run the tests**

Run: `corepack pnpm --filter @agent-metrics/desktop test -- process-supervisor`

Expected: PASS with supervisor start and stop coverage.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/runtime/process-supervisor.ts apps/desktop/src/runtime/process-supervisor.test.ts
git commit -m "feat: add desktop runtime process supervisor"
```

## Task 4: Build the Electron shell, preload bridge, windows, and tray

**Files:**
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/tray.ts`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/src/window-state.test.ts`

- [ ] **Step 1: Add the Electron entry points to the package manifest**

```json
{
  "main": "dist/main.js",
  "build": {
    "appId": "dev.agentmetrics.desktop",
    "files": [
      "dist/**/*",
      "../../apps/dashboard/dist/**/*",
      "../../apps/core/dist/**/*",
      "../../apps/cli/dist/**/*"
    ],
    "directories": {
      "output": "release"
    }
  }
}
```

- [ ] **Step 2: Implement the preload bridge**

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentMetricsDesktop", {
  getRuntimeStatus: () => ipcRenderer.invoke("desktop:get-runtime-status"),
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  updateSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke("desktop:update-settings", patch),
  showMainWindow: () => ipcRenderer.invoke("desktop:show-main-window"),
  toggleFloatingWindow: () => ipcRenderer.invoke("desktop:toggle-floating-window")
});
```

- [ ] **Step 3: Implement the tray factory**

```ts
import { Menu, Tray } from "electron";

export function createDesktopTray({
  iconPath,
  showMainWindow,
  toggleFloatingWindow,
  openSettings,
  quitApp
}: {
  iconPath: string;
  showMainWindow: () => void;
  toggleFloatingWindow: () => void;
  openSettings: () => void;
  quitApp: () => void;
}) {
  const tray = new Tray(iconPath);
  tray.setToolTip("Agent Metrics");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dashboard", click: showMainWindow },
      { label: "Show or Hide Floating Window", click: toggleFloatingWindow },
      { label: "Open Settings", click: openSettings },
      { type: "separator" },
      { label: "Quit", click: quitApp }
    ])
  );
  return tray;
}
```

- [ ] **Step 4: Implement the Electron main process**

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { createProcessSupervisor } from "./runtime/process-supervisor";
import { loadDesktopSettings, saveDesktopSettings } from "./settings";
import { createDesktopTray } from "./tray";

let mainWindow: BrowserWindow | null = null;
let floatingWindow: BrowserWindow | null = null;
let quitting = false;

async function bootstrap() {
  const repoRoot = join(import.meta.dirname, "../../..");
  const settingsPath = join(app.getPath("userData"), "desktop-settings.json");
  let settings = await loadDesktopSettings(settingsPath);
  const supervisor = createProcessSupervisor({ repoRoot });

  await supervisor.start();
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });

  mainWindow = new BrowserWindow({
    width: settings.mainWindowBounds?.width ?? 1360,
    height: settings.mainWindowBounds?.height ?? 900,
    show: settings.showMainWindowOnStartup,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true
    }
  });

  floatingWindow = new BrowserWindow({
    width: settings.floatingWindowBounds?.width ?? 440,
    height: settings.floatingWindowBounds?.height ?? 320,
    show: settings.reopenFloatingWindowOnStartup,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true
    }
  });

  const dashboardBaseUrl = app.isPackaged
    ? `file://${join(repoRoot, "apps/dashboard/dist/index.html")}`
    : "http://127.0.0.1:4173";

  await mainWindow.loadURL(`${dashboardBaseUrl}?surface=desktop-main`);
  await floatingWindow.loadURL(`${dashboardBaseUrl}?surface=desktop-floating`);

  ipcMain.handle("desktop:get-runtime-status", () => ({
    status: supervisor.getStatus()
  }));
  ipcMain.handle("desktop:get-settings", () => settings);
  ipcMain.handle("desktop:update-settings", async (_event, patch) => {
    settings = { ...settings, ...patch };
    await saveDesktopSettings(settingsPath, settings);
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    return settings;
  });

  mainWindow.on("close", (event) => {
    if (settings.closeBehavior === "hide-to-tray" && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  createDesktopTray({
    iconPath: join(import.meta.dirname, "../assets/trayTemplate.png"),
    showMainWindow: () => mainWindow?.show(),
    toggleFloatingWindow: () => (floatingWindow?.isVisible() ? floatingWindow.hide() : floatingWindow?.show()),
    openSettings: () => mainWindow?.show(),
    quitApp: () => app.quit()
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.whenReady().then(bootstrap);
```

- [ ] **Step 5: Run the desktop tests and typecheck**

Run: `corepack pnpm --filter @agent-metrics/desktop test && corepack pnpm --filter @agent-metrics/desktop build`

Expected: PASS for tests and a generated `apps/desktop/dist` folder.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/tray.ts
git commit -m "feat: add desktop electron shell and tray"
```

## Task 5: Teach the dashboard app to run in desktop and floating modes

**Files:**
- Create: `apps/dashboard/src/desktop-mode.ts`
- Create: `apps/dashboard/src/components/FloatingDashboard.tsx`
- Create: `apps/dashboard/src/components/FloatingDashboard.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/App.test.tsx`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/styles.css`
- Test: `apps/dashboard/src/components/FloatingDashboard.test.tsx`
- Test: `apps/dashboard/src/App.test.tsx`

- [ ] **Step 1: Add a failing desktop-mode test**

```ts
import { describe, expect, it } from "vitest";
import { resolveDesktopSurface } from "../desktop-mode";

describe("resolveDesktopSurface", () => {
  it("maps the surface query parameter into floating mode", () => {
    expect(resolveDesktopSurface("?surface=desktop-floating")).toEqual({
      isDesktop: true,
      surface: "desktop-floating"
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `corepack pnpm --filter @agent-metrics/dashboard test -- FloatingDashboard`

Expected: FAIL with `Cannot find module '../desktop-mode'` or missing floating dashboard component.

- [ ] **Step 3: Implement desktop surface detection**

```ts
export type DesktopSurface = "browser" | "desktop-main" | "desktop-floating";

export function resolveDesktopSurface(search: string): {
  isDesktop: boolean;
  surface: DesktopSurface;
} {
  const params = new URLSearchParams(search);
  const surface = params.get("surface");

  if (surface === "desktop-main" || surface === "desktop-floating") {
    return { isDesktop: true, surface };
  }

  return { isDesktop: false, surface: "browser" };
}
```

- [ ] **Step 4: Add the compact floating component**

```tsx
import type { OverviewResponse, SessionRow } from "../api";

export function FloatingDashboard({
  overview,
  sessions
}: {
  overview: OverviewResponse | null;
  sessions: SessionRow[];
}) {
  return (
    <section className="floating-dashboard">
      <header className="floating-dashboard__header">
        <h1>Agent Metrics</h1>
        <p>Always-on-top summary</p>
      </header>
      <div className="floating-dashboard__kpis">
        <article><span>Sessions</span><strong>{overview?.sessionCount ?? 0}</strong></article>
        <article><span>Turns</span><strong>{overview?.turnCount ?? 0}</strong></article>
        <article><span>Tokens</span><strong>{overview?.totalTokens ?? 0}</strong></article>
      </div>
      <ul className="floating-dashboard__sessions">
        {sessions.slice(0, 5).map((session) => (
          <li key={session.sessionId}>{session.workspacePath}</li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Switch `App.tsx` between browser/full/floating layouts**

```tsx
const desktopSurface = resolveDesktopSurface(window.location.search);

if (desktopSurface.surface === "desktop-floating") {
  return (
    <FloatingDashboard
      overview={overview}
      sessions={baseSessions.rows ?? []}
    />
  );
}
```

Also add a desktop-only action strip guarded by the preload bridge:

```tsx
const desktopApi = (window as Window & {
  agentMetricsDesktop?: {
    getRuntimeStatus(): Promise<{ status: string }>;
    toggleFloatingWindow(): Promise<void>;
  };
}).agentMetricsDesktop;

{desktopApi ? (
  <div className="desktop-actions">
    <button type="button" onClick={() => void desktopApi.toggleFloatingWindow()}>
      Toggle Floating Window
    </button>
    <span className="desktop-runtime-status">Runtime: connected</span>
  </div>
) : null}
```

- [ ] **Step 6: Add the compact-mode tests and run the dashboard suite**

Run: `corepack pnpm --filter @agent-metrics/dashboard test -- FloatingDashboard`

Expected: PASS for the floating component tests.

Run: `corepack pnpm --filter @agent-metrics/dashboard test -- App`

Expected: PASS for existing dashboard behavior plus a new desktop floating-mode assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/desktop-mode.ts apps/dashboard/src/components/FloatingDashboard.tsx apps/dashboard/src/components/FloatingDashboard.test.tsx apps/dashboard/src/App.tsx apps/dashboard/src/App.test.tsx apps/dashboard/src/main.tsx apps/dashboard/src/styles.css
git commit -m "feat: add desktop and floating dashboard modes"
```

## Task 6: Finish packaging, docs, and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `apps/desktop/package.json`
- Test: `README.md`

- [ ] **Step 1: Add package targets for macOS and Windows output**

```json
{
  "build": {
    "mac": {
      "target": ["dir"]
    },
    "win": {
      "target": ["dir"]
    }
  }
}
```

- [ ] **Step 2: Document the desktop workflow in the README**

```md
## Desktop App

- Start desktop development: `corepack pnpm dev:desktop`
- Package a macOS app bundle: `corepack pnpm package:desktop:mac`
- Package a Windows desktop build: `corepack pnpm package:desktop:win`

The desktop app preserves the existing local telemetry pipeline. The browser dashboard still works and remains the default fallback for debugging.
```

- [ ] **Step 3: Run the workspace verification commands**

Run: `corepack pnpm test`

Expected: PASS for the full workspace test suite, including the new desktop and dashboard tests.

Run: `corepack pnpm build`

Expected: PASS for the workspace build, including `apps/desktop/dist`, `apps/core/dist`, `apps/cli/dist`, and `apps/dashboard/dist`.

Run: `corepack pnpm package:desktop:mac`

Expected: PASS with a generated app directory under `apps/desktop/release`.

Run: `corepack pnpm package:desktop:win`

Expected: PASS with a generated Windows output directory under `apps/desktop/release`.

- [ ] **Step 4: Perform manual smoke tests on macOS and Windows**

Run:

```bash
corepack pnpm dev:desktop
```

Verify:

- the main dashboard window opens
- the tray or menu bar item appears
- the floating window can be shown, hidden, dragged, and remains always on top
- closing the main window hides to tray by default
- changing the close behavior to quit causes the next close to exit the app
- the browser dashboard still works independently at `http://127.0.0.1:4173`
- new telemetry still appears in both the full dashboard and the floating summary

- [ ] **Step 5: Commit**

```bash
git add README.md apps/desktop/package.json
git commit -m "docs: add desktop packaging and verification workflow"
```
