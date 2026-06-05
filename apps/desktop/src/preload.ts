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
  expandOrbDetail: () => ipcRenderer.invoke("desktop:expand-orb-detail").then(() => undefined)
};

contextBridge.exposeInMainWorld("agentMetricsDesktop", desktopBridge);
