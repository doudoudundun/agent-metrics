import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { resolveDesktopSurface } from "./desktop-mode";

const rootElement = document.getElementById("root")!;
const desktopSurface = resolveDesktopSurface(window.location.search);

document.documentElement.dataset.desktopSurface = desktopSurface.surface;
document.body.dataset.desktopSurface = desktopSurface.surface;
rootElement.dataset.desktopSurface = desktopSurface.surface;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App initialSurface={desktopSurface.surface} />
  </React.StrictMode>
);
