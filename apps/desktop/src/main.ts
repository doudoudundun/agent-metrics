import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOrbSurfaceState,
  dismissPeekCard,
  expandOrbDetail,
  hoverOrb,
  leaveOrbRegion,
  togglePeekCardPin
} from "./orb-state.js";
import {
  createDesktopMetricsSnapshot,
  type DesktopMetricsSnapshot
} from "./orb-snapshot.js";
import { migrateLegacyDataRoots } from "./data-root-migration.js";
import {
  resolveDefaultOrbBounds,
  resolveOrbDockEdge,
  resolveOrbDockPlacement,
  resolveOrbDragBounds,
  resolveOrbWindowPlacement,
  resolvePeekCardBounds
} from "./orb-layout.js";
import { resolveDesktopNodeExecutable } from "./runtime/node-executable.js";
import { createProcessSupervisor } from "./runtime/process-supervisor.js";
import {
  buildDashboardUrl,
  type DesktopDashboardSurface,
  resolveDesktopRuntimePaths
} from "./runtime-paths.js";
import { loadDesktopSettings, saveDesktopSettings } from "./settings.js";
import { createDesktopTray } from "./tray.js";
import {
  clampBoundsToDisplay,
  sanitizeDesktopSettings,
  type DesktopSettings,
  type WindowBounds
} from "./window-state.js";

const DEFAULT_MAIN_WINDOW_BOUNDS = {
  width: 1360,
  height: 900
} as const;
const ORB_WINDOW_SIZE = 104;
const DASHBOARD_DEV_SERVER_TIMEOUT_MS = 15_000;
const PEEK_CARD_SIZE = {
  width: 376,
  height: 304
} as const;

type RectangleLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PreventableEvent = {
  preventDefault(): void;
};

type BrowserWindowLike = {
  focus(): void;
  getNormalBounds(): RectangleLike;
  hide(): void;
  isMinimized(): boolean;
  isVisible(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: "close" | "move" | "resize" | "closed", listener: (event: PreventableEvent) => void): void;
  restore(): void;
  setBounds(bounds: RectangleLike): void;
  setFocusable(focusable: boolean): void;
  show(): void;
  isAlwaysOnTop(): boolean;
  setAlwaysOnTop(flag: boolean, level?: string): void;
};

type BrowserWindowConstructor = new (options: Record<string, unknown>) => BrowserWindowLike;

type OrbMenuItem =
  | { type: "separator" }
  | { label: string; click: () => void };

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron") as {
  app: {
    getPath(name: string): string;
    isPackaged: boolean;
    on(
      event: "activate" | "before-quit",
      listener: (event: PreventableEvent) => void
    ): void;
    on(event: "second-instance", listener: () => void): void;
    quit(): void;
    requestSingleInstanceLock(): boolean;
    setLoginItemSettings(settings: { openAtLogin: boolean }): void;
    whenReady(): Promise<void>;
  };
  BrowserWindow: BrowserWindowConstructor;
  ipcMain: {
    handle(
      channel: string,
      listener: (...args: unknown[]) => unknown
    ): void;
  };
  Menu: {
    buildFromTemplate: (items: OrbMenuItem[]) => {
      popup: (options?: { window?: BrowserWindowLike }) => void;
    };
  };
  screen: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): {
      bounds: RectangleLike;
      workArea: RectangleLike;
    };
    getPrimaryDisplay(): {
      bounds: RectangleLike;
      workArea: RectangleLike;
    };
  };
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, "preload.cjs");
const runtimePaths = resolveDesktopRuntimePaths({
  currentDir,
  isPackaged: app.isPackaged,
  userDataPath: app.getPath("userData"),
  appDataPath: app.getPath("appData"),
  dataRootEnv: process.env.AGENT_METRICS_DATA_ROOT
});
const desktopNodeExecutable = resolveDesktopNodeExecutable({
  cliWorkingDirectory: runtimePaths.cliWorkingDirectory,
  coreWorkingDirectory: runtimePaths.coreWorkingDirectory,
  currentExecutablePath: globalThis.process.execPath
});

