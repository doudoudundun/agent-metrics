/**
 * Phase 7 production desktop entry: exactly one Main and one Widget BrowserWindow.
 * Never creates orb, peek-card, or floating legacy surfaces (see `legacy/main.ts`).
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ApiErrorResponseSchema,
  DEFAULT_DESKTOP_SETTINGS,
  DesktopIpcChannel,
  DesktopIpcSchemas,
  DesktopPlatformInfoSchema,
  DesktopSettingsSchema,
  DesktopSettingsPatchSchema,
  DesktopSettingsViewSchema,
  RuntimeStatusSchema,
  ShowMainWindowResponseSchema,
  ShowWidgetMenuResponseSchema,
  WidgetCommandResultSchema,
  WidgetFocusWithinRequestSchema,
  WidgetPointerResultSchema,
  type ChildName,
  type DesktopSettings,
  type RuntimeStatus,
  type WidgetMode
} from "@agent-metrics/contracts";
import { buildDashboardUrl, resolveDesktopRuntimePaths } from "./runtime-paths.js";
import { resolveDesktopNodeExecutable } from "./runtime/node-executable.js";
import { createRuntimeSupervisor } from "./runtime/runtime-supervisor.js";
import { loadDesktopSettingsV2, saveDesktopSettingsV2 } from "./desktop-settings-v2.js";
import { migrateLegacyDataRoots } from "./data-root-migration.js";
import {
  clampWidgetBounds,
  normalizeWidgetAnchor,
  resolveWidgetBounds,
  type DisplayWorkArea
} from "./widget-layout.js";
import {
  ACTIVATION_SUPPRESSION_MS,
  CLOSE_DELAY_MS,
  DRAG_THRESHOLD_PX,
  OPEN_DELAY_MS,
  createWidgetState,
  recoverWidgetStateAfterReload,
  reduceWidgetState,
  shouldCollapse,
  shouldOpen,
  type WidgetState
} from "./widget-state.js";
import { installBrokenPipeGuards } from "./runtime/safe-logging.js";
import {
  assertProductWindowInvariant,
  enumerateProductWindows
} from "./product-windows.js";

installBrokenPipeGuards([globalThis.process.stdout, globalThis.process.stderr]);

const require = createRequire(import.meta.url);
const electron = require("electron") as Record<string, any>;
const app = electron.app as Record<string, any>;
const BrowserWindow = electron.BrowserWindow as any;
const ipcMain = electron.ipcMain as Record<string, any>;
const Menu = electron.Menu as Record<string, any>;
const screen = electron.screen as Record<string, any>;

const MAIN_DEFAULT_BOUNDS = { width: 1360, height: 900 } as const;

type WindowRole = "main" | "widget";

let mainWindow: any = null;
let widgetWindow: any = null;
let tray: any = null;
let settings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS;
let settingsPath = "";
let widgetState: WidgetState = createWidgetState();
let widgetAnchorRatio = 0.5;
let widgetCloseTimer: NodeJS.Timeout | null = null;
let widgetOpenTimer: NodeJS.Timeout | null = null;
let pointerOrigin: { x: number; y: number } | null = null;
let pointerStartBounds: { x: number; y: number; width: number; height: number } | null = null;
let widgetDragging = false;
let widgetHoverPolling: NodeJS.Timeout | null = null;
let widgetTopmostGuard: NodeJS.Timeout | null = null;
let widgetCursorInside = false;
let widgetLastDragEndedAt = 0;
let quitting = false;
let shutdownPromise: Promise<void> | null = null;

const currentDir = dirname(fileURLToPath(import.meta.url));
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
  currentExecutablePath: process.execPath
});
const localAccessToken = resolveLocalAccessToken();
const supervisor = createRuntimeSupervisor({
  runtimePaths,
  nodeExecutablePath: desktopNodeExecutable,
  localAccessToken,
  isExternalRuntimeHealthy: async () => {
    return isCoreApiHealthy();
  },
  log: (message) => {
    const logPath = join(runtimePaths.dataRoot, "logs", "runtime", "supervisor.log");
    void mkdir(dirname(logPath), { recursive: true })
      .then(() => appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8"))
      .catch(() => undefined);
  }
});

function resolveLocalAccessToken(): string {
  const existing = process.env.AGENT_METRICS_LOCAL_TOKEN?.trim();
  if (existing) {
    return existing;
  }
  const generated = randomBytes(24).toString("hex");
  process.env.AGENT_METRICS_LOCAL_TOKEN = generated;
  return generated;
}

function dashboardUrl(role: WindowRole): string {
  const baseUrl = runtimePaths.packagedDashboardEntryUrl ?? runtimePaths.dashboardEntryUrl;
  const apiBase = runtimePaths.packagedDashboardEntryUrl ? runtimePaths.coreApiBaseUrl : undefined;
  return buildDashboardUrl(
    baseUrl,
    role === "main" ? "desktop-main" : "desktop-widget",
    apiBase
  );
}

async function isCoreApiHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${runtimePaths.coreApiBaseUrl}/api/health`, {
      signal: controller.signal
    });
    if (!response.ok) {
      return false;
    }
    const payload: unknown = await response.json();
    return payload !== null && typeof payload === "object" &&
      (payload as Record<string, unknown>).apiVersion === 2 &&
      (payload as Record<string, unknown>).eventSchemaVersion === 2;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function loadSettings(): Promise<void> {
  settingsPath = join(app.getPath("userData"), "settings.json");
  settings = await loadDesktopSettingsV2(settingsPath);
  await saveDesktopSettingsV2(settingsPath, settings);
  widgetState = createWidgetState(settings.widgetModeOnStartup, "loading");
  if (settings.widgetBounds) {
    widgetAnchorRatio = normalizeWidgetAnchor(settings.widgetBounds, getWidgetWorkArea());
  }
}

function createMainWindow(): any {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  const bounds = settings.mainWindowBounds;
  mainWindow = new BrowserWindow({
    ...(bounds ?? MAIN_DEFAULT_BOUNDS),
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: secureWebPreferences("main")
  });
  configureRendererWindow(mainWindow, "main");
  attachRendererRecovery(mainWindow, "main");
  void mainWindow.loadURL(dashboardUrl("main"));
  mainWindow.once?.("ready-to-show", () => {
    if (settings.showMainWindowOnStartup || mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
  mainWindow.on("moved", persistMainWindowBounds);
  mainWindow.on("resized", persistMainWindowBounds);
  mainWindow.on("close", (event: any) => {
    if (!quitting && settings.closeBehavior === "hide-to-tray") {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function ensureWidgetWindow(): any | null {
  if (!settings.widgetEnabled) {
    return null;
  }
  if (widgetWindow !== null && !widgetWindow.isDestroyed()) {
    return widgetWindow;
  }
  const workArea = getWidgetWorkArea();
  const bounds = resolveWidgetBounds({
    mode: widgetState.mode,
    dockEdge: settings.widgetDockEdge,
    anchorRatio: widgetAnchorRatio,
    workArea
  });
  widgetWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    // Windows transparent windows with focusable:false often drop mouse input entirely.
    focusable: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: secureWebPreferences("widget")
  });
  configureRendererWindow(widgetWindow, "widget");
  assertWidgetAlwaysOnTop(widgetWindow);
  widgetWindow.setIgnoreMouseEvents?.(false);
  // macOS: keep the floating Widget visible across Spaces and on the desktop layer
  // (equivalent of the legacy orb's Space behavior). Windows falls through; the
  // always-on-top floating level is set above.
  if (process.platform === "darwin") {
    widgetWindow.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: false });
  }
  attachWidgetNativeInput(widgetWindow);
  attachRendererRecovery(widgetWindow, "widget");
  void widgetWindow.loadURL(dashboardUrl("widget"));
  widgetWindow.webContents?.on?.("did-finish-load", () => {
    void widgetWindow.webContents
      ?.executeJavaScript?.(
        `Boolean(window.agentMetricsDesktop && window.agentMetricsDesktopReady)`,
        true
      )
      .then((ready: boolean) => {
        void appendFile(
          join(runtimePaths.dataRoot, "logs", "runtime", "supervisor.log"),
          `${new Date().toISOString()} widget preload ready=${ready}\n`,
          "utf8"
        ).catch(() => undefined);
      })
      .catch(() => undefined);
  });
  widgetWindow.on("closed", () => {
    stopWidgetHoverPolling();
    stopWidgetTopmostGuard();
    clearWidgetTimers();
    widgetWindow = null;
    pointerOrigin = null;
    pointerStartBounds = null;
    widgetDragging = false;
    widgetCursorInside = false;
  });
  startWidgetHoverPolling();
  startWidgetTopmostGuard();
  applyWidgetVisibility();
  return widgetWindow;
}

/**
 * Windows transparent windows often drop renderer pointer events.
 * Hook WM_* so expand/drag/pin work even when preload/renderer input fails.
 */
