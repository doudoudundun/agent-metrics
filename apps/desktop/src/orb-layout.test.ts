import { describe, expect, it } from "vitest";
import {
  resolveDefaultOrbBounds,
  resolveOrbDragBounds,
  resolvePeekCardBounds
} from "./orb-layout.js";

describe("orb layout", () => {
  it("positions the peek card to the left of an orb near the right edge", () => {
    expect(
      resolvePeekCardBounds({
        orbBounds: { x: 1284, y: 240, width: 92, height: 92 },
        peekSize: { width: 320, height: 220 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 952, y: 176, width: 320, height: 220 });
  });

  it("positions the peek card to the right of an orb near the left edge", () => {
    expect(
      resolvePeekCardBounds({
        orbBounds: { x: 24, y: 120, width: 92, height: 92 },
        peekSize: { width: 320, height: 220 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 128, y: 56, width: 320, height: 220 });
  });

  it("clamps orb dragging within the visible work area", () => {
    expect(
      resolveOrbDragBounds({
        pointerScreenPoint: { x: 1420, y: 920 },
        pointerOffset: { x: 20, y: 20 },
        orbSize: { width: 92, height: 92 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 1348, y: 808, width: 92, height: 92 });
  });

  it("docks the default orb near the lower-right edge of the work area", () => {
    expect(
      resolveDefaultOrbBounds({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        dockEdge: "right"
      })
    ).toEqual({ x: 1320, y: 700, width: 104, height: 104 });
  });

  it("docks the default orb near the lower-left edge of the work area", () => {
    expect(
      resolveDefaultOrbBounds({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        dockEdge: "left"
      })
    ).toEqual({ x: 16, y: 700, width: 104, height: 104 });
  });
});
