import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProcessSupervisor } from "./runtime/process-supervisor.js";
import { buildDashboardUrl, resolveDesktopRuntimePaths } from "./runtime-paths.js";
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
let tray: { destroy(): void } | null = null;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
let settingsPath = "";
let settings: DesktopSettings;
let settingsSaveQueue = Promise.resolve();

const supervisor = createProcessSupervisor({ runtimePaths });

function toWindowBounds(bounds: RectangleLike): WindowBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function getDashboardUrl(surface: "desktop-main" | "desktop-floating"): string {
  const baseUrl = runtimePaths.packagedDashboardEntryUrl ?? runtimePaths.dashboardEntryUrl;
  return buildDashboardUrl(baseUrl, surface);
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

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
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
  ipcMain.handle("desktop:show-main-window", async () => {
    showMainWindow();
  });
  ipcMain.handle("desktop:toggle-floating-window", async () => toggleFloatingWindow());
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
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    resizable: true,
    show: false,
    skipTaskbar: true,
    title: "Agent Metrics Floating",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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

  await Promise.all([
    mainWindow.loadURL(getDashboardUrl("desktop-main")),
    floatingWindow.loadURL(getDashboardUrl("desktop-floating"))
  ]);

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