function attachWidgetNativeInput(window: any): void {
  if (process.platform !== "win32" || typeof window.hookWindowMessage !== "function") {
    return;
  }
  const WM_MOUSEMOVE = 0x0200;
  const WM_LBUTTONDOWN = 0x0201;
  const WM_LBUTTONUP = 0x0202;
  const WM_LBUTTONDBLCLK = 0x0203;
  window.hookWindowMessage(WM_LBUTTONDOWN, () => {
    beginWidgetPointer();
  });
  window.hookWindowMessage(WM_MOUSEMOVE, () => {
    if (pointerOrigin !== null) {
      applyWidgetPointerMove();
    }
  });
  window.hookWindowMessage(WM_LBUTTONUP, () => {
    if (pointerOrigin !== null) {
      endWidgetPointer();
    }
  });
  window.hookWindowMessage(WM_LBUTTONDBLCLK, () => {
    setWidgetMode("pinned", true);
  });
}

/** Renderer hover can miss on some Windows transparent setups; poll cursor vs bounds. */
function startWidgetHoverPolling(): void {
  stopWidgetHoverPolling();
  widgetHoverPolling = setInterval(() => {
    if (widgetWindow === null || widgetWindow.isDestroyed()) {
      return;
    }
    // Mid-drag: keep expanded under the cursor. If the drag flag is stuck with
    // no active pointer origin, recover so leave detection can run again.
    if (widgetDragging) {
      if (pointerOrigin !== null) {
        return;
      }
      widgetDragging = false;
      widgetState = {
        ...widgetState,
        interaction: { ...widgetState.interaction, dragging: false }
      };
    }
    if (!widgetWindow.isVisible?.()) {
      if (widgetCursorInside || widgetState.mode === "expanded") {
        widgetCursorInside = false;
        onWidgetPointerLeave();
      }
      return;
    }
    const bounds = widgetWindow.getBounds();
    const point = screen.getCursorScreenPoint();
    const inside =
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height;
    if (inside) {
      if (!widgetCursorInside) {
        widgetCursorInside = true;
        onWidgetPointerEnter();
      }
      return;
    }

    // Cursor is outside. Always reconcile — do not require an edge transition.
    // Otherwise a click-driven fake pointerInside leaves the widget stuck open.
    widgetCursorInside = false;
    if (
      widgetState.mode === "expanded" ||
      widgetState.interaction.pointerInside ||
      widgetState.interaction.keyboardFocusInside
    ) {
      onWidgetPointerLeave();
    }
  }, 50);
}

