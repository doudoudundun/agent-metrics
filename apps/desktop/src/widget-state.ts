import type { WidgetDataStatus, WidgetMode } from "@agent-metrics/contracts";

export const OPEN_DELAY_MS = 120;
export const CLOSE_DELAY_MS = 300;
export const DRAG_THRESHOLD_PX = 5;
export const ACTIVATION_SUPPRESSION_MS = 250;

export type WidgetInteraction = {
  dragging: boolean;
  pointerInside: boolean;
  keyboardFocusInside: boolean;
};

export type WidgetState = {
  visible: boolean;
  mode: WidgetMode;
  dataStatus: WidgetDataStatus;
  interaction: WidgetInteraction;
};

export type WidgetEvent =
  | { type: "pointer-enter" }
  | { type: "pointer-leave" }
  | { type: "focus-within"; focused: boolean }
  | { type: "pointer-begin" }
  | { type: "pointer-end"; activationEligible: boolean }
  | { type: "pin" }
  | { type: "unpin" }
  | { type: "hide" }
  | { type: "show" }
  | { type: "set-data-status"; status: WidgetDataStatus }
  | { type: "open-main"; mode: "collapsed" | "expanded" };

export function createWidgetState(
  mode: WidgetMode = "collapsed",
  dataStatus: WidgetDataStatus = "loading"
): WidgetState {
  return {
    visible: true,
    mode,
    dataStatus,
    interaction: {
      dragging: false,
      pointerInside: false,
      keyboardFocusInside: false
    }
  };
}

export function reduceWidgetState(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.type) {
    case "pointer-enter":
      return withInteraction(state, { pointerInside: true });
    case "pointer-leave":
      return withInteraction(state, { pointerInside: false });
    case "focus-within":
      return withInteraction(state, { keyboardFocusInside: event.focused });
    case "pointer-begin":
      return withInteraction(state, { dragging: true });
    case "pointer-end":
      return withInteraction(state, { dragging: false });
    case "pin":
      return { ...state, mode: "pinned", visible: true, interaction: idleInteraction() };
    case "unpin":
      return { ...state, mode: "expanded" };
    case "hide":
      return { ...state, visible: false, interaction: idleInteraction() };
    case "show":
      return { ...state, visible: true };
    case "set-data-status":
      return { ...state, dataStatus: event.status };
    case "open-main":
      return { ...state, mode: event.mode };
    default:
      return state;
  }
}

export function shouldCollapse(state: WidgetState): boolean {
  // Hover retract is driven by cursor leave. Keyboard focus must not keep the
  // expanded surface stuck open after a button click (common on Windows).
  return (
    state.mode === "expanded" &&
    !state.interaction.dragging &&
    !state.interaction.pointerInside
  );
}

export function shouldOpen(state: WidgetState): boolean {
  return state.mode === "collapsed" && state.visible && !state.interaction.dragging &&
    (state.interaction.pointerInside || state.interaction.keyboardFocusInside);
}

/**
 * Spec section 16.5: a renderer reload/crash preserves controller mode, normalized
 * anchor, and visibility and recreates/reloads at most the existing single
 * BrowserWindow. This pure helper decides the post-reload controller state from
 * persisted settings and the pre-reload state. The anchor ratio is owned by the
 * controller and is not part of widget state, so callers preserve it separately.
 *
 * On a benign reload (`reason !== "crashed"`), the in-flight mode/visibility are
 * kept. On a crash, transient interaction flags are cleared (a crashed renderer
 * cannot be mid-drag or holding pointer/focus), the persisted `widgetModeOnStartup`
 * is re-asserted, and a hidden-before-crash widget stays hidden.
 */
export function recoverWidgetStateAfterReload(
  previous: WidgetState,
  persistedMode: "collapsed" | "pinned",
  reason: "reload" | "crashed"
): WidgetState {
  if (reason !== "crashed") {
    return { ...previous, interaction: idleInteraction() };
  }
  return {
    visible: previous.visible,
    mode: persistedMode,
    dataStatus: previous.dataStatus,
    interaction: idleInteraction()
  };
}

function withInteraction(
  state: WidgetState,
  patch: Partial<WidgetInteraction>
): WidgetState {
  return {
    ...state,
    interaction: { ...state.interaction, ...patch }
  };
}

function idleInteraction(): WidgetInteraction {
  return { dragging: false, pointerInside: false, keyboardFocusInside: false };
}
