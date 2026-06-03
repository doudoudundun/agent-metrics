export type DesktopSurface = "browser" | "desktop-main" | "desktop-floating";

export type AgentMetricsDesktopBridge = {
  getRuntimeStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  showMainWindow: () => Promise<void>;
  toggleFloatingWindow: () => Promise<{ visible: boolean }>;
};

export function resolveDesktopSurface(search: string): {
  isDesktop: boolean;
  surface: DesktopSurface;
} {
  const params = new URLSearchParams(search);
  const surface = params.get("surface");

  if (surface === "desktop-main" || surface === "desktop-floating") {
    return { isDesktop: true, surface };
  }

  return { isDesktop: false, surface: "browser" };
}

export function getAgentMetricsDesktopBridge(
  currentWindow: Window = window
): AgentMetricsDesktopBridge | null {
  return currentWindow.agentMetricsDesktop ?? null;
}

declare global {
  interface Window {
    agentMetricsDesktop?: AgentMetricsDesktopBridge;
  }
}
