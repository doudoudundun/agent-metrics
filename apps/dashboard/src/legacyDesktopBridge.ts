/**
 * Legacy orb / peek / floating preload bridge (pre-Phase-7 multi-window desktop).
 * Only used by LegacyDesktopSurfaces; the v2 Main/Widget path must not depend on these APIs.
 */
export type LegacyDesktopBridge = {
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
  showOrbMenu?: () => Promise<void>;
};

/** @deprecated Use LegacyDesktopBridge */
export type AgentMetricsDesktopBridge = LegacyDesktopBridge;

export function getLegacyDesktopBridge(
  currentWindow: Window = window
): LegacyDesktopBridge | null {
  const bridge = currentWindow.agentMetricsDesktop as LegacyDesktopBridge | undefined;

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
    typeof bridge.togglePeekCardPin !== "function" ||
    typeof bridge.expandOrbDetail !== "function" ||
    typeof bridge.getOrbSnapshot !== "function" ||
    typeof bridge.setOrbSnapshot !== "function" ||
    typeof bridge.markOrbStale !== "function" ||
    typeof bridge.peekEnter !== "function" ||
    typeof bridge.peekLeave !== "function" ||
    typeof bridge.orbDragStart !== "function" ||
    typeof bridge.orbDragMove !== "function" ||
    typeof bridge.orbDragEnd !== "function"
  ) {
    return null;
  }

  return bridge;
}
