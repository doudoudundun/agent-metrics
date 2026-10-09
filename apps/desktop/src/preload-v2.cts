/**
 * Sandboxed preload: keep this file free of workspace package imports.
 * Main process already validates IPC payloads with Zod.
 */
const { contextBridge, ipcRenderer } = require("electron") as {
  contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  ipcRenderer: { invoke(channel: string, payload?: unknown): Promise<unknown> };
};

function readFlag(prefix: string): string {
  const arg = process.argv.find((item: string) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

const localAccessToken = readFlag("--agent-metrics-token=");

const DesktopIpcChannel = {
  GET_PLATFORM_INFO: "desktop:get-platform-info",
  GET_RUNTIME_STATUS: "desktop:get-runtime-status",
  GET_SETTINGS: "desktop:get-settings",
  UPDATE_SETTINGS: "desktop:update-settings",
  RESTART_RUNTIME: "desktop:restart-runtime",
  SHOW_MAIN_WINDOW: "desktop:show-main-window",
  HIDE_WIDGET: "desktop:hide-widget",
  SET_WIDGET_MODE: "desktop:set-widget-mode",
  WIDGET_POINTER_ENTER: "desktop:widget-pointer-enter",
  WIDGET_POINTER_LEAVE: "desktop:widget-pointer-leave",
  WIDGET_FOCUS_WITHIN: "desktop:widget-focus-within",
  WIDGET_POINTER_BEGIN: "desktop:widget-pointer-begin",
  WIDGET_POINTER_UPDATE: "desktop:widget-pointer-update",
  WIDGET_POINTER_END: "desktop:widget-pointer-end",
  SHOW_WIDGET_MENU: "desktop:show-widget-menu"
} as const;

const bridge = {
  getPlatformInfo: () => ipcRenderer.invoke(DesktopIpcChannel.GET_PLATFORM_INFO, {}),
  getRuntimeStatus: () => ipcRenderer.invoke(DesktopIpcChannel.GET_RUNTIME_STATUS, {}),
  getSettings: () => ipcRenderer.invoke(DesktopIpcChannel.GET_SETTINGS, {}),
  updateSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke(DesktopIpcChannel.UPDATE_SETTINGS, patch),
  restartRuntime: (child: "watcher" | "parser" | "core") =>
    ipcRenderer.invoke(DesktopIpcChannel.RESTART_RUNTIME, { child }),
  showMainWindow: () => ipcRenderer.invoke(DesktopIpcChannel.SHOW_MAIN_WINDOW, {}),
  hideWidget: () => ipcRenderer.invoke(DesktopIpcChannel.HIDE_WIDGET, {}),
  setWidgetMode: (mode: "collapsed" | "expanded" | "pinned") =>
    ipcRenderer.invoke(DesktopIpcChannel.SET_WIDGET_MODE, { mode }),
  pointerEnter: () => ipcRenderer.invoke(DesktopIpcChannel.WIDGET_POINTER_ENTER, {}),
  pointerLeave: () => ipcRenderer.invoke(DesktopIpcChannel.WIDGET_POINTER_LEAVE, {}),
  focusWithin: (focused: boolean) =>
    ipcRenderer.invoke(DesktopIpcChannel.WIDGET_FOCUS_WITHIN, { focused }),
  pointerBegin: () => ipcRenderer.invoke(DesktopIpcChannel.WIDGET_POINTER_BEGIN, {}),
  pointerUpdate: () => ipcRenderer.invoke(DesktopIpcChannel.WIDGET_POINTER_UPDATE, {}),
  pointerEnd: () => ipcRenderer.invoke(DesktopIpcChannel.WIDGET_POINTER_END, {}),
  showWidgetMenu: () => ipcRenderer.invoke(DesktopIpcChannel.SHOW_WIDGET_MENU, {}),
  getLocalAccessToken: () => localAccessToken
};

contextBridge.exposeInMainWorld("agentMetricsDesktop", bridge);
contextBridge.exposeInMainWorld("agentMetricsDesktopReady", true);
