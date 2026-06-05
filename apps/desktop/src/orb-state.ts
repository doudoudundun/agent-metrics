export type OrbSurfaceMode =
  | "orbHidden"
  | "orbDocked"
  | "peekVisible"
  | "peekPinned"
  | "detailVisible"
  | "mainVisible";

export type OrbSurfaceState = {
  mode: OrbSurfaceMode;
};

export function createOrbSurfaceState(mode: OrbSurfaceMode): OrbSurfaceState {
  return { mode };
}

export function hoverOrb(state: OrbSurfaceState): OrbSurfaceState {
  if (state.mode === "orbDocked") {
    return createOrbSurfaceState("peekVisible");
  }

  return state;
}

export function leaveOrbRegion(state: OrbSurfaceState): OrbSurfaceState {
  if (state.mode === "peekVisible") {
    return createOrbSurfaceState("orbDocked");
  }

  return state;
}

export function pinPeekCard(state: OrbSurfaceState): OrbSurfaceState {
  if (state.mode === "peekVisible") {
    return createOrbSurfaceState("peekPinned");
  }

  return state;
}

export function dismissPeekCard(state: OrbSurfaceState): OrbSurfaceState {
  if (state.mode === "peekPinned") {
    return createOrbSurfaceState("orbDocked");
  }

  return state;
}

export function expandOrbDetail(state: OrbSurfaceState): OrbSurfaceState {
  if (state.mode === "peekVisible" || state.mode === "peekPinned") {
    return createOrbSurfaceState("detailVisible");
  }

  return state;
}
