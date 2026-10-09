import { describe, expect, it } from "vitest";
import {
  ACTIVATION_SUPPRESSION_MS,
  CLOSE_DELAY_MS,
  DRAG_THRESHOLD_PX,
  OPEN_DELAY_MS,
  createWidgetState,
  reduceWidgetState,
  recoverWidgetStateAfterReload,
  shouldCollapse,
  shouldOpen
} from "./widget-state.js";

describe("widget state", () => {
  it("pins interaction constants from section 16.4", () => {
    expect(OPEN_DELAY_MS).toBe(120);
    expect(CLOSE_DELAY_MS).toBe(300);
    expect(DRAG_THRESHOLD_PX).toBe(5);
    expect(ACTIVATION_SUPPRESSION_MS).toBe(250);
  });

  it("opens only after pointer/focus interaction is eligible", () => {
    const state = createWidgetState();
    expect(shouldOpen(state)).toBe(false);
    const entered = reduceWidgetState(state, { type: "pointer-enter" });
    expect(shouldOpen(entered)).toBe(true);
    expect(shouldCollapse(entered)).toBe(false);
  });

  it("collapses expanded mode after pointer leaves even if keyboard focus lingered", () => {
    const expanded = reduceWidgetState(
      reduceWidgetState(createWidgetState("expanded"), { type: "pointer-enter" }),
      { type: "focus-within", focused: true }
    );
    const left = reduceWidgetState(expanded, { type: "pointer-leave" });
    expect(shouldCollapse(left)).toBe(true);
    expect(left.mode).toBe("expanded");
    expect(left.interaction.keyboardFocusInside).toBe(true);
  });

  it("section 16.4: collapsed stays collapsed while dragging", () => {
    const dragging = reduceWidgetState(createWidgetState("collapsed"), { type: "pointer-begin" });
    expect(dragging).toMatchObject({ mode: "collapsed", interaction: { dragging: true } });
    expect(shouldOpen(dragging)).toBe(false);
  });

  it("section 16.4: expanded pins on explicit pin event", () => {
    const expanded = createWidgetState("expanded");
    const pinned = reduceWidgetState(expanded, { type: "pin" });
    expect(pinned.mode).toBe("pinned");
    expect(pinned.interaction).toEqual({
      dragging: false,
      pointerInside: false,
      keyboardFocusInside: false
    });
  });

  it("section 16.4: collapsed pins on explicit pin event (click without drag)", () => {
    const pinned = reduceWidgetState(createWidgetState("collapsed"), { type: "pin" });
    expect(pinned.mode).toBe("pinned");
    expect(pinned.visible).toBe(true);
  });

  it("section 16.4: open-main from expanded applies configured mode without startup side effects", () => {
    const expanded = createWidgetState("expanded");
    expect(reduceWidgetState(expanded, { type: "open-main", mode: "collapsed" }).mode).toBe(
      "collapsed"
    );
    expect(reduceWidgetState(expanded, { type: "open-main", mode: "expanded" }).mode).toBe(
      "expanded"
    );
  });

  it("section 16.4: show restores visibility without changing mode", () => {
    const hidden = reduceWidgetState(createWidgetState("pinned"), { type: "hide" });
    const shown = reduceWidgetState(hidden, { type: "show" });
    expect(shown).toMatchObject({ visible: true, mode: "pinned" });
  });

  it("keeps pinned mode open after pointer and focus leave", () => {
    const pinned = reduceWidgetState(createWidgetState(), { type: "pin" });
    const left = reduceWidgetState(
      reduceWidgetState(pinned, { type: "pointer-leave" }),
      { type: "focus-within", focused: false }
    );
    expect(left.mode).toBe("pinned");
    expect(shouldCollapse(left)).toBe(false);
  });

  it("unpins to expanded and open-main uses configured mode", () => {
    const pinned = reduceWidgetState(createWidgetState(), { type: "pin" });
    expect(reduceWidgetState(pinned, { type: "unpin" }).mode).toBe("expanded");
    expect(reduceWidgetState(pinned, { type: "open-main", mode: "collapsed" }).mode).toBe(
      "collapsed"
    );
  });

  it("separates drag state from activation and hides without changing mode", () => {
    const pinned = reduceWidgetState(createWidgetState(), { type: "pin" });
    const dragging = reduceWidgetState(pinned, { type: "pointer-begin" });
    const finished = reduceWidgetState(dragging, { type: "pointer-end", activationEligible: false });
    const hidden = reduceWidgetState(finished, { type: "hide" });
    expect(finished.interaction.dragging).toBe(false);
    expect(hidden).toMatchObject({ visible: false, mode: "pinned" });
  });

  it("tracks data status independently from mode", () => {
    const ready = reduceWidgetState(createWidgetState(), {
      type: "set-data-status",
      status: "ready"
    });
    expect(ready.dataStatus).toBe("ready");
    expect(ready.mode).toBe("collapsed");
  });

  it("section 16.5: benign reload preserves controller mode and visibility", () => {
    const expanded = reduceWidgetState(createWidgetState("expanded"), {
      type: "set-data-status",
      status: "ready"
    });
    const recovered = recoverWidgetStateAfterReload(expanded, "collapsed", "reload");
    expect(recovered).toMatchObject({ mode: "expanded", visible: true, dataStatus: "ready" });
    expect(recovered.interaction).toEqual({
      dragging: false,
      pointerInside: false,
      keyboardFocusInside: false
    });
  });

  it("section 16.5: crash clears transient interaction, re-asserts persisted mode, keeps prior visibility", () => {
    const midDrag = reduceWidgetState(
      reduceWidgetState(createWidgetState("expanded"), { type: "pointer-enter" }),
      { type: "pointer-begin" }
    );
    const recovered = recoverWidgetStateAfterReload(midDrag, "collapsed", "crashed");
    // Persisted startup mode wins over the in-flight expanded mode on crash.
    expect(recovered.mode).toBe("collapsed");
    // Visibility is preserved (controller owns it; renderer crash must not hide).
    expect(recovered.visible).toBe(true);
    // Transient interaction flags reset; a crashed renderer cannot be mid-drag.
    expect(recovered.interaction).toEqual({
      dragging: false,
      pointerInside: false,
      keyboardFocusInside: false
    });
  });

  it("section 16.5: a hidden widget stays hidden after a crash", () => {
    const hidden = reduceWidgetState(createWidgetState("pinned"), { type: "hide" });
    expect(recoverWidgetStateAfterReload(hidden, "pinned", "crashed").visible).toBe(false);
  });
});
