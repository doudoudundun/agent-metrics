import { createRequire } from "node:module";

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
  getOrbSnapshot: () => Promise<unknown>;
  setOrbSnapshot: (snapshot: Record<string, unknown>) => Promise<void>;
  markOrbStale: () => Promise<void>;
  peekEnter: () => Promise<void>;
  peekLeave: () => Promise<void>;
  orbDragStart: (offset: { x: number; y: number }) => Promise<void>;
  orbDragMove: (screenPoint: { x: number; y: number }) => Promise<void>;
  orbDragEnd: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require("electron") as {
  contextBridge: {
    exposeInMainWorld: (name: string, api: AgentMetricsDesktopBridge) => void;
  };
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
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
  expandOrbDetail: () => ipcRenderer.invoke("desktop:expand-orb-detail").then(() => undefined),
  getOrbSnapshot: () => ipcRenderer.invoke("desktop:get-orb-snapshot"),
  setOrbSnapshot: (snapshot) =>
    ipcRenderer.invoke("desktop:set-orb-snapshot", snapshot).then(() => undefined),
  markOrbStale: () => ipcRenderer.invoke("desktop:mark-orb-stale").then(() => undefined),
  peekEnter: () => ipcRenderer.invoke("desktop:peek-enter").then(() => undefined),
  peekLeave: () => ipcRenderer.invoke("desktop:peek-leave").then(() => undefined),
  orbDragStart: (offset) => ipcRenderer.invoke("desktop:orb-drag-start", offset).then(() => undefined),
  orbDragMove: (screenPoint) =>
    ipcRenderer.invoke("desktop:orb-drag-move", screenPoint).then(() => undefined),
  orbDragEnd: () => ipcRenderer.invoke("desktop:orb-drag-end").then(() => undefined)
};

contextBridge.exposeInMainWorld("agentMetricsDesktop", desktopBridge);