let mainWindow: BrowserWindowLike | null = null;
let floatingWindow: BrowserWindowLike | null = null;
let orbWindow: BrowserWindowLike | null = null;
let peekCardWindow: BrowserWindowLike | null = null;
let tray: { destroy(): void } | null = null;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
let settingsPath = "";
let settings: DesktopSettings;
let settingsSaveQueue = Promise.resolve();
let orbState = createOrbSurfaceState("orbHidden");
let desktopSnapshot = createDesktopMetricsSnapshot();
let hoverOpenTimer: NodeJS.Timeout | null = null;
let hoverCloseTimer: NodeJS.Timeout | null = null;
let orbDragPointerOffset: { x: number; y: number } | null = null;
let orbDragTimer: NodeJS.Timeout | null = null;
let orbBoundsPersistTimer: NodeJS.Timeout | null = null;
let orbTopmostTimer: NodeJS.Timeout | null = null;
let dashboardDevProcess: ChildProcess | null = null;

const supervisor = createProcessSupervisor({
  runtimePaths,
  nodeExecutablePath: desktopNodeExecutable,
  isExternalRuntimeHealthy: isCoreApiHealthy
});

function toWindowBounds(bounds: RectangleLike): WindowBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function getDashboardUrl(
  surface: DesktopDashboardSurface,
  extraParams?: Record<string, string>
): string {
  const baseUrl = runtimePaths.packagedDashboardEntryUrl ?? runtimePaths.dashboardEntryUrl;
  const apiBaseUrl = runtimePaths.packagedDashboardEntryUrl
    ? runtimePaths.coreApiBaseUrl
    : undefined;
  return buildDashboardUrl(baseUrl, surface, apiBaseUrl, extraParams);
}

function getOrbUrlParams(dockEdge: DesktopSettings["orbDockEdge"]): Record<string, string> | undefined {
  return dockEdge === null ? undefined : { dockEdge };
}

async function isCoreApiHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);

  try {
    const response = await fetch(`${runtimePaths.coreApiBaseUrl}/api/overview`, {
      signal: controller.signal
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as unknown;
    return isOverviewPayload(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function isDashboardUiHealthy(): Promise<boolean> {
  if (runtimePaths.dashboardWorkingDirectory === null) {
    return true;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);

  try {
    const response = await fetch("http://127.0.0.1:4173/", {
      signal: controller.signal
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDashboardUiHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isDashboardUiHealthy()) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 250);
    });
  }

  throw new Error("Dashboard dev server did not become healthy in time.");
}

async function ensureDashboardDevServer(): Promise<void> {
  if (
    app.isPackaged ||
    runtimePaths.dashboardDevEntrypoint === null ||
    runtimePaths.dashboardWorkingDirectory === null
  ) {
    return;
  }

  if (await isDashboardUiHealthy()) {
    return;
  }

  if (dashboardDevProcess === null) {
    const useElectronAsNode = desktopNodeExecutable === undefined;
    dashboardDevProcess = spawn(
      desktopNodeExecutable ?? globalThis.process.execPath,
      [runtimePaths.dashboardDevEntrypoint, "--host", "127.0.0.1", "--port", "4173"],
      {
        cwd: runtimePaths.dashboardWorkingDirectory,
        env: {
          ...process.env,
          ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {})
        },
        stdio: "ignore"
      }
    );

    dashboardDevProcess.on("exit", () => {
      dashboardDevProcess = null;
    });
    dashboardDevProcess.on("error", () => {
      dashboardDevProcess = null;
    });
  }

  await waitForDashboardUiHealthy(DASHBOARD_DEV_SERVER_TIMEOUT_MS);
}

function isOverviewPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sessionCount === "number" &&
    typeof value.turnCount === "number" &&
    typeof value.totalTokens === "number" &&
    Array.isArray(value.tokensByModel)
  );
}

function clampToVisibleDisplay(bounds: WindowBounds): WindowBounds {
  const visibleDisplay = screen.getPrimaryDisplay().workArea;

  return clampBoundsToDisplay(bounds, toWindowBounds(visibleDisplay));
}

function getMainWindowOptions(savedBounds: WindowBounds | null) {
  if (savedBounds === null) {
    return DEFAULT_MAIN_WINDOW_BOUNDS;
  }

  return clampToVisibleDisplay(savedBounds);
}

function getFloatingWindowOptions(savedBounds: WindowBounds | null) {
  if (savedBounds === null) {
    return { x: 80, y: 80, width: 440, height: 320 };
  }

  return clampToVisibleDisplay(savedBounds);
}

