type AgentMetricsDesktopBridge = {
  getRuntimeStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  showMainWindow: () => Promise<void>;
  toggleFloatingWindow: () => Promise<{ visible: boolean }>;
  showOrb: () => Promise<void>;
  hideOrb: () => Promise<void>;
  pinPeekCard: () => Promise<{ pinned: boolean }>;
  togglePeekCardPin: () => Promise<{ pinned: boolean }>;
  expandOrbDetail: () => Promise<void>;
  getOrbSnapshot: () => Promise<unknown>;
  setOrbSnapshot: (snapshot: Record<string, unknown>) => Promise<void>;
  markOrbStale: () => Promise<void>;
  peekEnter: () => Promise<void>;
  peekLeave: () => Promise<void>;
  orbDragStart: () => Promise<void>;
  orbDragMove: () => Promise<void>;
  orbDragEnd: () => Promise<void>;
  showOrbMenu: () => Promise<void>;
};

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
  pinPeekCard: () =>
    ipcRenderer.invoke("desktop:pin-peek-card") as Promise<{ pinned: boolean }>,
  togglePeekCardPin: () =>
    ipcRenderer.invoke("desktop:toggle-peek-card-pin") as Promise<{ pinned: boolean }>,
  expandOrbDetail: () => ipcRenderer.invoke("desktop:expand-orb-detail").then(() => undefined),
  getOrbSnapshot: () => ipcRenderer.invoke("desktop:get-orb-snapshot"),
  setOrbSnapshot: (snapshot) =>
    ipcRenderer.invoke("desktop:set-orb-snapshot", snapshot).then(() => undefined),
  markOrbStale: () => ipcRenderer.invoke("desktop:mark-orb-stale").then(() => undefined),
  peekEnter: () => ipcRenderer.invoke("desktop:peek-enter").then(() => undefined),
  peekLeave: () => ipcRenderer.invoke("desktop:peek-leave").then(() => undefined),
  orbDragStart: () => ipcRenderer.invoke("desktop:orb-drag-start").then(() => undefined),
  orbDragMove: () => ipcRenderer.invoke("desktop:orb-drag-move").then(() => undefined),
  orbDragEnd: () => ipcRenderer.invoke("desktop:orb-drag-end").then(() => undefined),
  showOrbMenu: () => ipcRenderer.invoke("desktop:show-orb-menu").then(() => undefined)
};

contextBridge.exposeInMainWorld("agentMetricsDesktop", desktopBridge);