function stopWidgetHoverPolling(): void {
  if (widgetHoverPolling !== null) {
    clearInterval(widgetHoverPolling);
    widgetHoverPolling = null;
  }
}

/**
 * Windows (and some always-on-top peers) can drop WS_EX_TOPMOST after hide/show,
 * focus changes, or competing topmost windows. Legacy orb had a 2s guard; without
 * it the Widget stays "visible" but sinks under other windows — tray Show Widget
 * then looks like a no-op because isVisible() is already true.
 */
function assertWidgetAlwaysOnTop(window: any = widgetWindow): void {
  if (window === null || window.isDestroyed?.()) {
    return;
  }
  window.setAlwaysOnTop?.(true, "floating");
  window.moveTop?.();
}

function startWidgetTopmostGuard(): void {
  stopWidgetTopmostGuard();
  widgetTopmostGuard = setInterval(() => {
    if (widgetWindow === null || widgetWindow.isDestroyed?.() || !widgetWindow.isVisible?.()) {
      return;
    }
    if (typeof widgetWindow.isAlwaysOnTop === "function" && widgetWindow.isAlwaysOnTop()) {
      return;
    }
    assertWidgetAlwaysOnTop(widgetWindow);
  }, 2000);
}

function stopWidgetTopmostGuard(): void {
  if (widgetTopmostGuard !== null) {
    clearInterval(widgetTopmostGuard);
    widgetTopmostGuard = null;
  }
}

function secureWebPreferences(role: WindowRole): Record<string, unknown> {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    // Sandboxed preloads cannot reliably require workspace packages; preload-v2 is self-contained.
    sandbox: true,
    // Widget must keep 5s polling accurate while unfocused / always-on-top.
    backgroundThrottling: role !== "widget",
    preload: join(currentDir, "preload-v2.cjs"),
    additionalArguments: [
      `--agent-metrics-role=${role}`,
      `--agent-metrics-token=${localAccessToken}`
    ]
  };
}

function configureRendererWindow(window: any, role: WindowRole): void {
  window.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));
  window.webContents?.on?.("will-navigate", (event: any, url: string) => {
    if (!isTrustedUrl(role, url)) {
      event.preventDefault();
    }
  });
}

/**
 * Spec §16.5: a renderer reload/crash preserves controller mode, normalized
 * anchor, and visibility and recreates/reloads at most the existing single
 * BrowserWindow. The Widget recovery uses the pure `recoverWidgetStateAfterReload`
 * helper so the rule is unit-tested independently of Electron. The Main window
 * only needs reload-on-crash (it has no controller state). Neither path ever
 * creates a second window.
 */
function attachRendererRecovery(window: any, role: WindowRole): void {
  const webContents = window?.webContents;
  if (!webContents || typeof webContents.on !== "function") {
    return;
  }
  webContents.on("render-process-gone", (_event: unknown, details: { reason?: string } | undefined) => {
    const reason = details?.reason === "crashed" ? "crashed" : "reload";
    if (reason === "crashed" && role === "widget") {
      widgetState = recoverWidgetStateAfterReload(
        widgetState,
        settings.widgetModeOnStartup,
        "crashed"
      );
      clearWidgetTimers();
      widgetLastDragEndedAt = 0;
      positionWidget();
      applyWidgetVisibility();
    }
    // Reload the existing single window; never create a second BrowserWindow.
    try {
      webContents.reload?.();
    } catch {
      // Reload may throw during shutdown; the single-instance guard and lifecycle
      // handlers own teardown in that case.
    }
    void appendFile(
      join(runtimePaths.dataRoot, "logs", "runtime", "supervisor.log"),
      `${new Date().toISOString()} renderer-gone role=${role} reason=${reason}\n`,
      "utf8"
    ).catch(() => undefined);
  });
}

