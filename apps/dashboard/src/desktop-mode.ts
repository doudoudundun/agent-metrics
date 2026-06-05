export type DesktopSurface = "browser" | "desktop-main" | "desktop-floating";

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
  const bridge = currentWindow.agentMetricsDesktop;

  if (!bridge) {
    return null;
  }

  if (
    typeof bridge.getRuntimeStatus !== "function" ||
    typeof bridge.getSettings !== "function" ||
    typeof bridge.updateSettings !== "function" ||
    typeof bridge.showMainWindow !== "function" ||
    typeof bridge.toggleFloatingWindow !== "function" ||
    typeof bridge.showOrb !== "function" ||
    typeof bridge.hideOrb !== "function" ||
    typeof bridge.pinPeekCard !== "function" ||
    typeof bridge.expandOrbDetail !== "function"
  ) {
    return null;
  }

  return bridge;
}

declare global {
  interface Window {
    agentMetricsDesktop?: AgentMetricsDesktopBridge;
  }
}
