import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  clampBoundsToWorkArea,
  defaultCardBounds
} from "./layout.js";

describe("desktop-card layout", () => {
  it("places the default card inside the work area", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const bounds = defaultCardBounds(workArea);
    assert.equal(bounds.width, CARD_WIDTH);
    assert.equal(bounds.height, CARD_HEIGHT);
    assert.ok(bounds.x + bounds.width <= workArea.width);
    assert.ok(bounds.y >= workArea.y);
  });

  it("clamps saved bounds onto a smaller display work area", () => {
    const clamped = clampBoundsToWorkArea(
      { x: 1800, y: 900, width: CARD_WIDTH, height: CARD_HEIGHT },
      { x: 0, y: 0, width: 700, height: 600 }
    );
    assert.equal(clamped.width, 700);
    assert.equal(clamped.height, CARD_HEIGHT);
    assert.equal(clamped.x, 0);
    assert.equal(clamped.y, 600 - CARD_HEIGHT);
  });
});