function isTrustedUrl(role: WindowRole, url: string): boolean {
  if (typeof url !== "string" || url.trim().length === 0) {
    return false;
  }
  try {
    const expected = new URL(dashboardUrl(role));
    const actual = new URL(url);
    if (expected.protocol === "file:") {
      return actual.protocol === "file:" && actual.pathname === expected.pathname;
    }
    return actual.origin === expected.origin;
  } catch {
    return false;
  }
}

function getWidgetWorkArea(): DisplayWorkArea {
  const point = widgetWindow?.getBounds?.() ?? settings.widgetBounds ?? { x: 0, y: 0 };
  const display = screen.getDisplayNearestPoint(point);
  return display.workArea;
}

function positionWidget(): void {
  if (widgetWindow === null || widgetWindow.isDestroyed()) {
    return;
  }
  const workArea = getWidgetWorkArea();
  const bounds = resolveWidgetBounds({
    mode: widgetState.mode,
    dockEdge: settings.widgetDockEdge,
    anchorRatio: widgetAnchorRatio,
    workArea
  });
  widgetWindow.setBounds(bounds, false);
}

function applyWidgetVisibility(): void {
  if (widgetWindow === null || widgetWindow.isDestroyed()) {
    return;
  }
  if (!widgetState.visible) {
    widgetWindow.hide();
    return;
  }
  positionWidget();
  assertWidgetAlwaysOnTop(widgetWindow);
  // Always show + raise: a "visible" but buried window must still come forward
  // when tray Show Widget / mode changes re-assert visibility.
  if (typeof widgetWindow.showInactive === "function") {
    widgetWindow.showInactive();
  } else {
    widgetWindow.show?.();
  }
  widgetWindow.moveTop?.();
}

function clearWidgetTimers(): void {
  if (widgetOpenTimer !== null) {
    clearTimeout(widgetOpenTimer);
    widgetOpenTimer = null;
  }
  if (widgetCloseTimer !== null) {
    clearTimeout(widgetCloseTimer);
    widgetCloseTimer = null;
  }
}

function setWidgetMode(mode: WidgetMode, persist = false): void {
  clearWidgetTimers();
  widgetState = { ...widgetState, mode, visible: true };
  positionWidget();
  applyWidgetVisibility();
  if (persist && (mode === "collapsed" || mode === "pinned")) {
    settings = { ...settings, widgetModeOnStartup: mode };
    void saveDesktopSettingsV2(settingsPath, settings);
  }
  // Unpin / explicit expand while the cursor is already outside should still retract.
  if (mode === "expanded") {
    const bounds = widgetWindow?.getBounds?.();
    const point = screen.getCursorScreenPoint();
    const inside =
      bounds != null &&
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height;
    if (!inside) {
      widgetCursorInside = false;
      onWidgetPointerLeave();
    }
  }
}

function showWidget(): void {
  widgetState = reduceWidgetState(widgetState, { type: "show" });
  ensureWidgetWindow();
  startWidgetTopmostGuard();
  applyWidgetVisibility();
}

function hideWidget(): void {
  clearWidgetTimers();
  widgetState = reduceWidgetState(widgetState, { type: "hide" });
  applyWidgetVisibility();
}

function onWidgetPointerEnter(): void {
  if (widgetCloseTimer !== null) {
    clearTimeout(widgetCloseTimer);
    widgetCloseTimer = null;
  }
  widgetState = reduceWidgetState(widgetState, { type: "pointer-enter" });
  if (!shouldOpen(widgetState)) {
    return;
  }
  // Spec §16.4: suppress auto-open immediately after a drag to avoid the
  // release-point hover re-expanding the Widget the user just docked.
  if (
    widgetLastDragEndedAt > 0 &&
    Date.now() - widgetLastDragEndedAt < ACTIVATION_SUPPRESSION_MS
  ) {
    return;
  }
  if (widgetOpenTimer !== null) {
    return;
  }
  widgetOpenTimer = setTimeout(() => {
    widgetOpenTimer = null;
    if (shouldOpen(widgetState)) {
      setWidgetMode("expanded");
    }
  }, OPEN_DELAY_MS);
}

function onWidgetPointerLeave(): void {
  if (widgetOpenTimer !== null) {
    clearTimeout(widgetOpenTimer);
    widgetOpenTimer = null;
  }
  widgetState = reduceWidgetState(widgetState, { type: "pointer-leave" });
  // Hover widgets should retract when the cursor leaves even if a prior click
  // left keyboard focus on a control; otherwise expand mode sticks open.
  if (widgetState.interaction.keyboardFocusInside) {
    widgetState = reduceWidgetState(widgetState, { type: "focus-within", focused: false });
  }
  if (!shouldCollapse(widgetState) || widgetCloseTimer !== null) {
    return;
  }
  widgetCloseTimer = setTimeout(() => {
    widgetCloseTimer = null;
    if (shouldCollapse(widgetState)) {
      setWidgetMode("collapsed");
    }
  }, CLOSE_DELAY_MS);
}

