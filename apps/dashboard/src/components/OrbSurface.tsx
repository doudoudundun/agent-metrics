import { useRef } from "react";

type OrbSurfaceProps = {
  collapsed: boolean;
  stale: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onActivate?: () => void;
  onDragStart?: (offset: { x: number; y: number }) => void;
  onDragMove?: (screenPoint: { x: number; y: number }) => void;
  onDragEnd?: () => void;
};

export function OrbSurface({
  collapsed,
  stale,
  onPointerEnter,
  onPointerLeave,
  onActivate,
  onDragStart,
  onDragMove,
  onDragEnd
}: OrbSurfaceProps) {
  const suppressClickRef = useRef(false);
  const dragStateRef = useRef<{
    active: boolean;
    dragging: boolean;
    startClientX: number;
    startClientY: number;
  } | null>(null);

  const finishInteraction = () => {
    const dragState = dragStateRef.current;

    if (dragState === null) {
      return;
    }

    if (dragState.dragging) {
      onDragEnd?.();
    }

    dragStateRef.current = null;
  };

  return (
    <section
      className="orb-surface"
      aria-label="Desktop orb surface"
      data-collapsed={collapsed}
      data-stale={stale}
    >
      <button
        type="button"
        className="orb-surface__button"
        aria-label="Open desktop peek card"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onMouseDown={(event) => {
          if (event.button !== 0) {
            return;
          }

          dragStateRef.current = {
            active: true,
            dragging: false,
            startClientX: event.clientX,
            startClientY: event.clientY
          };
          suppressClickRef.current = false;
        }}
        onMouseMove={(event) => {
          const dragState = dragStateRef.current;

          if (dragState === null || !dragState.active) {
            return;
          }

          const deltaX = event.clientX - dragState.startClientX;
          const deltaY = event.clientY - dragState.startClientY;

          if (!dragState.dragging && Math.hypot(deltaX, deltaY) >= 6) {
            dragState.dragging = true;
            suppressClickRef.current = true;
            onDragStart?.({
              x: dragState.startClientX,
              y: dragState.startClientY
            });
          }

          if (dragState.dragging) {
            onDragMove?.({
              x: event.screenX,
              y: event.screenY
            });
          }
        }}
        onMouseUp={() => {
          if (dragStateRef.current === null) {
            return;
          }

          finishInteraction();
        }}
        onMouseLeave={() => {
          if (dragStateRef.current?.dragging) {
            finishInteraction();
          }
        }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }

          onActivate?.();
        }}
      >
        <span className="orb-surface__core" aria-hidden="true" />
      </button>
    </section>
  );
}
