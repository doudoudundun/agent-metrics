import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyCardView, toCardViewModel, type CardViewModel } from "./format.js";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  clampBoundsToWorkArea,
  defaultCardBounds,
  type DisplayWorkArea
} from "./layout.js";
import {
  fetchOverviewMetrics,
  POLL_INTERVAL_MS,
  resolveCoreApiBaseUrl,
  resolveLocalAccessToken
} from "./overview-client.js";
import { loadCardSettings, saveCardSettings, type CardSettings } from "./settings.js";

const require = createRequire(import.meta.url);
const electron = require("electron") as Record<string, any>;
const app = electron.app as Record<string, any>;
const BrowserWindow = electron.BrowserWindow as any;
const ipcMain = electron.ipcMain as Record<string, any>;
const screen = electron.screen as Record<string, any>;

const currentDir = dirname(fileURLToPath(import.meta.url));
const CHANNELS = {
  STATE: "card:state",
  REFRESH: "card:refresh",
  CLOSE: "card:close"
} as const;

let cardWindow: any = null;
let settings: CardSettings = { alwaysOnTop: false, bounds: null };
let settingsPath = "";
let pollTimer: NodeJS.Timeout | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let inflight: AbortController | null = null;
let inflightPromise: Promise<CardViewModel> | null = null;
let latestView: CardViewModel = emptyCardView("loading", "Connecting to local metrics core…", false);
let quitting = false;
let allowQuit = false;
let settingsWrite: Promise<void> = Promise.resolve();

const coreApiBaseUrl = resolveCoreApiBaseUrl();
const localAccessToken = resolveLocalAccessToken();

function getWorkArea(): DisplayWorkArea {
  const bounds = cardWindow && !cardWindow.isDestroyed() ? cardWindow.getBounds() : settings.bounds;
  const display = bounds
    ? screen.getDisplayMatching?.(bounds) ?? screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    : screen.getPrimaryDisplay();
  const area = display.workArea ?? display.bounds;
  return {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height
  };
}

function resolveWindowBounds() {
  const workArea = getWorkArea();
  const saved = settings.bounds
    ? clampBoundsToWorkArea({ ...settings.bounds, width: CARD_WIDTH, height: CARD_HEIGHT }, workArea)
    : defaultCardBounds(workArea);
  return clampBoundsToWorkArea({ ...saved, width: CARD_WIDTH, height: CARD_HEIGHT }, workArea);
}

async function persistSettings(): Promise<void> {
  if (!settingsPath) {
    return;
  }
  const snapshot = { ...settings, bounds: settings.bounds ? { ...settings.bounds } : null };
  settingsWrite = settingsWrite.catch(() => undefined).then(() => saveCardSettings(settingsPath, snapshot));
  await settingsWrite;
}

function schedulePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistSettings().catch(() => console.error("[card] Could not save window settings."));
  }, 150);
}

function rememberBounds(): void {
  if (quitting || !cardWindow || cardWindow.isDestroyed()) {
    return;
  }
  const bounds = cardWindow.getBounds();
  // Keep native drag coordinates intact across display boundaries. Clamping
  // here traps the card on its starting display before most of it crosses over.
  settings.bounds = bounds;
  schedulePersist();
}

function publishState(view: CardViewModel): void {
  latestView = view;
  if (cardWindow && !cardWindow.isDestroyed()) {
    cardWindow.webContents?.send?.(CHANNELS.STATE, view);
  }
}