function onWidgetFocusWithin(focused: boolean): void {
  widgetState = reduceWidgetState(widgetState, { type: "focus-within", focused });
  // Never map keyboard focus onto pointer enter/leave. Doing so sets
  // pointerInside=true after a footer click even when the cursor already left,
  // and hover polling will not emit another leave edge — expand sticks forever.
  if (!focused) {
    const bounds = widgetWindow?.getBounds?.();
    const point = screen.getCursorScreenPoint();
    const inside =
      bounds != null &&
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height;
    if (!inside) {
      onWidgetPointerLeave();
    }
  }
}

function beginWidgetPointer(): { activationEligible: boolean; dragging: boolean } {
  clearWidgetTimers();
  pointerOrigin = screen.getCursorScreenPoint();
  pointerStartBounds = widgetWindow?.getBounds?.() ?? null;
  widgetDragging = false;
  widgetState = { ...widgetState, interaction: { ...widgetState.interaction, dragging: false } };
  return { activationEligible: true, dragging: false };
}

function updateWidgetPointer(): { activationEligible: boolean; dragging: boolean } {
  return applyWidgetPointerMove();
}

function applyWidgetPointerMove(): { activationEligible: boolean; dragging: boolean } {
  if (pointerOrigin === null || pointerStartBounds === null || widgetWindow === null) {
    return { activationEligible: false, dragging: false };
  }
  const point = screen.getCursorScreenPoint();
  const distance = Math.hypot(point.x - pointerOrigin.x, point.y - pointerOrigin.y);
  if (!widgetDragging && distance >= DRAG_THRESHOLD_PX) {
    widgetDragging = true;
    widgetState = { ...widgetState, interaction: { ...widgetState.interaction, dragging: true } };
  }
  if (widgetDragging) {
    widgetWindow.setPosition(
      pointerStartBounds.x + point.x - pointerOrigin.x,
      pointerStartBounds.y + point.y - pointerOrigin.y,
      false
    );
  }
  return { activationEligible: !widgetDragging, dragging: widgetDragging };
}

function endWidgetPointer(): { activationEligible: boolean; dragging: boolean } {
  // Native WM_LBUTTONUP and renderer pointerup both call this. A duplicate end
  // after the first cleared pointerOrigin must not be treated as "click → pin".
  if (pointerOrigin === null && !widgetDragging) {
    return { activationEligible: true, dragging: false };
  }

  const wasDragging = widgetDragging;
  const result = { activationEligible: !wasDragging, dragging: wasDragging };
  if (widgetWindow !== null && !widgetWindow.isDestroyed()) {
    if (wasDragging) {
      const workArea = getWidgetWorkArea();
      const dragged = clampWidgetBounds(widgetWindow.getBounds(), workArea);
      const centerX = dragged.x + dragged.width / 2;
      settings = {
        ...settings,
        widgetDockEdge: centerX < workArea.x + workArea.width / 2 ? "left" : "right"
      };
      persistWidgetAnchor(dragged);
      positionWidget();
      // Spec §16.4: a drag gesture ends activation eligibility for this interaction
      // and suppresses the immediate hover re-open (ACTIVATION_SUPPRESSION_MS).
      widgetLastDragEndedAt = Date.now();
    } else if (widgetState.mode === "collapsed") {
      // Spec §16.4: collapsed primary click without drag → pinned.
      // Never auto-pin from an expanded surface (Pin button owns that).
      setWidgetMode("pinned", true);
    }
  }
  widgetDragging = false;
  pointerOrigin = null;
  pointerStartBounds = null;
  widgetState = { ...widgetState, interaction: { ...widgetState.interaction, dragging: false } };

  // After a drag the window snaps to the dock; the cursor is often already
  // outside the new bounds. Drive leave so expanded mode can retract.
  if (wasDragging && widgetState.mode === "expanded") {
    const bounds = widgetWindow?.getBounds?.();
    const point = screen.getCursorScreenPoint();
    const inside =
      bounds != null &&
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height;
    widgetCursorInside = inside;
    if (inside) {
      widgetState = reduceWidgetState(widgetState, { type: "pointer-enter" });
    } else {
      onWidgetPointerLeave();
    }
  }

  return result;
}

function showWidgetMenu(): { shown: boolean } {
  if (widgetWindow === null) {
    return { shown: false };
  }
  Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => showMainWindow() },
    { label: "Hide Widget", click: () => hideWidget() },
    { type: "separator" },
    { label: "Reset Position", click: () => resetWidgetPosition() },
    { type: "separator" },
    { label: "Quit", click: () => quitApp() }
  ]).popup({ window: widgetWindow });
  return { shown: true };
}

function persistWidgetAnchor(bounds: { x: number; y: number; width: number; height: number }): void {
  const workArea = getWidgetWorkArea();
  widgetAnchorRatio = normalizeWidgetAnchor(bounds, workArea);
  const collapsed = resolveWidgetBounds({
    mode: "collapsed",
    dockEdge: settings.widgetDockEdge,
    anchorRatio: widgetAnchorRatio,
    workArea
  });
  settings = { ...settings, widgetBounds: collapsed };
  void saveDesktopSettingsV2(settingsPath, settings);
}

