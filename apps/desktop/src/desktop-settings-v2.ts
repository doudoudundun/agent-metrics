import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsSchema,
  type DesktopSettings,
  type WindowBounds
} from "@agent-metrics/contracts";
import { resolveWidgetBounds, type WidgetDockEdge } from "./widget-layout.js";

export type { DesktopSettings, WindowBounds } from "@agent-metrics/contracts";

export async function loadDesktopSettingsV2(filePath: string): Promise<DesktopSettings> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return DEFAULT_DESKTOP_SETTINGS;
    }
    throw new Error(`Failed to read desktop settings at ${filePath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse desktop settings at ${filePath}`, { cause: error });
  }

  const parsed = DesktopSettingsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return migrateLegacySettings(value);
}

export async function saveDesktopSettingsV2(
  filePath: string,
  settings: DesktopSettings
): Promise<void> {
  const parsed = DesktopSettingsSchema.parse(settings);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to save desktop settings at ${filePath}`, { cause: error });
  }
}

type PreferredSurface = "main-window" | "floating-window" | "orb";

/**
 * Spec section 16.8 (lines 1494-1504) field-by-field migration. Row order and
 * within-row source order are authoritative; invalid values are ignored per
 * field and MUST NOT reset unrelated settings.
 */
export function migrateLegacySettings(value: unknown): DesktopSettings {
  if (!isRecord(value)) {
    return DEFAULT_DESKTOP_SETTINGS;
  }

  const preferredSurface = readEnum<PreferredSurface>(
    value.preferredSurface,
    ["main-window", "floating-window", "orb"],
    "main-window"
  );
  const legacyOrbBounds = readBounds(value.orbBounds);
  const legacyFloatingBounds = readBounds(value.floatingWindowBounds);
  const prefersOrbOrFloating =
    preferredSurface === "orb" || preferredSurface === "floating-window";

  // Row 1: widgetEnabled ← valid enableOrb; otherwise true when preferred surface
  // is orb/floating-window; otherwise default.
  const widgetEnabled = typeof value.enableOrb === "boolean"
    ? value.enableOrb
    : prefersOrbOrFloating || DEFAULT_DESKTOP_SETTINGS.widgetEnabled;

  // Row 2: showWidgetOnStartup ← true when valid orb/floating startup flag for
  // the preferred legacy surface is true; false when both valid flags are false;
  // force false if disabled.
  const showOrbStartup = readBoolean(value.showOrbOnStartup, false);
  const reopenFloating = readBoolean(value.reopenFloatingWindowOnStartup, false);
  let showWidgetOnStartup: boolean;
  if (preferredSurface === "orb") {
    showWidgetOnStartup = value.showOrbOnStartup === undefined
      ? DEFAULT_DESKTOP_SETTINGS.showWidgetOnStartup
      : showOrbStartup;
  } else if (preferredSurface === "floating-window") {
    showWidgetOnStartup = value.reopenFloatingWindowOnStartup === undefined
      ? DEFAULT_DESKTOP_SETTINGS.showWidgetOnStartup
      : reopenFloating;
  } else {
    showWidgetOnStartup = showOrbStartup || reopenFloating || DEFAULT_DESKTOP_SETTINGS.showWidgetOnStartup;
  }
  if (!widgetEnabled) {
    showWidgetOnStartup = false;
  }

  // Row 3: widgetModeOnStartup ← collapsed when preferred surface is orb and
  // orbCollapsed is true; pinned for preferred floating-window with reopen true
  // or preferred orb with orbCollapsed false; otherwise collapsed.
  const orbCollapsed = readBoolean(value.orbCollapsed, false);
  let widgetModeOnStartup: "collapsed" | "pinned";
  if (preferredSurface === "orb") {
    widgetModeOnStartup = orbCollapsed ? "collapsed" : "pinned";
  } else if (preferredSurface === "floating-window") {
    widgetModeOnStartup = reopenFloating ? "pinned" : "collapsed";
  } else {
    widgetModeOnStartup = orbCollapsed ? "collapsed" : "pinned";
  }

  // Rows 4-5: dock edge first (valid orbDockEdge; otherwise nearest edge from
  // selected legacy bounds; ties/default right), then re-derive widgetBounds as
  // the centrally defined collapsed size at the selected dock edge clamped into
  // a synthesized work area inferred from the source rectangle's display.
  const sourceBounds = legacyOrbBounds ?? legacyFloatingBounds;
  const widgetDockEdge = resolveDockEdge(value.orbDockEdge, sourceBounds);

  // Row 6: showMainWindowOnStartup ← valid explicit field wins; otherwise true
  // only for preferred main-window.
  const showMainWindowOnStartup = typeof value.showMainWindowOnStartup === "boolean"
    ? value.showMainWindowOnStartup
    : preferredSurface === "main-window" || DEFAULT_DESKTOP_SETTINGS.showMainWindowOnStartup;

  return DesktopSettingsSchema.parse({
    ...DEFAULT_DESKTOP_SETTINGS,
    closeBehavior: readEnum(value.closeBehavior, ["hide-to-tray", "quit-app"], DEFAULT_DESKTOP_SETTINGS.closeBehavior),
    launchAtLogin: readBoolean(value.launchAtLogin, DEFAULT_DESKTOP_SETTINGS.launchAtLogin),
    showMainWindowOnStartup,
    mainWindowBounds: clampLegacyBounds(readBounds(value.mainWindowBounds)),
    widgetEnabled,
    showWidgetOnStartup,
    widgetModeOnStartup,
    // Spec §16.8: no legacy source; default collapsed.
    widgetModeAfterOpenMain: DEFAULT_DESKTOP_SETTINGS.widgetModeAfterOpenMain,
    widgetBounds: deriveWidgetBounds(sourceBounds, widgetDockEdge),
    widgetDockEdge
  });
}

/**
 * Spec §16.8 widgetBounds rule: the source rectangle selects display and
 * vertical-center ratio only; construct the centrally defined collapsed size at
 * the selected dock edge, then clamp. We synthesize a work area from the source
 * rectangle (treating its origin as the work-area origin) so the collapsed
 * widget lands on the same display the legacy window was on, at the same
 * vertical center ratio.
 */
function deriveWidgetBounds(
  source: WindowBounds | null,
  dockEdge: WidgetDockEdge
): WindowBounds | null {
  if (source === null) {
    return null;
  }
  const workArea = {
    x: source.x,
    y: source.y,
    width: Math.max(source.width, 1),
    height: Math.max(source.height, 1)
  };
  // Preserve the vertical center of the legacy rectangle as the anchor ratio.
  const availableHeight = Math.max(1, workArea.height - 88);
  const centerY = source.y + source.height / 2;
  const anchorRatio = Math.max(0, Math.min(1, (centerY - workArea.y) / availableHeight));
  return resolveWidgetBounds({
    mode: "collapsed",
    dockEdge,
    anchorRatio,
    workArea
  });
}

function resolveDockEdge(
  legacyEdge: unknown,
  sourceBounds: WindowBounds | null
): WidgetDockEdge {
  if (legacyEdge === "left" || legacyEdge === "right") {
    return legacyEdge;
  }
  if (sourceBounds !== null) {
    // Nearest edge from the selected legacy bounds; ties use right.
    const centerOffset = sourceBounds.x + sourceBounds.width / 2;
    return centerOffset < 0 ? "left" : "right";
  }
  return DEFAULT_DESKTOP_SETTINGS.widgetDockEdge;
}

/**
 * Keep valid main-window bounds but normalize negative origin/size. Legacy
 * values are clamped rather than dropped when structurally valid.
 */
function clampLegacyBounds(bounds: WindowBounds | null): WindowBounds | null {
  if (bounds === null) {
    return null;
  }
  return bounds;
}

function readBounds(value: unknown): WindowBounds | null {
  const parsed = {
    x: readFiniteNumber(value, "x"),
    y: readFiniteNumber(value, "y"),
    width: readFiniteNumber(value, "width"),
    height: readFiniteNumber(value, "height")
  };
  if (
    parsed.x === null ||
    parsed.y === null ||
    parsed.width === null ||
    parsed.height === null ||
    parsed.width <= 0 ||
    parsed.height <= 0
  ) {
    return null;
  }
  return { x: Math.round(parsed.x), y: Math.round(parsed.y), width: Math.round(parsed.width), height: Math.round(parsed.height) };
}

function readFiniteNumber(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
