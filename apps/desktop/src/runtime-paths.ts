import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const DASHBOARD_DEV_SERVER_URL = "http://127.0.0.1:4173";
const DEFAULT_CORE_API_BASE_URL = "http://127.0.0.1:45183";

export type DesktopDashboardSurface =
  | "desktop-main"
  | "desktop-floating"
  | "desktop-orb"
  | "desktop-orb-peek";

export type DesktopRuntimePaths = {
  appRoot: string;
  dataRoot: string;
  desktopDistDir: string;
  coreApiBaseUrl: string;
  dashboardEntryUrl: string;
  packagedDashboardEntryUrl: string | null;
  cliEntrypoint: string;
  cliWorkingDirectory: string;
  coreEntrypoint: string;
  coreWorkingDirectory: string;
};

export function resolveDesktopRuntimePaths(input: {
  currentDir: string;
  isPackaged: boolean;
  userDataPath: string;
}): DesktopRuntimePaths {
  const pathModule = usesWindowsPaths(input.currentDir) ? win32 : posix;
  const dataRoot = pathModule.join(input.userDataPath, "agent-metrics-data");

  if (!input.isPackaged) {
    const appRoot = pathModule.resolve(input.currentDir, "../../..");

    return {
      appRoot,
      dataRoot,
      desktopDistDir: input.currentDir,
      coreApiBaseUrl: DEFAULT_CORE_API_BASE_URL,
      dashboardEntryUrl: buildDashboardUrl(DASHBOARD_DEV_SERVER_URL, "desktop-main"),
      packagedDashboardEntryUrl: null,
      cliEntrypoint: pathModule.join(appRoot, "apps", "cli", "dist", "index.js"),
      cliWorkingDirectory: pathModule.join(appRoot, "apps", "cli"),
      coreEntrypoint: pathModule.join(appRoot, "apps", "core", "dist", "server.js"),
      coreWorkingDirectory: pathModule.join(appRoot, "apps", "core")
    };
  }

  const resourcesRoot = pathModule.resolve(input.currentDir, "../..");
  const appRoot = pathModule.join(resourcesRoot, "runtime");
  const dashboardFilePath = pathModule.join(appRoot, "dashboard", "index.html");
  const packagedDashboardEntryUrl = toFileUrl(dashboardFilePath);

  return {
    appRoot,
    dataRoot,
    desktopDistDir: input.currentDir,
    coreApiBaseUrl: DEFAULT_CORE_API_BASE_URL,
    dashboardEntryUrl: buildDashboardUrl(
      packagedDashboardEntryUrl,
      "desktop-main",
      DEFAULT_CORE_API_BASE_URL
    ),
    packagedDashboardEntryUrl,
    cliEntrypoint: pathModule.join(appRoot, "cli", "dist", "index.js"),
    cliWorkingDirectory: pathModule.join(appRoot, "cli"),
    coreEntrypoint: pathModule.join(appRoot, "core", "dist", "server.js"),
    coreWorkingDirectory: pathModule.join(appRoot, "core")
  };
}

export function buildDashboardUrl(
  baseUrl: string,
  surface: DesktopDashboardSurface,
  apiBaseUrl?: string
): string {
  const url = new URL(baseUrl);

  url.searchParams.set("surface", surface);

  if (apiBaseUrl) {
    url.searchParams.set("apiBase", apiBaseUrl);
  }

  return url.toString();
}

function usesWindowsPaths(filePath: string): boolean {
  return filePath.includes("\\");
}

function toFileUrl(filePath: string): string {
  if (!usesWindowsPaths(filePath)) {
    return pathToFileURL(filePath).toString();
  }

  return `file:///${filePath.replaceAll("\\", "/")}`;
}
