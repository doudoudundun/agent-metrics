import { describe, expect, it } from "vitest";
import {
  createOrbSurfaceState,
  dismissPeekCard,
  expandOrbDetail,
  hoverOrb,
  leaveOrbRegion,
  pinPeekCard
} from "./orb-state.js";

describe("orb state", () => {
  it("shows the peek card when hovering a docked orb", () => {
    expect(hoverOrb(createOrbSurfaceState("orbDocked"))).toEqual(
      createOrbSurfaceState("peekVisible")
    );
  });

  it("pins the peek card from the visible peek state", () => {
    expect(pinPeekCard(createOrbSurfaceState("peekVisible"))).toEqual(
      createOrbSurfaceState("peekPinned")
    );
  });

  it("expands peek states into the detail view", () => {
    expect(expandOrbDetail(createOrbSurfaceState("peekVisible"))).toEqual(
      createOrbSurfaceState("detailVisible")
    );
    expect(expandOrbDetail(createOrbSurfaceState("peekPinned"))).toEqual(
      createOrbSurfaceState("detailVisible")
    );
  });

  it("docks the orb after leaving the visible peek region", () => {
    expect(leaveOrbRegion(createOrbSurfaceState("peekVisible"))).toEqual(
      createOrbSurfaceState("orbDocked")
    );
  });

  it("dismisses a pinned peek card back to the docked orb", () => {
    expect(dismissPeekCard(createOrbSurfaceState("peekPinned"))).toEqual(
      createOrbSurfaceState("orbDocked")
    );
  });
});