async function refreshOverview(force = false): Promise<CardViewModel> {
  if (inflightPromise && !force) {
    return inflightPromise;
  }
  if (force && inflight) {
    inflight.abort();
    inflight = null;
  }
  const controller = new AbortController();
  inflight = controller;
  inflightPromise = (async () => {
    try {
      const result = await fetchOverviewMetrics({
        baseUrl: coreApiBaseUrl,
        token: localAccessToken,
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        return latestView;
      }
      const view = result.ok
        ? toCardViewModel(result.metrics, settings.alwaysOnTop)
        : latestView.status === "ready"
          ? {
              ...latestView,
              status: result.status,
              statusMessage: result.message,
              alwaysOnTop: settings.alwaysOnTop
            }
          : emptyCardView(result.status, result.message, settings.alwaysOnTop);
      publishState(view);
      return view;
    } finally {
      if (inflight === controller) {
        inflight = null;
        inflightPromise = null;
      }
    }
  })();
  return inflightPromise;
}

function startPolling(): void {
  stopPolling();
  void refreshOverview();
  pollTimer = setInterval(() => {
    void refreshOverview();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  inflight?.abort();
  inflight = null;
  inflightPromise = null;
}

function applyAlwaysOnTop(): void {
  if (!cardWindow || cardWindow.isDestroyed()) {
    return;
  }
  cardWindow.setAlwaysOnTop(settings.alwaysOnTop, "floating");
  if (process.platform === "darwin") {
    cardWindow.setVisibleOnAllWorkspaces?.(settings.alwaysOnTop, { visibleOnFullScreen: false });
  }
}

function createCardWindow(): any {
  if (cardWindow && !cardWindow.isDestroyed()) {
    return cardWindow;
  }
  const bounds = resolveWindowBounds();
  cardWindow = new BrowserWindow({
    ...bounds,
    minWidth: bounds.width,
    minHeight: bounds.height,
    maxWidth: bounds.width,
    maxHeight: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    focusable: process.platform !== "win32",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(currentDir, "preload.cjs")
    }
  });
  applyAlwaysOnTop();
  cardWindow.setMenuBarVisibility?.(false);
  cardWindow.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));
  cardWindow.webContents?.on?.("will-navigate", (event: { preventDefault(): void }) => {
    event.preventDefault();
  });
  void cardWindow.loadFile(join(currentDir, "renderer", "index.html"));
  cardWindow.once?.("ready-to-show", () => {
    if (cardWindow && !cardWindow.isDestroyed()) {
      cardWindow.setBounds(resolveWindowBounds());
      cardWindow.showInactive();
      publishState(latestView);
      void captureIfRequested();
    }
  });
  cardWindow.webContents?.on?.("did-finish-load", () => {
    publishState(latestView);
  });
  cardWindow.on("move", rememberBounds);
  cardWindow.on("close", rememberBounds);
  cardWindow.on("closed", () => {
    cardWindow = null;
    if (!quitting) {
      app.quit();
    }
  });
  return cardWindow;
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.REFRESH, async () => refreshOverview());
  ipcMain.handle(CHANNELS.CLOSE, async () => {
    cardWindow?.close();
    return { closed: true };
  });
}

function unregisterIpc(): void {
  ipcMain.removeHandler(CHANNELS.REFRESH);
  ipcMain.removeHandler(CHANNELS.CLOSE);
}

function onDisplayChanged(): void {
  if (!cardWindow || cardWindow.isDestroyed()) {
    return;
  }
  cardWindow.setBounds(resolveWindowBounds());
  rememberBounds();
}

async function captureIfRequested(): Promise<void> {
  const capturePath = process.env.AGENT_METRICS_CARD_CAPTURE?.trim();
  if (!capturePath || !cardWindow || cardWindow.isDestroyed()) {
    return;
  }
  await refreshOverview();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await mkdir(dirname(capturePath), { recursive: true });
  await writeFile(capturePath, (await cardWindow.capturePage()).toPNG());
  const toolbarPath = process.env.AGENT_METRICS_CARD_CAPTURE_TOOLBAR?.trim();
  if (toolbarPath) {
    await cardWindow.webContents?.executeJavaScript?.(
      "document.querySelector('.card')?.classList.add('is-toolbar-open')",
      true
    );
    await new Promise((resolve) => setTimeout(resolve, 160));
    await writeFile(toolbarPath, (await cardWindow.capturePage()).toPNG());
  }
  if (process.env.AGENT_METRICS_CARD_CAPTURE_QUIT === "1") {
    app.quit();
  }
}

function cleanup(): void {
  stopPolling();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  screen.removeListener?.("display-metrics-changed", onDisplayChanged);
  screen.removeListener?.("display-added", onDisplayChanged);
  screen.removeListener?.("display-removed", onDisplayChanged);
  unregisterIpc();
}

app.setName("Agent Metrics Card");
app.setPath("userData", process.env.AGENT_METRICS_CARD_USER_DATA_DIR?.trim() || join(app.getPath("appData"), "Agent Metrics Card"));
if (process.platform === "win32") {
  app.setAppUserModelId?.("dev.agentmetrics.desktop-card");
}

const gotLock = app.requestSingleInstanceLock?.() ?? true;
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!cardWindow || cardWindow.isDestroyed()) {
      return;
    }
    cardWindow.showInactive();
  });
  app.whenReady().then(async () => {
    settingsPath = join(app.getPath("userData"), "card-settings.json");
    settings = await loadCardSettings(settingsPath);
    latestView = emptyCardView("loading", "Connecting to local metrics core…", settings.alwaysOnTop);
    registerIpc();
    screen.on?.("display-metrics-changed", onDisplayChanged);
    screen.on?.("display-added", onDisplayChanged);
    screen.on?.("display-removed", onDisplayChanged);
    createCardWindow();
    startPolling();
  });
}

app.on("before-quit", (event: { preventDefault(): void }) => {
  if (allowQuit) {
    return;
  }
  event.preventDefault();
  if (quitting) {
    return;
  }
  rememberBounds();
  quitting = true;
  cleanup();
  void persistSettings()
    .catch(() => console.error("[card] Could not save window settings."))
    .finally(() => {
      allowQuit = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  app.quit();
});
