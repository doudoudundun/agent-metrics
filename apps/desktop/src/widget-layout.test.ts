import { describe, expect, it } from "vitest";
import { clampWidgetBounds, normalizeWidgetAnchor, resolveWidgetBounds } from "./widget-layout.js";

const workArea = { x: 100, y: 50, width: 1200, height: 800 };

describe("widget layout", () => {
  it("places collapsed widget on either dock edge and preserves the anchor", () => {
    expect(resolveWidgetBounds({ mode: "collapsed", dockEdge: "left", anchorRatio: 0.5, workArea })).toEqual({
      x: 100,
      y: 406,
      width: 88,
      height: 88
    });
    expect(resolveWidgetBounds({ mode: "collapsed", dockEdge: "right", anchorRatio: 0.5, workArea })).toEqual({
      x: 1212,
      y: 406,
      width: 88,
      height: 88
    });
  });

  it("derives expanded bounds without overwriting the collapsed anchor", () => {
    const collapsed = resolveWidgetBounds({ mode: "collapsed", dockEdge: "right", anchorRatio: 0.25, workArea });
    const anchor = normalizeWidgetAnchor(collapsed, workArea);
    expect(resolveWidgetBounds({ mode: "expanded", dockEdge: "right", anchorRatio: anchor, workArea })).toEqual({
      x: 916,
      y: 172,
      width: 384,
      height: 312
    });
  });

  it("section 16.4: pinned uses the same geometry as expanded at the same anchor", () => {
    const anchor = 0.5;
    const expanded = resolveWidgetBounds({ mode: "expanded", dockEdge: "left", anchorRatio: anchor, workArea });
    const pinned = resolveWidgetBounds({ mode: "pinned", dockEdge: "left", anchorRatio: anchor, workArea });
    expect(pinned).toEqual(expanded);
  });

  it("section 16.4: reset position clamps off-screen anchor back into the work area", () => {
    const offScreen = { x: -500, y: 900, width: 88, height: 88 };
    expect(clampWidgetBounds(offScreen, workArea)).toEqual({
      x: 100,
      y: 762,
      width: 88,
      height: 88
    });
  });

  it("round-trips a lower-half collapsed bounds through the persisted anchor", () => {
    const dragged = { x: 1212, y: 600, width: 88, height: 88 };
    const ratio = normalizeWidgetAnchor(dragged, workArea);
    const restored = resolveWidgetBounds({
      mode: "collapsed",
      dockEdge: "right",
      anchorRatio: ratio,
      workArea
    });
    expect(restored.y).toBe(600);
    expect(restored.x).toBe(1212);
  });

  it("recovers off-screen bounds inside the current display work area", () => {
    expect(clampWidgetBounds({ x: -500, y: 900, width: 500, height: 500 }, workArea)).toEqual({
      x: 100,
      y: 350,
      width: 500,
      height: 500
    });
  });
});
