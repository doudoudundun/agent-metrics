type OrbSurfaceProps = {
  collapsed: boolean;
  stale: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onClick?: () => void;
};

export function OrbSurface({
  collapsed,
  stale,
  onPointerEnter,
  onPointerLeave,
  onClick
}: OrbSurfaceProps) {
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
        onClick={onClick}
      >
        <span className="orb-surface__core" aria-hidden="true" />
      </button>
    </section>
  );
}
