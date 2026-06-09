import { describe, expect, it } from "vitest";
import {
  resolveDefaultOrbBounds,
  resolveOrbDockEdge,
  resolveOrbDockPlacement,
  resolveOrbWindowPlacement,
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

  it("resolves the dock edge from the orb window midpoint", () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };

    expect(
      resolveOrbDockEdge({
        orbBounds: { x: 0, y: 220, width: 104, height: 104 },
        workArea
      })
    ).toBe("left");
    expect(
      resolveOrbDockEdge({
        orbBounds: { x: 1336, y: 220, width: 104, height: 104 },
        workArea
      })
    ).toBe("right");
    expect(
      resolveOrbDockEdge({
        orbBounds: { x: 668, y: 220, width: 104, height: 104 },
        workArea
      })
    ).toBeNull();
  });

  it("syncs the dock edge from saved orb bounds when restoring placement", () => {
    expect(
      resolveOrbWindowPlacement({
        savedBounds: { x: 16, y: 700, width: 104, height: 104 },
        dockEdge: "right",
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({
      bounds: { x: -2, y: 700, width: 104, height: 104 },
      dockEdge: "left"
    });
  });

  it("snaps a near-edge orb flush against the docked display edge", () => {
    expect(
      resolveOrbDockPlacement({
        orbBounds: { x: 1318, y: 700, width: 104, height: 104 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({
      bounds: { x: 1342, y: 700, width: 104, height: 104 },
      dockEdge: "right"
    });
  });

  it("restores a centered orb without dock mode", () => {
    expect(
      resolveOrbWindowPlacement({
        savedBounds: { x: 668, y: 420, width: 104, height: 104 },
        dockEdge: "right",
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({
      bounds: { x: 668, y: 420, width: 104, height: 104 },
      dockEdge: null
    });
  });

  it("normalizes a persisted narrow runtime orb back to the full orb size", () => {
    expect(
      resolveOrbWindowPlacement({
        savedBounds: { x: 2502, y: 700, width: 64, height: 104 },
        dockEdge: "right",
        workArea: { x: 0, y: 0, width: 2560, height: 1392 },
        orbSize: { width: 104, height: 104 }
      })
    ).toEqual({
      bounds: { x: 2462, y: 700, width: 104, height: 104 },
      dockEdge: "right"
    });
  });

  it("docks the default orb near the lower-right edge of the work area", () => {
    expect(
      resolveDefaultOrbBounds({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        dockEdge: "right"
      })
    ).toEqual({ x: 1336, y: 700, width: 104, height: 104 });
  });

  it("docks the default orb near the lower-left edge of the work area", () => {
    expect(
      resolveDefaultOrbBounds({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        dockEdge: "left"
      })
    ).toEqual({ x: 0, y: 700, width: 104, height: 104 });
  });
});