function persistMainWindowBounds(): void {
  if (mainWindow === null || mainWindow.isDestroyed?.()) {
    return;
  }
  settings = { ...settings, mainWindowBounds: mainWindow.getBounds() };
  void saveDesktopSettingsV2(settingsPath, settings);
}

/**
 * Spec §16.4 ("any | reset position | default visible position in current mode")
 * and §16.9 (tray show/hide/reset commands). Resets the anchor to the vertical
 * center of the current display work area, keeps the current mode, and persists
 * the normalized collapsed anchor bounds.
 */
function resetWidgetPosition(): void {
  widgetAnchorRatio = 0.5;
  clearWidgetTimers();
  widgetState = { ...widgetState, visible: true };
  persistWidgetAnchor(
    resolveWidgetBounds({
      mode: "collapsed",
      dockEdge: settings.widgetDockEdge,
      anchorRatio: widgetAnchorRatio,
      workArea: getWidgetWorkArea()
    })
  );
  positionWidget();
  applyWidgetVisibility();
}

function showMainWindow(): { visible: true } {
  const window = createMainWindow();
  window.show();
  window.focus();
  // Spec §16.4 row "expanded | open main": apply the persisted
  // widgetModeAfterOpenMain to the Widget controller state. This automatic
  // transition MUST NOT rewrite widgetModeOnStartup, and must not unpin.
  if (widgetWindow !== null && !widgetWindow.isDestroyed() && widgetState.mode === "expanded") {
    widgetState = reduceWidgetState(widgetState, {
      type: "open-main",
      mode: settings.widgetModeAfterOpenMain
    });
    positionWidget();
    applyWidgetVisibility();
  }
  return { visible: true };
}

function commandResult(): { visible: boolean; mode: WidgetMode } {
  return { visible: widgetWindow?.isVisible?.() ?? false, mode: widgetState.mode };
}

function platformInfo(): { platform: "win32" | "darwin"; supportsLaunchAtLogin: true; supportsWidget: true } {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("Unsupported desktop platform");
  }
  return { platform: process.platform, supportsLaunchAtLogin: true, supportsWidget: true };
}

function runtimeStatus(): RuntimeStatus {
  return RuntimeStatusSchema.parse({
    state: supervisor.getStatus().state,
    coreEndpoint: runtimePaths.coreApiBaseUrl,
    children: supervisor.getStatus().children,
    lastUpdatedAt: new Date().toISOString()
  });
}

function settingsView(): unknown {
  return DesktopSettingsViewSchema.parse({ ...settings, ...platformInfo() });
}

function assertSender(event: any, role: WindowRole | "either"): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const expected = role === "main" ? mainWindow : role === "widget" ? widgetWindow : null;
  if (role !== "either" && senderWindow !== expected) {
    throw new Error("Untrusted renderer sender");
  }
  if (role === "either" && senderWindow !== mainWindow && senderWindow !== widgetWindow) {
    throw new Error("Untrusted renderer sender");
  }
  const resolvedRole = senderWindow === widgetWindow ? "widget" : "main";
  // senderFrame.url can be "" during navigation; empty string must not block getURL().
  const senderUrl = (event.senderFrame?.url || event.sender.getURL?.() || "") as string;
  if (!isTrustedUrl(resolvedRole, senderUrl)) {
    throw new Error(`Untrusted renderer origin: ${senderUrl || "<empty>"}`);
  }
}

