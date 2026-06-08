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
    dockEdge,
    orbSize = { width: 104, height: 104 },
    horizontalMargin = 16,
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
