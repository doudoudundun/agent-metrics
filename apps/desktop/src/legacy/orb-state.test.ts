import { describe, expect, it } from "vitest";
import {
  createOrbSurfaceState,
  dismissPeekCard,
  expandOrbDetail,
  hoverOrb,
  leaveOrbRegion,
  pinPeekCard,
  togglePeekCardPin
} from "./orb-state.js";

describe("orb state", () => {
  it("shows the peek card when hovering a docked orb", () => {
    expect(hoverOrb(createOrbSurfaceState("orbDocked"))).toEqual(
      createOrbSurfaceState("peekVisible")
    );
  });

  it("keeps the current mode when hover does not match a docked orb", () => {
    expect(hoverOrb(createOrbSurfaceState("peekVisible"))).toEqual(
      createOrbSurfaceState("peekVisible")
    );
  });

  it("pins the peek card from the visible peek state", () => {
    expect(pinPeekCard(createOrbSurfaceState("peekVisible"))).toEqual(
      createOrbSurfaceState("peekPinned")
    );
  });

  it("keeps the current mode when pin does not match a visible peek card", () => {
    expect(pinPeekCard(createOrbSurfaceState("orbDocked"))).toEqual(
      createOrbSurfaceState("orbDocked")
    );
  });

  it("toggles peek pinning from docked, visible, and pinned states", () => {
    expect(togglePeekCardPin(createOrbSurfaceState("orbDocked"))).toEqual(
      createOrbSurfaceState("peekPinned")
    );
    expect(togglePeekCardPin(createOrbSurfaceState("peekVisible"))).toEqual(
      createOrbSurfaceState("peekPinned")
    );
    expect(togglePeekCardPin(createOrbSurfaceState("peekPinned"))).toEqual(
      createOrbSurfaceState("orbDocked")
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

  it("keeps the current mode when leaving a non-visible peek region", () => {
    expect(leaveOrbRegion(createOrbSurfaceState("peekPinned"))).toEqual(
      createOrbSurfaceState("peekPinned")
    );
  });

  it("dismisses a pinned peek card back to the docked orb", () => {
    expect(dismissPeekCard(createOrbSurfaceState("peekPinned"))).toEqual(
      createOrbSurfaceState("orbDocked")
    );
  });

  it("keeps the current mode when dismiss does not match a pinned peek card", () => {
    expect(dismissPeekCard(createOrbSurfaceState("orbDocked"))).toEqual(
      createOrbSurfaceState("orbDocked")
    );
  });

  it("keeps detail visible when expanding a non-peek state", () => {
    expect(expandOrbDetail(createOrbSurfaceState("detailVisible"))).toEqual(
      createOrbSurfaceState("detailVisible")
    );
  });
});
