import { z } from "zod";

/**
 * Desktop settings, platform info, runtime status, and widget mode contracts.
 * Spec sections 16.8 and 17.
 */

export const WindowBoundsSchema = z.object({
  x: z.number().int().finite(),
  y: z.number().int().finite(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

export const WidgetModeSchema = z.enum(["collapsed", "expanded", "pinned"]);
export const WidgetModeOnStartupSchema = z.enum(["collapsed", "pinned"]);
export const WidgetModeAfterOpenMainSchema = z.enum(["collapsed", "expanded"]);
export const WidgetDockEdgeSchema = z.enum(["left", "right"]);
export const CloseBehaviorSchema = z.enum(["hide-to-tray", "quit-app"]);

/**
 * Version 2 desktop settings. Spec section 16.8.
 * Legacy floating/orb fields are not written by version 2 writers.
 */
export const DesktopSettingsSchema = z.object({
  settingsVersion: z.literal(2),
  closeBehavior: CloseBehaviorSchema,
  launchAtLogin: z.boolean(),
  showMainWindowOnStartup: z.boolean(),
  mainWindowBounds: WindowBoundsSchema.nullable(),
  widgetEnabled: z.boolean(),
  showWidgetOnStartup: z.boolean(),
  widgetModeOnStartup: WidgetModeOnStartupSchema,
  widgetModeAfterOpenMain: WidgetModeAfterOpenMainSchema,
  widgetBounds: WindowBoundsSchema.nullable(),
  widgetDockEdge: WidgetDockEdgeSchema
});

export const DEFAULT_DESKTOP_SETTINGS: z.infer<typeof DesktopSettingsSchema> = {
  settingsVersion: 2,
  closeBehavior: "hide-to-tray",
  launchAtLogin: false,
  showMainWindowOnStartup: true,
  mainWindowBounds: null,
  widgetEnabled: true,
  showWidgetOnStartup: true,
  widgetModeOnStartup: "collapsed",
  widgetModeAfterOpenMain: "collapsed",
  widgetBounds: null,
  widgetDockEdge: "right"
};

export const DesktopPlatformInfoSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("win32"),
    supportsLaunchAtLogin: z.literal(true),
    supportsWidget: z.literal(true)
  }),
  z.object({
    platform: z.literal("darwin"),
    supportsLaunchAtLogin: z.literal(true),
    supportsWidget: z.literal(true)
  })
]);

export const DesktopSettingsViewSchema = DesktopSettingsSchema.and(DesktopPlatformInfoSchema);

export const DesktopSettingsPatchSchema = z
  .object({
    closeBehavior: CloseBehaviorSchema.optional(),
    launchAtLogin: z.boolean().optional(),
    showMainWindowOnStartup: z.boolean().optional(),
    widgetEnabled: z.boolean().optional(),
    showWidgetOnStartup: z.boolean().optional(),
    widgetModeOnStartup: WidgetModeOnStartupSchema.optional(),
    widgetModeAfterOpenMain: WidgetModeAfterOpenMainSchema.optional()
  })
  .strict();

export const ChildNameSchema = z.enum(["watcher", "parser", "core"]);

export const ChildRuntimeStatusSchema = z.object({
  name: ChildNameSchema,
  ownership: z.enum(["managed", "external", "none"]),
  state: z.enum(["starting", "ready", "degraded", "stopped"]),
  pid: z.number().int().positive().nullable(),
  restartCount: z.number().int().nonnegative(),
  lastExit: z
    .object({
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
      at: z.string().datetime()
    })
    .nullable(),
  errorSummary: z.string().nullable()
});

export const RuntimeStatusSchema = z.object({
  state: z.enum(["starting", "ready", "degraded", "stopped"]),
  coreEndpoint: z.string().min(1).nullable(),
  children: z.array(ChildRuntimeStatusSchema),
  lastUpdatedAt: z.string().datetime()
});

export const WidgetPointerResultSchema = z.object({
  activationEligible: z.boolean(),
  dragging: z.boolean()
});

export const WidgetCommandResultSchema = z.object({
  visible: z.boolean(),
  mode: WidgetModeSchema
});

export const WidgetDataStatusSchema = z.enum([
  "loading",
  "ready",
  "syncing",
  "stale",
  "offline",
  "error"
]);

/**
 * Transient Widget interaction flags. Spec section 16.3.
 * Kept separate from WidgetMode and WidgetDataStatus.
 */
export const WidgetInteractionSchema = z.object({
  dragging: z.boolean(),
  pointerInside: z.boolean(),
  keyboardFocusInside: z.boolean()
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type WidgetMode = z.infer<typeof WidgetModeSchema>;
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type DesktopPlatformInfo = z.infer<typeof DesktopPlatformInfoSchema>;
export type DesktopSettingsView = z.infer<typeof DesktopSettingsViewSchema>;
export type DesktopSettingsPatch = z.infer<typeof DesktopSettingsPatchSchema>;
export type ChildName = z.infer<typeof ChildNameSchema>;
export type ChildRuntimeStatus = z.infer<typeof ChildRuntimeStatusSchema>;
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
export type WidgetPointerResult = z.infer<typeof WidgetPointerResultSchema>;
export type WidgetCommandResult = z.infer<typeof WidgetCommandResultSchema>;
export type WidgetDataStatus = z.infer<typeof WidgetDataStatusSchema>;
export type WidgetInteraction = z.infer<typeof WidgetInteractionSchema>;
