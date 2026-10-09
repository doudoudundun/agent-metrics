export type DesktopSurface =
  | "browser"
  | "desktop-main"
  | "desktop-floating"
  | "desktop-orb"
  | "desktop-orb-peek"
  | "desktop-widget";

/** Main window bridge exposed by preload-v2 (no orb/peek/floating APIs). */
export type AgentMetricsMainBridge = {
  getRuntimeStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  showMainWindow: () => Promise<{ visible: true } | void>;
  restartRuntime?: (child: "watcher" | "parser" | "core") => Promise<unknown>;
  getLocalAccessToken?: () => string;
};

export type AgentMetricsWidgetBridge = {
  getPlatformInfo: () => Promise<unknown>;
  getSettings?: () => Promise<unknown>;
  showMainWindow: () => Promise<{ visible: true }>;
  hideWidget: () => Promise<{ visible: boolean; mode: "collapsed" | "expanded" | "pinned" }>;
  setWidgetMode: (mode: "collapsed" | "expanded" | "pinned") => Promise<unknown>;
  pointerEnter: () => Promise<unknown>;
  pointerLeave: () => Promise<unknown>;
  focusWithin: (focused: boolean) => Promise<unknown>;
  pointerBegin: () => Promise<unknown>;
  pointerUpdate: () => Promise<unknown>;
  pointerEnd: () => Promise<unknown>;
  showWidgetMenu: () => Promise<unknown>;
  getLocalAccessToken?: () => string;
};

export function resolveDesktopSurface(search: string): {
  isDesktop: boolean;
  surface: DesktopSurface;
} {
  const params = new URLSearchParams(search);
  const surface = params.get("surface");

  if (
    surface === "desktop-main" ||
    surface === "desktop-floating" ||
    surface === "desktop-orb" ||
    surface === "desktop-orb-peek" ||
    surface === "desktop-widget"
  ) {
    return { isDesktop: true, surface };
  }

  return { isDesktop: false, surface: "browser" };
}

export function getAgentMetricsMainBridge(
  currentWindow: Window = window
): AgentMetricsMainBridge | null {
  const bridge = currentWindow.agentMetricsDesktop as AgentMetricsMainBridge | undefined;

  if (!bridge) {
    return null;
  }

  if (
    typeof bridge.getRuntimeStatus !== "function" ||
    typeof bridge.getSettings !== "function" ||
    typeof bridge.updateSettings !== "function" ||
    typeof bridge.showMainWindow !== "function"
  ) {
    return null;
  }

  return bridge;
}

export function getAgentMetricsWidgetBridge(
  currentWindow: Window = window
): AgentMetricsWidgetBridge | null {
  const bridge = currentWindow.agentMetricsDesktop as AgentMetricsWidgetBridge | undefined;
  if (
    !bridge ||
    typeof bridge.getPlatformInfo !== "function" ||
    typeof bridge.showMainWindow !== "function" ||
    typeof bridge.hideWidget !== "function" ||
    typeof bridge.setWidgetMode !== "function" ||
    typeof bridge.pointerEnter !== "function" ||
    typeof bridge.pointerLeave !== "function" ||
    typeof bridge.focusWithin !== "function" ||
    typeof bridge.pointerBegin !== "function" ||
    typeof bridge.pointerUpdate !== "function" ||
    typeof bridge.pointerEnd !== "function" ||
    typeof bridge.showWidgetMenu !== "function"
  ) {
    return null;
  }
  return bridge;
}

export function getLocalAccessToken(currentWindow: Window = window): string | null {
  const bridge = currentWindow.agentMetricsDesktop as
    | { getLocalAccessToken?: () => string }
    | undefined;
  const token = bridge?.getLocalAccessToken?.();
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  return null;
}

declare global {
  interface Window {
    agentMetricsDesktop?: AgentMetricsMainBridge | AgentMetricsWidgetBridge;
  }
}