function getOrbWindowOptions(
  savedBounds: WindowBounds | null,
  dockEdge: DesktopSettings["orbDockEdge"]
): WindowBounds {
  return getOrbWindowPlacement(savedBounds, dockEdge).bounds;
}

function getOrbWindowPlacement(
  savedBounds: WindowBounds | null,
  dockEdge: DesktopSettings["orbDockEdge"]
): { bounds: WindowBounds; dockEdge: DesktopSettings["orbDockEdge"] } {
  return resolveOrbWindowPlacement({
    savedBounds,
    workArea: toWindowBounds(screen.getPrimaryDisplay().workArea),
    dockEdge,
    orbSize: { width: ORB_WINDOW_SIZE, height: ORB_WINDOW_SIZE }
  });
}


function queueSettingsSave(nextSettings: DesktopSettings): Promise<void> {
  settingsSaveQueue = settingsSaveQueue.then(() => saveDesktopSettings(settingsPath, nextSettings));
  return settingsSaveQueue;
}

async function updateSettings(patch: Record<string, unknown>): Promise<DesktopSettings> {
  settings = sanitizeDesktopSettings({
    ...settings,
    ...patch
  });

  await queueSettingsSave(settings);
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });

  return settings;
}

function showMainWindow(): void {
  if (mainWindow === null) {
    return;
  }

  orbState = createOrbSurfaceState("mainVisible");
  clearHoverTimers();
  peekCardWindow?.hide();

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function showOrbWindow(): void {
  if (orbWindow === null) {
    return;
  }

  clearHoverTimers();
  peekCardWindow?.hide();
  orbWindow.show();
  startOrbTopmostGuard();
  orbState = createOrbSurfaceState("orbDocked");
}

function hideOrbWindow(): void {
  stopOrbTopmostGuard();
  clearHoverTimers();
  orbWindow?.hide();
  peekCardWindow?.hide();

  if (orbState.mode !== "detailVisible" && orbState.mode !== "mainVisible") {
    orbState = createOrbSurfaceState("orbHidden");
  }
}

function resetOrbWindowPosition(): void {
  if (orbWindow === null) {
    return;
  }

  const nextBounds = resolveDefaultOrbBounds({
    workArea: toWindowBounds(screen.getPrimaryDisplay().workArea),
    dockEdge: settings.orbDockEdge,
    orbSize: { width: ORB_WINDOW_SIZE, height: ORB_WINDOW_SIZE }
  });

  moveOrbWindow(nextBounds);
  queueOrbBoundsSave(nextBounds);
}

function showOrbContextMenu(): void {
  if (orbWindow === null) {
    return;
  }

  const menuItems: OrbMenuItem[] = [
    { label: "打开仪表盘", click: () => showMainWindow() },
    {
      label: "展开详情面板",
      click: () => {
        clearHoverTimers();
        orbState = createOrbSurfaceState("detailVisible");
        peekCardWindow?.hide();

        if (floatingWindow !== null) {
          floatingWindow.show();
          floatingWindow.focus();
        }
      }
    },
    { type: "separator" },
    { label: "重置悬浮球位置", click: () => resetOrbWindowPosition() },
    { label: "隐藏悬浮球", click: () => hideOrbWindow() },
    { type: "separator" },
    {
      label: "退出 Agent Metrics",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ];

  Menu.buildFromTemplate(menuItems).popup({ window: orbWindow });
}

function clearHoverTimers(): void {
  clearTimeout(hoverOpenTimer ?? undefined);
  clearTimeout(hoverCloseTimer ?? undefined);
  hoverOpenTimer = null;
  hoverCloseTimer = null;
}

function clearOrbBoundsPersistTimer(): void {
  clearTimeout(orbBoundsPersistTimer ?? undefined);
  orbBoundsPersistTimer = null;
}

function startOrbTopmostGuard(): void {
  stopOrbTopmostGuard();
  orbTopmostTimer = setInterval(() => {
    if (orbWindow === null || orbDragPointerOffset !== null || !orbWindow.isVisible()) {
      return;
    }

    if (!orbWindow.isAlwaysOnTop()) {
      orbWindow.setAlwaysOnTop(true, "floating");
    }
  }, 2000);
}

function stopOrbTopmostGuard(): void {
  if (orbTopmostTimer !== null) {
    clearInterval(orbTopmostTimer);
    orbTopmostTimer = null;
  }
}

function stopOrbDragLoop(): void {
  if (orbDragTimer !== null) {
    clearInterval(orbDragTimer);
    orbDragTimer = null;
  }
}

function tickOrbDrag(): void {
  if (orbWindow === null || orbDragPointerOffset === null) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const currentBounds = captureWindowBounds(orbWindow);
  const nextBounds = resolveOrbDragBounds({
    pointerScreenPoint: cursor,
    pointerOffset: orbDragPointerOffset,
    orbSize: {
      width: currentBounds.width,
      height: currentBounds.height
    },
    workArea: getVisibleWorkArea(currentBounds)
  });

  moveOrbWindow(nextBounds);
}

function startOrbDragLoop(): void {
  stopOrbDragLoop();
  tickOrbDrag();
  orbDragTimer = setInterval(tickOrbDrag, 16);
}

function queueOrbBoundsSave(bounds: WindowBounds): void {
  clearOrbBoundsPersistTimer();
  orbBoundsPersistTimer = setTimeout(() => {
    orbBoundsPersistTimer = null;
    void updateOrbDockSettings(bounds);
  }, 120);
}

async function updateOrbDockSettings(bounds: WindowBounds): Promise<void> {
  const placement = resolveOrbDockPlacement({
    orbBounds: bounds,
    workArea: getVisibleWorkArea(bounds)
  });
  const { bounds: nextBounds, dockEdge } = placement;

  const previousDockEdge = settings.orbDockEdge;
  await updateSettings({ orbBounds: nextBounds, orbDockEdge: dockEdge });

  if (orbWindow !== null) {
    const currentBounds = captureWindowBounds(orbWindow);

    if (currentBounds.x !== nextBounds.x || currentBounds.y !== nextBounds.y) {
      moveOrbWindow(nextBounds);
    }
  }

  if (dockEdge !== previousDockEdge && orbWindow !== null) {
    await orbWindow.loadURL(getDashboardUrl("desktop-orb", getOrbUrlParams(dockEdge)));
  }
}

function getVisibleWorkArea(bounds: WindowBounds): WindowBounds {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  });
  const displayBounds = toWindowBounds(display.bounds);
  const workArea = toWindowBounds(display.workArea);

  return {
    x: displayBounds.x,
    y: workArea.y,
    width: displayBounds.width,
    height: workArea.height
  };
}

