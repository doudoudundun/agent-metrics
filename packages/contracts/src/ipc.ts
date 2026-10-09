import { z } from "zod";
import {
  ChildNameSchema,
  DesktopSettingsPatchSchema,
  DesktopSettingsViewSchema,
  DesktopPlatformInfoSchema,
  RuntimeStatusSchema,
  WidgetCommandResultSchema,
  WidgetModeSchema,
  WidgetPointerResultSchema
} from "./desktop.js";

/**
 * Desktop IPC channel constants and payload schemas. Spec section 17.
 *
 * Channel names are literal. Main parses requests and responses; preload parses
 * responses again before returning them. No generic invoke is exposed.
 */

export const DesktopIpcChannel = {
  GET_PLATFORM_INFO: "desktop:get-platform-info",
  GET_RUNTIME_STATUS: "desktop:get-runtime-status",
  GET_SETTINGS: "desktop:get-settings",
  UPDATE_SETTINGS: "desktop:update-settings",
  RESTART_RUNTIME: "desktop:restart-runtime",
  SHOW_MAIN_WINDOW: "desktop:show-main-window",
  HIDE_WIDGET: "desktop:hide-widget",
  SET_WIDGET_MODE: "desktop:set-widget-mode",
  WIDGET_POINTER_ENTER: "desktop:widget-pointer-enter",
  WIDGET_POINTER_LEAVE: "desktop:widget-pointer-leave",
  WIDGET_FOCUS_WITHIN: "desktop:widget-focus-within",
  WIDGET_POINTER_BEGIN: "desktop:widget-pointer-begin",
  WIDGET_POINTER_UPDATE: "desktop:widget-pointer-update",
  WIDGET_POINTER_END: "desktop:widget-pointer-end",
  SHOW_WIDGET_MENU: "desktop:show-widget-menu"
} as const;

export type DesktopIpcChannelName = (typeof DesktopIpcChannel)[keyof typeof DesktopIpcChannel];

export const EmptyIpcRequestSchema = z.undefined().or(z.void()).or(z.object({}).strict());

export const RestartRuntimeRequestSchema = z
  .object({
    child: ChildNameSchema
  })
  .strict();

export const SetWidgetModeRequestSchema = z
  .object({
    mode: WidgetModeSchema
  })
  .strict();

export const WidgetFocusWithinRequestSchema = z
  .object({
    focused: z.boolean()
  })
  .strict();

export const ShowMainWindowResponseSchema = z
  .object({
    visible: z.literal(true)
  })
  .strict();

export const ShowWidgetMenuResponseSchema = z
  .object({
    shown: z.boolean()
  })
  .strict();

/**
 * Map of channel -> { request, response } schemas for runtime validation.
 * Spec section 17 table.
 */
export const DesktopIpcSchemas = {
  [DesktopIpcChannel.GET_PLATFORM_INFO]: {
    request: EmptyIpcRequestSchema,
    response: DesktopPlatformInfoSchema
  },
  [DesktopIpcChannel.GET_RUNTIME_STATUS]: {
    request: EmptyIpcRequestSchema,
    response: RuntimeStatusSchema
  },
  [DesktopIpcChannel.GET_SETTINGS]: {
    request: EmptyIpcRequestSchema,
    response: DesktopSettingsViewSchema
  },
  [DesktopIpcChannel.UPDATE_SETTINGS]: {
    request: DesktopSettingsPatchSchema,
    response: DesktopSettingsViewSchema
  },
  [DesktopIpcChannel.RESTART_RUNTIME]: {
    request: RestartRuntimeRequestSchema,
    response: RuntimeStatusSchema
  },
  [DesktopIpcChannel.SHOW_MAIN_WINDOW]: {
    request: EmptyIpcRequestSchema,
    response: ShowMainWindowResponseSchema
  },
  [DesktopIpcChannel.HIDE_WIDGET]: {
    request: EmptyIpcRequestSchema,
    response: WidgetCommandResultSchema
  },
  [DesktopIpcChannel.SET_WIDGET_MODE]: {
    request: SetWidgetModeRequestSchema,
    response: WidgetCommandResultSchema
  },
  [DesktopIpcChannel.WIDGET_POINTER_ENTER]: {
    request: EmptyIpcRequestSchema,
    response: WidgetCommandResultSchema
  },
  [DesktopIpcChannel.WIDGET_POINTER_LEAVE]: {
    request: EmptyIpcRequestSchema,
    response: WidgetCommandResultSchema
  },
  [DesktopIpcChannel.WIDGET_FOCUS_WITHIN]: {
    request: WidgetFocusWithinRequestSchema,
    response: WidgetCommandResultSchema
  },
  [DesktopIpcChannel.WIDGET_POINTER_BEGIN]: {
    request: EmptyIpcRequestSchema,
    response: WidgetPointerResultSchema
  },
  [DesktopIpcChannel.WIDGET_POINTER_UPDATE]: {
    request: EmptyIpcRequestSchema,
    response: WidgetPointerResultSchema
  },
  [DesktopIpcChannel.WIDGET_POINTER_END]: {
    request: EmptyIpcRequestSchema,
    response: WidgetPointerResultSchema
  },
  [DesktopIpcChannel.SHOW_WIDGET_MENU]: {
    request: EmptyIpcRequestSchema,
    response: ShowWidgetMenuResponseSchema
  }
} as const;

export type RestartRuntimeRequest = z.infer<typeof RestartRuntimeRequestSchema>;
export type SetWidgetModeRequest = z.infer<typeof SetWidgetModeRequestSchema>;
export type WidgetFocusWithinRequest = z.infer<typeof WidgetFocusWithinRequestSchema>;
export type ShowMainWindowResponse = z.infer<typeof ShowMainWindowResponseSchema>;
export type ShowWidgetMenuResponse = z.infer<typeof ShowWidgetMenuResponseSchema>;
