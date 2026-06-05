import { describe, expect, it } from "vitest";
import { resolveOrbDragBounds, resolvePeekCardBounds } from "./orb-layout.js";

describe("orb layout", () => {
  it("positions the peek card to the left of an orb near the right edge", () => {
    expect(
      resolvePeekCardBounds({
        orbBounds: { x: 1300, y: 240, width: 76, height: 76 },
        peekSize: { width: 320, height: 220 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 968, y: 168, width: 320, height: 220 });
  });

  it("positions the peek card to the right of an orb near the left edge", () => {
    expect(
      resolvePeekCardBounds({
        orbBounds: { x: 24, y: 120, width: 76, height: 76 },
        peekSize: { width: 320, height: 220 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 112, y: 48, width: 320, height: 220 });
  });

  it("clamps orb dragging within the visible work area", () => {
    expect(
      resolveOrbDragBounds({
        pointerScreenPoint: { x: 1420, y: 920 },
        pointerOffset: { x: 20, y: 20 },
        orbSize: { width: 76, height: 76 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 1364, y: 824, width: 76, height: 76 });
  });
});
