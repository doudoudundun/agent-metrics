export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopSettings = {
  closeBehavior: "hide-to-tray" | "quit-app";
  launchAtLogin: boolean;
  showMainWindowOnStartup: boolean;
  reopenFloatingWindowOnStartup: boolean;
  preferredSurface: "main-window" | "floating-window";
  mainWindowBounds: WindowBounds | null;
  floatingWindowBounds: WindowBounds | null;
};

type UnknownRecord = Record<string, unknown>;

export function defaultDesktopSettings(): DesktopSettings {
  return {
    closeBehavior: "hide-to-tray",
    launchAtLogin: false,
    showMainWindowOnStartup: true,
    reopenFloatingWindowOnStartup: false,
    preferredSurface: "main-window",
    mainWindowBounds: null,
    floatingWindowBounds: { x: 80, y: 80, width: 440, height: 320 }
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function sanitizeWindowBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) {
    return null;
  }

  const { x, y, width, height } = value;

  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return { x, y, width, height };
}

export function sanitizeDesktopSettings(value: unknown): DesktopSettings {
  const defaults = defaultDesktopSettings();

  if (!isRecord(value)) {
    return defaults;
  }

  return {
    closeBehavior:
      value.closeBehavior === "hide-to-tray" || value.closeBehavior === "quit-app"
        ? value.closeBehavior
        : defaults.closeBehavior,
    launchAtLogin:
      typeof value.launchAtLogin === "boolean" ? value.launchAtLogin : defaults.launchAtLogin,
    showMainWindowOnStartup:
      typeof value.showMainWindowOnStartup === "boolean"
        ? value.showMainWindowOnStartup
        : defaults.showMainWindowOnStartup,
    reopenFloatingWindowOnStartup:
      typeof value.reopenFloatingWindowOnStartup === "boolean"
        ? value.reopenFloatingWindowOnStartup
        : defaults.reopenFloatingWindowOnStartup,
    preferredSurface:
      value.preferredSurface === "main-window" || value.preferredSurface === "floating-window"
        ? value.preferredSurface
        : defaults.preferredSurface,
    mainWindowBounds: sanitizeWindowBounds(value.mainWindowBounds),
    floatingWindowBounds:
      sanitizeWindowBounds(value.floatingWindowBounds) ?? defaults.floatingWindowBounds
  };
}

export function clampBoundsToDisplay(
  bounds: WindowBounds,
  display: WindowBounds
): WindowBounds {
  return {
    x: Math.max(display.x, Math.min(bounds.x, display.x + display.width - bounds.width)),
    y: Math.max(display.y, Math.min(bounds.y, display.y + display.height - bounds.height)),
    width: Math.min(bounds.width, display.width),
    height: Math.min(bounds.height, display.height)
  };
}
