const { contextBridge, ipcRenderer } = require("electron") as {
  contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  ipcRenderer: {
    invoke(channel: string, payload?: unknown): Promise<unknown>;
    on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  };
};

const CHANNELS = {
  STATE: "card:state",
  REFRESH: "card:refresh",
  CLOSE: "card:close"
} as const;

const bridge = {
  onState(listener: (state: unknown) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(CHANNELS.STATE, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.STATE, wrapped);
  },
  refresh(): Promise<unknown> {
    return ipcRenderer.invoke(CHANNELS.REFRESH);
  },
  close(): Promise<unknown> {
    return ipcRenderer.invoke(CHANNELS.CLOSE);
  }
};

contextBridge.exposeInMainWorld("agentMetricsCard", bridge);