function registerIpc<TRequest, TResponse>(
  channel: string,
  role: WindowRole | "either",
  requestSchema: { parse(value: unknown): TRequest },
  responseSchema: { parse(value: unknown): TResponse },
  handler: (request: TRequest) => Promise<TResponse> | TResponse
): void {
  ipcMain.handle(channel, async (event: any, payload: unknown = {}) => {
    try {
      assertSender(event, role);
      const request = requestSchema.parse(payload === undefined ? {} : payload);
      return responseSchema.parse(await handler(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void appendFile(
        join(runtimePaths.dataRoot, "logs", "runtime", "supervisor.log"),
        `${new Date().toISOString()} ipc:${channel} ${message}\n`,
        "utf8"
      ).catch(() => undefined);
      throw error;
    }
  });
}

function registerIpcHandlers(): void {
  const schemas = DesktopIpcSchemas as Record<string, any>;
  registerIpc(DesktopIpcChannel.GET_PLATFORM_INFO, "either", schemas[DesktopIpcChannel.GET_PLATFORM_INFO].request, schemas[DesktopIpcChannel.GET_PLATFORM_INFO].response, () => platformInfo());
  registerIpc(DesktopIpcChannel.GET_RUNTIME_STATUS, "main", schemas[DesktopIpcChannel.GET_RUNTIME_STATUS].request, schemas[DesktopIpcChannel.GET_RUNTIME_STATUS].response, () => runtimeStatus());
  registerIpc(DesktopIpcChannel.GET_SETTINGS, "either", schemas[DesktopIpcChannel.GET_SETTINGS].request, schemas[DesktopIpcChannel.GET_SETTINGS].response, () => settingsView());
  registerIpc(DesktopIpcChannel.UPDATE_SETTINGS, "main", DesktopSettingsPatchSchema, DesktopSettingsViewSchema, async (patch) => {
    settings = DesktopSettingsSchema.parse({ ...settings, ...patch });
    app.setLoginItemSettings?.({ openAtLogin: settings.launchAtLogin });
    if (!settings.widgetEnabled) {
      widgetWindow?.destroy?.();
      widgetWindow = null;
    } else if (settings.showWidgetOnStartup) {
      showWidget();
    }
    await saveDesktopSettingsV2(settingsPath, settings);
    return settingsView();
  });
  registerIpc(DesktopIpcChannel.RESTART_RUNTIME, "main", schemas[DesktopIpcChannel.RESTART_RUNTIME].request, schemas[DesktopIpcChannel.RESTART_RUNTIME].response, async ({ child }: { child: ChildName }) => {
    await supervisor.restart(child);
    return runtimeStatus();
  });
  registerIpc(DesktopIpcChannel.SHOW_MAIN_WINDOW, "either", schemas[DesktopIpcChannel.SHOW_MAIN_WINDOW].request, ShowMainWindowResponseSchema, () => showMainWindow());
  registerIpc(DesktopIpcChannel.HIDE_WIDGET, "widget", schemas[DesktopIpcChannel.HIDE_WIDGET].request, WidgetCommandResultSchema, () => {
    hideWidget();
    return commandResult();
  });
  registerIpc(DesktopIpcChannel.SET_WIDGET_MODE, "widget", schemas[DesktopIpcChannel.SET_WIDGET_MODE].request, WidgetCommandResultSchema, ({ mode }: { mode: WidgetMode }) => {
    setWidgetMode(mode, mode === "pinned" || mode === "collapsed");
    return commandResult();
  });
  registerIpc(DesktopIpcChannel.WIDGET_POINTER_ENTER, "widget", schemas[DesktopIpcChannel.WIDGET_POINTER_ENTER].request, WidgetCommandResultSchema, () => {
    onWidgetPointerEnter();
    return commandResult();
  });
  registerIpc(DesktopIpcChannel.WIDGET_POINTER_LEAVE, "widget", schemas[DesktopIpcChannel.WIDGET_POINTER_LEAVE].request, WidgetCommandResultSchema, () => {
    onWidgetPointerLeave();
    return commandResult();
  });
  registerIpc(DesktopIpcChannel.WIDGET_FOCUS_WITHIN, "widget", WidgetFocusWithinRequestSchema, WidgetCommandResultSchema, ({ focused }) => {
    onWidgetFocusWithin(focused);
    return commandResult();
  });
  registerIpc(DesktopIpcChannel.WIDGET_POINTER_BEGIN, "widget", schemas[DesktopIpcChannel.WIDGET_POINTER_BEGIN].request, WidgetPointerResultSchema, () => beginWidgetPointer());
  registerIpc(DesktopIpcChannel.WIDGET_POINTER_UPDATE, "widget", schemas[DesktopIpcChannel.WIDGET_POINTER_UPDATE].request, WidgetPointerResultSchema, () => updateWidgetPointer());
  registerIpc(DesktopIpcChannel.WIDGET_POINTER_END, "widget", schemas[DesktopIpcChannel.WIDGET_POINTER_END].request, WidgetPointerResultSchema, () => endWidgetPointer());
  registerIpc(DesktopIpcChannel.SHOW_WIDGET_MENU, "widget", schemas[DesktopIpcChannel.SHOW_WIDGET_MENU].request, ShowWidgetMenuResponseSchema, () => showWidgetMenu());
}

/**
 * Tray must not use `createEmpty()` — Windows shows a blank slot.
 * PNG buffer is embedded so packaged builds (files: dist only) still work.
 */
function createTrayIcon(): unknown {
  const nativeImage = electron.nativeImage as {
    createFromBuffer: (buffer: Buffer) => {
      isEmpty: () => boolean;
      setTemplateImage?: (value: boolean) => void;
    };
    createFromDataURL: (dataUrl: string) => {
      resize: (size: { width: number; height: number }) => {
        setTemplateImage?: (value: boolean) => void;
      };
    };
  };

  // macOS menu bar expects a template (alpha) silhouette.
  if (process.platform === "darwin") {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
      '<rect width="16" height="16" rx="3" fill="black"/>',
      '<rect x="3" y="8" width="2" height="5" rx="1" fill="white"/>',
      '<rect x="7" y="4" width="2" height="9" rx="1" fill="white"/>',
      '<rect x="11" y="6" width="2" height="7" rx="1" fill="white"/>',
      "</svg>"
    ].join("");
    const icon = nativeImage
      .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
      .resize({ width: 16, height: 16 });
    icon.setTemplateImage?.(true);
    return icon;
  }

  // 32×32 PNG: cyan rounded tile + three white metric bars (readable on Win tray).
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWUlEQVR42mNgQAN8S1/+pyVmwAVobTFeh9DbcgxHDKgDBspyuCNGHTDqAHI1ooNRB4w6gFw1ow4YdQADLQ0fdcCoA0YdMOoAmpaEw6JvMHi6ZgPeOR3I7jkAyFX7W9X6QggAAAAASUVORK5CYII=",
    "base64"
  );
  return nativeImage.createFromBuffer(png);
}

