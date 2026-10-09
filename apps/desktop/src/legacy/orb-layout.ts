import {
  clampBoundsToDisplay,
  type OrbDockEdge,
  type WindowBounds
} from "./window-state.js";

type Size = {
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

const DOCK_EDGE_THRESHOLD_PX = 24;
const LEFT_DOCK_OVERSCAN_PX = 2;
const RIGHT_DOCK_OVERSCAN_PX = 6;

export function resolvePeekCardBounds(input: {
  orbBounds: WindowBounds;
  peekSize: Size;
  workArea: WindowBounds;
  gap?: number;
}): WindowBounds {
  const { orbBounds, peekSize, workArea, gap = 12 } = input;
  const displayMidpoint = workArea.x + workArea.width / 2;
  const orbMidpoint = orbBounds.x + orbBounds.width / 2;
  const placeLeft = orbMidpoint >= displayMidpoint;
  const preferredX = placeLeft
    ? orbBounds.x - peekSize.width - gap
    : orbBounds.x + orbBounds.width + gap;
  const preferredY = orbBounds.y + (orbBounds.height - peekSize.height) / 2;

  return clampBoundsToDisplay(
    {
      x: Math.round(preferredX),
      y: Math.round(preferredY),
      width: peekSize.width,
      height: peekSize.height
    },
    workArea
  );
}

export function resolveDefaultOrbBounds(input: {
  workArea: WindowBounds;
  dockEdge: OrbDockEdge;
  orbSize?: Size;
  horizontalMargin?: number;
  bottomMargin?: number;
}): WindowBounds {
  const {
    workArea,
    dockEdge = "right",
    orbSize = { width: 104, height: 104 },
    horizontalMargin = 0,
    bottomMargin = 96
  } = input;
  const preferredX =
    dockEdge === "left"
      ? workArea.x + horizontalMargin
      : workArea.x + workArea.width - orbSize.width - horizontalMargin;
  const preferredY = workArea.y + workArea.height - orbSize.height - bottomMargin;

  return clampBoundsToDisplay(
    {
      x: Math.round(preferredX),
      y: Math.round(preferredY),
      width: orbSize.width,
      height: orbSize.height
    },
    workArea
  );
}

export function resolveOrbDragBounds(input: {
  pointerScreenPoint: Point;
  pointerOffset: Point;
  orbSize: Size;
  workArea: WindowBounds;
}): WindowBounds {
  const { pointerScreenPoint, pointerOffset, orbSize, workArea } = input;

  return clampBoundsToDisplay(
    {
      x: Math.round(pointerScreenPoint.x - pointerOffset.x),
      y: Math.round(pointerScreenPoint.y - pointerOffset.y),
      width: orbSize.width,
      height: orbSize.height
    },
    workArea
  );
}

export function resolveOrbDockEdge(input: {
  orbBounds: WindowBounds;
  workArea: WindowBounds;
}): OrbDockEdge {
  const leftGap = input.orbBounds.x - input.workArea.x;
  const rightGap = input.workArea.x + input.workArea.width - input.orbBounds.x - input.orbBounds.width;

  if (leftGap <= DOCK_EDGE_THRESHOLD_PX) {
    return "left";
  }

  if (rightGap <= DOCK_EDGE_THRESHOLD_PX) {
    return "right";
  }

  return null;
}

export function resolveOrbDockPlacement(input: {
  orbBounds: WindowBounds;
  workArea: WindowBounds;
}): { bounds: WindowBounds; dockEdge: OrbDockEdge } {
  const bounds = clampBoundsToDisplay(input.orbBounds, input.workArea);
  const dockEdge = resolveOrbDockEdge({ orbBounds: bounds, workArea: input.workArea });

  if (dockEdge === "left") {
    return {
      bounds: { ...bounds, x: input.workArea.x - LEFT_DOCK_OVERSCAN_PX },
      dockEdge
    };
  }

  if (dockEdge === "right") {
    return {
      bounds: {
        ...bounds,
        x: input.workArea.x + input.workArea.width - bounds.width + RIGHT_DOCK_OVERSCAN_PX
      },
      dockEdge
    };
  }

  return { bounds, dockEdge };
}

export function resolveOrbWindowPlacement(input: {
  savedBounds: WindowBounds | null;
  dockEdge: OrbDockEdge;
  workArea: WindowBounds;
  orbSize?: Size;
}): { bounds: WindowBounds; dockEdge: OrbDockEdge } {
  const { savedBounds, dockEdge, workArea, orbSize = { width: 104, height: 104 } } = input;
  const bounds =
    savedBounds === null
      ? resolveDefaultOrbBounds({ workArea, dockEdge, orbSize })
      : clampBoundsToDisplay(
          {
            ...savedBounds,
            x:
              dockEdge === "right"
                ? savedBounds.x + savedBounds.width - orbSize.width
                : savedBounds.x,
            width: orbSize.width,
            height: orbSize.height
          },
          workArea
        );

  return resolveOrbDockPlacement({ orbBounds: bounds, workArea });
}
