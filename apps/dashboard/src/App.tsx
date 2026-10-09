import { DashboardPage } from "./DashboardPage";
import { LegacyDesktopSurfaces } from "./LegacyDesktopSurfaces";
import { resolveDesktopSurface, type DesktopSurface } from "./desktop-mode";
import { WidgetPage } from "./WidgetPage";
import "./styles.css";

type AppProps = {
  initialSurface?: DesktopSurface;
};

/**
 * Thin surface router: browser and desktop-main both resolve to the query-hooks
 * powered DashboardPage. Only the legacy compact desktop surfaces (floating,
 * orb, orb-peek) still fall back to the pre-Phase-5 implementation, pending
 * their Phase 7 replacement.
 */
export function App({ initialSurface }: AppProps = {}) {
  const desktopSurface = initialSurface ?? resolveDesktopSurface(window.location.search).surface;

  if (desktopSurface === "desktop-widget") {
    return <WidgetPage />;
  }

  if (
    desktopSurface === "desktop-floating" ||
    desktopSurface === "desktop-orb" ||
    desktopSurface === "desktop-orb-peek"
  ) {
    return <LegacyDesktopSurfaces surface={desktopSurface} />;
  }

  return <DashboardPage />;
}