function createTray(): void {
  if (!electron.Tray || !electron.nativeImage) {
    return;
  }
  const image = createTrayIcon();
  tray = new electron.Tray(image);
  tray.setToolTip("Agent Metrics");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => showMainWindow() },
    { label: "Show Widget", click: () => showWidget() },
    { label: "Hide Widget", click: () => hideWidget() },
    { label: "Reset Widget Position", click: () => resetWidgetPosition() },
    { type: "separator" },
    { label: "Quit", click: () => quitApp() }
  ]));
  tray.on("click", () => showMainWindow());
}

async function shutdown(): Promise<void> {
  if (shutdownPromise !== null) {
    return shutdownPromise;
  }
  shutdownPromise = (async () => {
    stopWidgetHoverPolling();
    stopWidgetTopmostGuard();
    clearWidgetTimers();
    widgetWindow?.destroy?.();
    mainWindow?.destroy?.();
    tray?.destroy?.();
    await supervisor.stop();
  })();
  return shutdownPromise;
}

function quitApp(): void {
  quitting = true;
  void shutdown().finally(() => app.quit());
}

app.on("before-quit", (event: any) => {
  if (quitting) {
    return;
  }
  event.preventDefault();
  quitApp();
});

// Single-instance guard: a second launch focuses the existing Main window and
// exits the duplicate process rather than racing to create extra Main/Widget
// windows (which would violate the §16.1 "at most one of each" invariant).
const hasSingleInstanceLock = typeof app.requestSingleInstanceLock === "function"
  ? app.requestSingleInstanceLock()
  : true;
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on?.("second-instance", () => {
    // Focus the existing Main window when a second launch is attempted.
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized?.()) {
        mainWindow.restore?.();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
    await mkdir(runtimePaths.dataRoot, { recursive: true });
    await migrateLegacyDataRoots({
      dataRoot: runtimePaths.dataRoot,
      legacyDataRoots: [join(app.getPath("appData"), "Electron", "agent-metrics-data")]
    }).catch((error) => {
      void appendFile(
        join(runtimePaths.dataRoot, "logs", "runtime", "supervisor.log"),
        `${new Date().toISOString()} data-root-migration ${error instanceof Error ? error.message : String(error)}\n`,
        "utf8"
      ).catch(() => undefined);
    });
    await loadSettings();
    app.setLoginItemSettings?.({ openAtLogin: settings.launchAtLogin });
    registerIpcHandlers();
    createMainWindow();
    if (settings.widgetEnabled && settings.showWidgetOnStartup) {
      showWidget();
    }
    createTray();
    screen.on?.("display-metrics-changed", () => {
      widgetAnchorRatio = widgetWindow ? normalizeWidgetAnchor(widgetWindow.getBounds(), getWidgetWorkArea()) : widgetAnchorRatio;
      positionWidget();
    });
    screen.on?.("display-removed", () => {
      positionWidget();
    });
    await supervisor.start();
    if (process.env.AGENT_METRICS_DESKTOP_SMOKE === "1") {
      const windows = enumerateProductWindows({
        mainWindow,
        widgetWindow,
        widgetEnabled: settings.widgetEnabled
      });
      assertProductWindowInvariant(windows);
      if (windows.main === null || (settings.widgetEnabled && windows.widget === null)) {
        throw new Error(
          `Desktop smoke expected Main${settings.widgetEnabled ? "+Widget" : ""} product windows; got count=${windows.count}.`
        );
      }
      let alwaysOnTop: boolean | undefined;
      if (settings.widgetEnabled && widgetWindow && !(widgetWindow.isDestroyed?.() ?? false)) {
        if (typeof widgetWindow.isAlwaysOnTop === "function") {
          alwaysOnTop = Boolean(widgetWindow.isAlwaysOnTop());
          if (!alwaysOnTop) {
            throw new Error("Desktop smoke expected Widget window to be always-on-top.");
          }
        }
      }
      const smokeMarker: { main: boolean; widget: boolean; alwaysOnTop?: boolean } = {
        main: windows.main !== null,
        widget: windows.widget !== null
      };
      if (alwaysOnTop !== undefined) {
        smokeMarker.alwaysOnTop = alwaysOnTop;
      }
      await writeFile(
        join(runtimePaths.dataRoot, "desktop-smoke-ok.json"),
        `${JSON.stringify(smokeMarker, null, 2)}\n`,
        "utf8"
      );
      await shutdown();
      app.quit();
    }
  });
}