function positionPeekCardWindow(): void {
  if (orbWindow === null || peekCardWindow === null) {
    return;
  }

  const orbBounds = captureWindowBounds(orbWindow);
  const peekBounds = captureWindowBounds(peekCardWindow);
  const peekWidth = peekBounds.width > 0 ? peekBounds.width : PEEK_CARD_SIZE.width;
  const peekHeight = peekBounds.height > 0 ? peekBounds.height : PEEK_CARD_SIZE.height;
  const nextBounds = resolvePeekCardBounds({
    orbBounds,
    peekSize: {
      width: peekWidth,
      height: peekHeight
    },
    workArea: getVisibleWorkArea(orbBounds)
  });

  peekCardWindow.setBounds(nextBounds);
}

function showPeekCardWindow(): void {
  if (peekCardWindow === null) {
    return;
  }

  positionPeekCardWindow();
  peekCardWindow.setFocusable(true);
  peekCardWindow.show();

  if (orbState.mode === "peekPinned") {
    peekCardWindow.focus();
    return;
  }

  peekCardWindow.setFocusable(false);
}

function moveOrbWindow(nextBounds: WindowBounds): void {
  if (orbWindow === null) {
    return;
  }

  orbWindow.setBounds(nextBounds);

  if (peekCardWindow?.isVisible()) {
    positionPeekCardWindow();
  }
}

function schedulePeekCardOpen(): void {
  if (peekCardWindow === null || orbWindow === null) {
    return;
  }

  clearTimeout(hoverCloseTimer ?? undefined);
  hoverCloseTimer = null;
  clearTimeout(hoverOpenTimer ?? undefined);
  hoverOpenTimer = setTimeout(() => {
    hoverOpenTimer = null;
    orbState = hoverOrb(orbState);
    showPeekCardWindow();
  }, 150);
}

function keepPeekCardOpen(): void {
  if (peekCardWindow === null) {
    return;
  }

  clearTimeout(hoverCloseTimer ?? undefined);
  hoverCloseTimer = null;

  if (orbState.mode === "orbDocked") {
    orbState = hoverOrb(orbState);
  }

  showPeekCardWindow();
}

