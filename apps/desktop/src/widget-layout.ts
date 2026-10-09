import type { WidgetMode, WindowBounds } from "@agent-metrics/contracts";

export type DisplayWorkArea = WindowBounds;
export type WidgetDockEdge = "left" | "right";

export const WIDGET_SIZES: Record<WidgetMode, Pick<WindowBounds, "width" | "height">> = {
  collapsed: { width: 88, height: 88 },
  // Tall enough for header + primary + 2x2 metrics + footer actions without overlap.
  expanded: { width: 384, height: 312 },
  pinned: { width: 384, height: 312 }
};

export function normalizeWidgetAnchor(bounds: WindowBounds, workArea: DisplayWorkArea): number {
  const height = WIDGET_SIZES.collapsed.height;
  const availableHeight = Math.max(1, workArea.height - height);
  return clamp((bounds.y - workArea.y) / availableHeight, 0, 1);
}

export function resolveWidgetBounds(input: {
  mode: WidgetMode;
  dockEdge: WidgetDockEdge;
  anchorRatio: number;
  workArea: DisplayWorkArea;
}): WindowBounds {
  const size = WIDGET_SIZES[input.mode];
  const width = Math.min(size.width, input.workArea.width);
  const height = Math.min(size.height, input.workArea.height);
  const availableHeight = Math.max(0, input.workArea.height - height);
  const y = input.workArea.y + Math.round(clamp(input.anchorRatio, 0, 1) * availableHeight);
  const x =
    input.dockEdge === "left"
      ? input.workArea.x
      : input.workArea.x + input.workArea.width - width;

  return { x, y, width, height };
}

export function clampWidgetBounds(bounds: WindowBounds, workArea: DisplayWorkArea): WindowBounds {
  const width = Math.min(Math.max(1, bounds.width), workArea.width);
  const height = Math.min(Math.max(1, bounds.height), workArea.height);
  return {
    width,
    height,
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
