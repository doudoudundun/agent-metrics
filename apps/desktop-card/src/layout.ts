export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DisplayWorkArea = WindowBounds;

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 272;
export const CARD_MARGIN = 24;

export const DEFAULT_CARD_SIZE = {
  width: CARD_WIDTH,
  height: CARD_HEIGHT
} as const;

export function defaultCardBounds(workArea: DisplayWorkArea): WindowBounds {
  const width = Math.min(CARD_WIDTH, workArea.width);
  const height = Math.min(CARD_HEIGHT, workArea.height);
  return clampBoundsToWorkArea(
    {
      x: workArea.x + workArea.width - width - CARD_MARGIN,
      y: workArea.y + CARD_MARGIN,
      width,
      height
    },
    workArea
  );
}

export function clampBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: DisplayWorkArea
): WindowBounds {
  const width = Math.min(Math.max(1, bounds.width), workArea.width);
  const height = Math.min(Math.max(1, bounds.height), workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    width,
    height,
    x: clamp(bounds.x, workArea.x, maxX),
    y: clamp(bounds.y, workArea.y, maxY)
  };
}

export function sanitizeBounds(value: unknown): WindowBounds | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { x, y, width, height } = record;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