function schedulePeekCardClose(): void {
  if (orbState.mode === "peekPinned") {
    return;
  }

  clearTimeout(hoverOpenTimer ?? undefined);
  hoverOpenTimer = null;
  clearTimeout(hoverCloseTimer ?? undefined);
  hoverCloseTimer = setTimeout(() => {
    hoverCloseTimer = null;
    if (orbState.mode === "peekPinned") {
      return;
    }

    orbState = leaveOrbRegion(orbState);
    peekCardWindow?.hide();
  }, 320);
}

function markDesktopSnapshotStale(): void {
  if (desktopSnapshot.status === "loading") {
    return;
  }

  desktopSnapshot = {
    ...desktopSnapshot,
    status: "stale"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDesktopSnapshot(snapshot: unknown): DesktopMetricsSnapshot | null {
  if (!isRecord(snapshot)) {
    return null;
  }

  const status: DesktopMetricsSnapshot["status"] =
    snapshot.status === "ready" || snapshot.status === "stale" || snapshot.status === "loading"
      ? snapshot.status
      : "loading";
  const metricsValue = isRecord(snapshot.metrics) ? snapshot.metrics : {};

  return {
    status,
    updatedAt: readNullableString(snapshot.updatedAt),
    metrics: {
      totalTokens: readNumber(metricsValue.totalTokens),
      cacheReadTokens: readNumber(metricsValue.cacheReadTokens),
      totalToolCalls: readNumber(metricsValue.totalToolCalls),
      editOperationCount: readNumber(metricsValue.editOperationCount),
      affectedFileCount: readNumber(metricsValue.affectedFileCount),
      insertions: readNumber(metricsValue.insertions),
      deletions: readNumber(metricsValue.deletions),
      successRate: readNumber(metricsValue.successRate),
      failedExecutions: readNumber(metricsValue.failedExecutions),
      averageDurationMs: readNumber(metricsValue.averageDurationMs)
    }
  };
}

function toggleFloatingWindow(): { visible: boolean } {
  if (floatingWindow === null) {
    return { visible: false };
  }

  if (floatingWindow.isVisible()) {
    floatingWindow.hide();
    return { visible: false };
  }

  floatingWindow.show();
  floatingWindow.focus();
  return { visible: true };
}

function captureWindowBounds(window: BrowserWindowLike): WindowBounds {
  return toWindowBounds(window.getNormalBounds());
}

function attachWindowStatePersistence({
  window,
  key
}: {
  window: BrowserWindowLike;
  key: "mainWindowBounds" | "floatingWindowBounds";
}): void {
  let persistTimer: NodeJS.Timeout | undefined;

  const persistBounds = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      void updateSettings({
        [key]: captureWindowBounds(window)
      });
    }, 150);
  };

  window.on("move", persistBounds);
  window.on("resize", persistBounds);
  window.on("closed", () => {
    clearTimeout(persistTimer);
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-runtime-status", () => supervisor.getStatus());
  ipcMain.handle("desktop:get-settings", () => settings);
  ipcMain.handle("desktop:update-settings", async (_event: unknown, patch: unknown) =>
    updateSettings((patch ?? {}) as Record<string, unknown>)
  );
  ipcMain.handle("desktop:get-orb-snapshot", async () => desktopSnapshot);
  ipcMain.handle("desktop:set-orb-snapshot", async (_event: unknown, snapshot: unknown) => {
    const nextSnapshot = parseDesktopSnapshot(snapshot);

    if (nextSnapshot !== null) {
      desktopSnapshot = nextSnapshot;
    }
  });
  ipcMain.handle("desktop:mark-orb-stale", async () => {
    markDesktopSnapshotStale();
  });
  ipcMain.handle("desktop:show-main-window", async () => {
    showMainWindow();
  });
  ipcMain.handle("desktop:toggle-floating-window", async () => toggleFloatingWindow());
  ipcMain.handle("desktop:show-orb", async () => {
    if (orbWindow?.isVisible()) {
      schedulePeekCardOpen();
      return;
    }

    showOrbWindow();
  });
  ipcMain.handle("desktop:hide-orb", async () => {
    if (orbWindow?.isVisible()) {
      schedulePeekCardClose();
      return;
    }

    hideOrbWindow();
  });
  ipcMain.handle("desktop:peek-enter", async () => {
    keepPeekCardOpen();
  });
  ipcMain.handle("desktop:peek-leave", async () => {
    schedulePeekCardClose();
  });
  ipcMain.handle("desktop:orb-drag-start", async () => {
    if (orbWindow === null) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const currentBounds = captureWindowBounds(orbWindow);
    orbDragPointerOffset = {
      x: cursor.x - currentBounds.x,
      y: cursor.y - currentBounds.y
    };
    clearHoverTimers();
    if (orbState.mode !== "peekPinned") {
      orbState = leaveOrbRegion(orbState);
      peekCardWindow?.hide();
    }
    startOrbDragLoop();
  });
  ipcMain.handle("desktop:orb-drag-move", async () => {
    tickOrbDrag();
  });
  ipcMain.handle("desktop:orb-drag-end", async () => {
    stopOrbDragLoop();

    if (orbWindow !== null) {
      orbWindow.setAlwaysOnTop(true, "floating");
    }

    if (orbWindow !== null) {
      queueOrbBoundsSave(captureWindowBounds(orbWindow));
    }

    orbDragPointerOffset = null;
  });
  ipcMain.handle("desktop:show-orb-menu", async () => {
    showOrbContextMenu();
  });
  ipcMain.handle("desktop:pin-peek-card", async () => {
    clearTimeout(hoverCloseTimer ?? undefined);
    hoverCloseTimer = null;

    orbState = createOrbSurfaceState("peekPinned");

    showPeekCardWindow();

    return { pinned: true };
  });
  ipcMain.handle("desktop:toggle-peek-card-pin", async () => {
    clearTimeout(hoverCloseTimer ?? undefined);
    hoverCloseTimer = null;

    orbState = togglePeekCardPin(orbState);

    if (orbState.mode === "peekPinned") {
      showPeekCardWindow();
    } else {
      peekCardWindow?.hide();
    }

    return { pinned: orbState.mode === "peekPinned" };
  });
  ipcMain.handle("desktop:expand-orb-detail", async () => {
    clearHoverTimers();
    orbState = expandOrbDetail(orbState);
    peekCardWindow?.hide();

    if (floatingWindow !== null) {
      floatingWindow.show();
      floatingWindow.focus();
    }
  });
}

async function bootstrap(): Promise<void> {
  await migrateLegacyDataRoots({
    dataRoot: runtimePaths.dataRoot,
    legacyDataRoots: [join(app.getPath("appData"), "Electron", "agent-metrics-data")]
  }).catch((error) => {
    console.error("Failed to migrate legacy desktop data root.", error);
  });

  settingsPath = join(app.getPath("userData"), "desktop-settings.json");
  settings = await loadDesktopSettings(settingsPath);
  registerIpcHandlers();

  await ensureDashboardDevServer();
  await supervisor.start();
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });

  mainWindow = new BrowserWindow({
    ...getMainWindowOptions(settings.mainWindowBounds),
    show: false,
    title: "Agent Metrics",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatingWindow = new BrowserWindow({
    ...getFloatingWindowOptions(settings.floatingWindowBounds),
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    frame: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    resizable: true,
    show: false,
    skipTaskbar: true,
    transparent: true,
    useContentSize: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  let initialOrbDockEdge = settings.orbDockEdge;

  if (process.platform === "win32" && settings.enableOrb) {
    const orbPlacement = getOrbWindowPlacement(settings.orbBounds, settings.orbDockEdge);
    const orbBounds = orbPlacement.bounds;
    initialOrbDockEdge = orbPlacement.dockEdge;
    const shouldSyncOrbPlacement =
      initialOrbDockEdge !== settings.orbDockEdge ||
      settings.orbBounds?.x !== orbBounds.x ||
      settings.orbBounds?.y !== orbBounds.y ||
      settings.orbBounds?.width !== orbBounds.width ||
      settings.orbBounds?.height !== orbBounds.height;

    if (shouldSyncOrbPlacement) {
      await updateSettings({ orbBounds, orbDockEdge: initialOrbDockEdge });
    }

    orbWindow = new BrowserWindow({
      width: orbBounds.width,
      height: orbBounds.height,
      x: orbBounds.x,
      y: orbBounds.y,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      frame: false,
      hasShadow: false,
      resizable: false,
      show: settings.showOrbOnStartup,
      skipTaskbar: true,
      transparent: true,
      useContentSize: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    peekCardWindow = new BrowserWindow({
      width: PEEK_CARD_SIZE.width,
      height: PEEK_CARD_SIZE.height,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      frame: false,
      hasShadow: false,
      focusable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      useContentSize: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    if (settings.showOrbOnStartup) {
      orbState = createOrbSurfaceState("orbDocked");
      startOrbTopmostGuard();
    }

    orbWindow.on("close", (event: PreventableEvent) => {
      if (quitting) {
        return;
      }

      event.preventDefault();
      hideOrbWindow();
    });
    orbWindow.on("move", () => {
      if (orbWindow === null) {
        return;
      }

      if (orbDragPointerOffset === null) {
        queueOrbBoundsSave(captureWindowBounds(orbWindow));
      }

      if (peekCardWindow?.isVisible()) {
        positionPeekCardWindow();
      }
    });
    orbWindow.on("closed", () => {
      clearOrbBoundsPersistTimer();
    });

    peekCardWindow.on("close", (event: PreventableEvent) => {
      if (quitting) {
        return;
      }

      event.preventDefault();
      clearHoverTimers();
      stopOrbDragLoop();
      orbDragPointerOffset = null;
      orbState = dismissPeekCard(orbState);
      peekCardWindow?.hide();
    });
  }

  attachWindowStatePersistence({ window: mainWindow, key: "mainWindowBounds" });
  attachWindowStatePersistence({ window: floatingWindow, key: "floatingWindowBounds" });

  mainWindow.on("close", (event: PreventableEvent) => {
    if (quitting) {
      return;
    }

    if (settings.closeBehavior === "hide-to-tray") {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }

    event.preventDefault();
    quitting = true;
    app.quit();
  });

  floatingWindow.on("close", (event: PreventableEvent) => {
    if (quitting) {
      return;
    }

    event.preventDefault();
    floatingWindow?.hide();
  });

  const loadSurface = async (
    loadWindow: BrowserWindowLike,
    surface: DesktopDashboardSurface,
    extraParams?: Record<string, string>
  ): Promise<void> => {
    try {
      await loadWindow.loadURL(getDashboardUrl(surface, extraParams));
    } catch (error) {
      markDesktopSnapshotStale();
      throw error;
    }
  };

  const loadTargets = [
    loadSurface(mainWindow, "desktop-main"),
    loadSurface(floatingWindow, "desktop-floating")
  ];

  if (orbWindow !== null) {
    loadTargets.push(loadSurface(orbWindow, "desktop-orb", getOrbUrlParams(initialOrbDockEdge)));
  }

  if (peekCardWindow !== null) {
    loadTargets.push(loadSurface(peekCardWindow, "desktop-orb-peek"));
  }

  await Promise.all(loadTargets);

  if (settings.showMainWindowOnStartup) {
    showMainWindow();
  }

  if (settings.reopenFloatingWindowOnStartup) {
    toggleFloatingWindow();
  }

  tray = createDesktopTray({
    showMainWindow,
    toggleFloatingWindow: () => {
      void toggleFloatingWindow();
    },
    showOrb: orbWindow ? showOrbWindow : undefined,
    resetOrbPosition: orbWindow ? resetOrbWindowPosition : undefined,
    openSettings: showMainWindow,
    quitApp: () => {
      quitting = true;
      app.quit();
      }
  });
}

app.on("activate", () => {
  showMainWindow();
});

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", (event: PreventableEvent) => {
  quitting = true;

  if (shutdownComplete) {
    return;
  }

  event.preventDefault();

  if (shutdownPromise !== null) {
    return;
  }

  shutdownPromise = supervisor
    .stop()
    .then(() => undefined)
    .catch((error) => {
      console.error("Failed to stop desktop runtime supervisor cleanly.", error);
    })
    .finally(() => {
      shutdownComplete = true;
      clearHoverTimers();
      stopOrbTopmostGuard();
      stopOrbDragLoop();
      dashboardDevProcess?.kill("SIGTERM");
      dashboardDevProcess = null;
      tray?.destroy();
      tray = null;
      app.quit();
    });
});

app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error("Failed to bootstrap the desktop shell.", error);
  quitting = true;
  void supervisor.stop().catch(() => undefined).finally(() => {
    app.quit();
  });
});
