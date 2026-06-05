import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOrbSurfaceState,
  dismissPeekCard,
  expandOrbDetail,
  hoverOrb,
  leaveOrbRegion,
  pinPeekCard
} from "./orb-state.js";
import {
  createDesktopMetricsSnapshot,
  type DesktopMetricsSnapshot
} from "./orb-snapshot.js";
import { resolveOrbDragBounds, resolvePeekCardBounds } from "./orb-layout.js";
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
  show(): void;
};

type BrowserWindowConstructor = new (options: Record<string, unknown>) => BrowserWindowLike;

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, screen } = require("electron") as {
  app: {
    getPath(name: string): string;
    isPackaged: boolean;
    on(event: "activate" | "before-quit", listener: (event: PreventableEvent) => void): void;
    quit(): void;
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
  screen: {
    getPrimaryDisplay(): {
      workArea: RectangleLike;
    };
  };
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, "preload.js");
const runtimePaths = resolveDesktopRuntimePaths({
  currentDir,
  isPackaged: app.isPackaged,
  userDataPath: app.getPath("userData")
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
let orbBoundsPersistTimer: NodeJS.Timeout | null = null;

const supervisor = createProcessSupervisor({ runtimePaths });

function toWindowBounds(bounds: RectangleLike): WindowBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function getDashboardUrl(surface: DesktopDashboardSurface): string {
  const baseUrl = runtimePaths.packagedDashboardEntryUrl ?? runtimePaths.dashboardEntryUrl;
  const apiBaseUrl = runtimePaths.packagedDashboardEntryUrl
    ? runtimePaths.coreApiBaseUrl
    : undefined;
  return buildDashboardUrl(baseUrl, surface, apiBaseUrl);
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
  orbState = createOrbSurfaceState("orbDocked");
}

function hideOrbWindow(): void {
  clearHoverTimers();
  orbWindow?.hide();
  peekCardWindow?.hide();

  if (orbState.mode !== "detailVisible" && orbState.mode !== "mainVisible") {
    orbState = createOrbSurfaceState("orbHidden");
  }
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

function queueOrbBoundsSave(bounds: WindowBounds): void {
  clearOrbBoundsPersistTimer();
  orbBoundsPersistTimer = setTimeout(() => {
    orbBoundsPersistTimer = null;
    void updateSettings({ orbBounds: bounds });
  }, 120);
}

function getVisibleWorkArea(bounds: WindowBounds): WindowBounds {
  return toWindowBounds(screen.getPrimaryDisplay().workArea);
}

function positionPeekCardWindow(): void {
  if (orbWindow === null || peekCardWindow === null) {
    return;
  }

  const orbBounds = captureWindowBounds(orbWindow);
  const peekBounds = captureWindowBounds(peekCardWindow);
  const nextBounds = resolvePeekCardBounds({
    orbBounds,
    peekSize: {
      width: peekBounds.width,
      height: peekBounds.height
    },
    workArea: getVisibleWorkArea(orbBounds)
  });

  peekCardWindow.setBounds(nextBounds);
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
    positionPeekCardWindow();
    peekCardWindow?.show();
    peekCardWindow?.focus();
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

  positionPeekCardWindow();
  peekCardWindow.show();
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
  ipcMain.handle("desktop:orb-drag-start", async (_event: unknown, offset: unknown) => {
    if (!isRecord(offset)) {
      return;
    }

    const x = readNumber(offset.x);
    const y = readNumber(offset.y);

    orbDragPointerOffset = { x, y };
    clearHoverTimers();
  });
  ipcMain.handle("desktop:orb-drag-move", async (_event: unknown, screenPoint: unknown) => {
    if (!isRecord(screenPoint) || orbWindow === null || orbDragPointerOffset === null) {
      return;
    }

    const currentBounds = captureWindowBounds(orbWindow);
    const nextBounds = resolveOrbDragBounds({
      pointerScreenPoint: {
        x: readNumber(screenPoint.x),
        y: readNumber(screenPoint.y)
      },
      pointerOffset: orbDragPointerOffset,
      orbSize: {
        width: currentBounds.width,
        height: currentBounds.height
      },
      workArea: getVisibleWorkArea(currentBounds)
    });

    moveOrbWindow(nextBounds);
  });
  ipcMain.handle("desktop:orb-drag-end", async () => {
    if (orbWindow !== null) {
      queueOrbBoundsSave(captureWindowBounds(orbWindow));
    }

    orbDragPointerOffset = null;
  });
  ipcMain.handle("desktop:pin-peek-card", async () => {
    clearTimeout(hoverCloseTimer ?? undefined);
    hoverCloseTimer = null;

    if (orbState.mode === "orbDocked") {
      orbState = pinPeekCard(hoverOrb(orbState));
    } else {
      orbState = pinPeekCard(orbState);
    }

    positionPeekCardWindow();
    peekCardWindow?.show();
    peekCardWindow?.focus();
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
  settingsPath = join(app.getPath("userData"), "desktop-settings.json");
  settings = await loadDesktopSettings(settingsPath);

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
    frame: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    resizable: true,
    show: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.platform === "win32" && settings.enableOrb) {
    orbWindow = new BrowserWindow({
      width: Math.max(settings.orbBounds?.width ?? 0, 76),
      height: Math.max(settings.orbBounds?.height ?? 0, 76),
      x: settings.orbBounds?.x,
      y: settings.orbBounds?.y,
      alwaysOnTop: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      show: settings.showOrbOnStartup,
      skipTaskbar: true,
      transparent: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    peekCardWindow = new BrowserWindow({
      width: 320,
      height: 220,
      alwaysOnTop: true,
      frame: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    if (settings.showOrbOnStartup) {
      orbState = createOrbSurfaceState("orbDocked");
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
    surface: DesktopDashboardSurface
  ): Promise<void> => {
    try {
      await loadWindow.loadURL(getDashboardUrl(surface));
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
    loadTargets.push(loadSurface(orbWindow, "desktop-orb"));
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
    openSettings: showMainWindow,
    quitApp: () => {
      quitting = true;
      app.quit();
    }
  });

  registerIpcHandlers();
}

app.on("activate", () => {
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
