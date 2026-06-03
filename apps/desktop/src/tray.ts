import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Menu, Tray, nativeImage } = require("electron") as {
  Menu: {
    buildFromTemplate: (items: Array<Record<string, unknown>>) => unknown;
  };
  Tray: new (image: unknown) => {
    destroy: () => void;
    on: (event: "click", listener: () => void) => void;
    setContextMenu: (menu: unknown) => void;
    setToolTip: (toolTip: string) => void;
  };
  nativeImage: {
    createFromDataURL: (dataUrl: string) => {
      resize: (size: { width: number; height: number }) => {
        setTemplateImage: (isTemplate: boolean) => void;
      };
    };
  };
};

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
    '<rect width="16" height="16" rx="3" fill="black"/>',
    '<rect x="3" y="8" width="2" height="5" rx="1" fill="white"/>',
    '<rect x="7" y="4" width="2" height="9" rx="1" fill="white"/>',
    '<rect x="11" y="6" width="2" height="7" rx="1" fill="white"/>',
    "</svg>"
  ].join("");
  const icon = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 16, height: 16 });

  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }

  return icon;
}

export function createDesktopTray({
  showMainWindow,
  toggleFloatingWindow,
  openSettings,
  quitApp
}: {
  showMainWindow: () => void;
  toggleFloatingWindow: () => void;
  openSettings: () => void;
  quitApp: () => void;
}) {
  const tray = new Tray(createTrayIcon());

  tray.setToolTip("Agent Metrics");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dashboard", click: showMainWindow },
      { label: "Show or Hide Floating Window", click: toggleFloatingWindow },
      { label: "Open Settings", click: openSettings },
      { type: "separator" },
      { label: "Quit", click: quitApp }
    ])
  );
  tray.on("click", showMainWindow);

  return tray;
}
