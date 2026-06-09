import { useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 6;

type OrbSurfaceProps = {
  collapsed: boolean;
  stale: boolean;
  dockEdge?: "left" | "right" | null;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onActivate?: () => void;
  onContextMenu?: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
};

export function OrbSurface({
  collapsed,
  stale,
  dockEdge,
  onPointerEnter,
  onPointerLeave,
  onActivate,
  onContextMenu,
  onDragStart,
  onDragEnd
}: OrbSurfaceProps) {
  const hasDock = dockEdge === "left" || dockEdge === "right";
  const [revealed, setRevealed] = useState(!hasDock);
  const suppressClickRef = useRef(false);
  const dragStateRef = useRef<{
    active: boolean;
    dragging: boolean;
    dragStarted: boolean;
    source: "pointer" | "mouse";
    pointerId: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);

  const beginInteraction = ({
    pointerId,
    source,
    clientX,
    clientY
  }: {
    pointerId: number;
    source: "pointer" | "mouse";
    clientX: number;
    clientY: number;
  }) => {
    dragStateRef.current = {
      active: true,
      dragging: false,
      dragStarted: true,
      source,
      pointerId,
      startClientX: clientX,
      startClientY: clientY
    };
    suppressClickRef.current = false;
    onDragStart?.();
  };

  const moveInteraction = ({
    pointerId,
    source,
    clientX,
    clientY
  }: {
    pointerId: number;
    source: "pointer" | "mouse";
    clientX: number;
    clientY: number;
  }) => {
    const dragState = dragStateRef.current;

    if (
      dragState === null ||
      !dragState.active ||
      dragState.source !== source ||
      dragState.pointerId !== pointerId
    ) {
      return;
    }

    const deltaX = clientX - dragState.startClientX;
    const deltaY = clientY - dragState.startClientY;

    if (!dragState.dragging && Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD_PX) {
      dragState.dragging = true;
      suppressClickRef.current = true;
    }
  };

  const finishInteraction = () => {
    const dragState = dragStateRef.current;

    if (dragState === null) {
      return;
    }

    if (dragState.dragStarted) {
      onDragEnd?.();
    }

    dragStateRef.current = null;
  };

  const handlePointerEnter = () => {
    if (hasDock && !dragStateRef.current?.dragging) {
      setRevealed(true);
    }
    onPointerEnter?.();
  };

  const handlePointerLeave = () => {
    if (hasDock && !dragStateRef.current?.dragging) {
      setRevealed(false);
    }
    onPointerLeave?.();
  };

  return (
    <section
      className="orb-surface"
      aria-label="Desktop orb surface"
      data-collapsed={collapsed}
      data-stale={stale}
      data-dock-edge={hasDock ? dockEdge : undefined}
      data-revealed={hasDock ? revealed : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <button
        type="button"
        className="orb-surface__button"
        aria-label="Open desktop peek card"
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu?.();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }

          event.currentTarget.setPointerCapture?.(event.pointerId);
          beginInteraction({
            pointerId: event.pointerId,
            source: "pointer",
            clientX: event.clientX,
            clientY: event.clientY
          });
        }}
        onPointerMove={(event) => {
          moveInteraction({
            pointerId: event.pointerId,
            source: "pointer",
            clientX: event.clientX,
            clientY: event.clientY
          });
        }}
        onPointerUp={(event) => {
          if (dragStateRef.current === null || dragStateRef.current.pointerId !== event.pointerId) {
            return;
          }

          event.currentTarget.releasePointerCapture?.(event.pointerId);
          finishInteraction();
        }}
        onPointerCancel={(event) => {
          if (dragStateRef.current === null || dragStateRef.current.pointerId !== event.pointerId) {
            return;
          }

          finishInteraction();
        }}
        onLostPointerCapture={() => {
          finishInteraction();
        }}
        onMouseDown={(event) => {
          if (event.button !== 0 || dragStateRef.current !== null) {
            return;
          }

          beginInteraction({
            pointerId: 0,
            source: "mouse",
            clientX: event.clientX,
            clientY: event.clientY
          });
        }}
        onMouseMove={(event) => {
          moveInteraction({
            pointerId: 0,
            source: "mouse",
            clientX: event.clientX,
            clientY: event.clientY
          });
        }}
        onMouseUp={() => {
          if (dragStateRef.current?.source !== "mouse") {
            return;
          }

          finishInteraction();
        }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }

          onActivate?.();
        }}
      >
        <span className="orb-surface__ring orb-surface__ring--outer" aria-hidden="true" />
        <span className="orb-surface__ring orb-surface__ring--inner" aria-hidden="true" />
        <svg
          className="orb-surface__icon"
          viewBox="0 0 24 24"
          width="28"
          height="28"
          aria-hidden="true"
        >
          <path
            d="M12 2 L15.5 8.5 L12 6 L8.5 8.5 Z"
            fill="rgba(255,255,255,0.85)"
          />
          <path
            d="M5.5 10 L12 14 L18.5 10 L15 16 L9 16 Z"
            fill="rgba(255,255,255,0.55)"
          />
          <circle cx="12" cy="12" r="2.2" fill="rgba(255,255,255,0.92)" />
        </svg>
      </button>
    </section>
  );
}
