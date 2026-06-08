import { describe, expect, it } from "vitest";
import {
  buildDashboardUrl,
  resolveDesktopDataRoot,
  resolveDesktopRuntimePaths
} from "./runtime-paths.js";

describe("resolveDesktopRuntimePaths", () => {
  it("keeps development binaries rooted at the repository checkout and stores data in the shared user directory", () => {
    expect(
      resolveDesktopRuntimePaths({
        currentDir: "/repo/apps/desktop/dist",
        isPackaged: false,
        userDataPath: "/Users/test/Library/Application Support/Agent Metrics"
      })
    ).toEqual({
      appRoot: "/repo",
      dataRoot: "/Users/test/Library/Application Support/Agent Metrics/agent-metrics-data",
      desktopDistDir: "/repo/apps/desktop/dist",
      coreApiBaseUrl: "http://127.0.0.1:45183",
      dashboardEntryUrl: "http://127.0.0.1:4173/?surface=desktop-main",
      packagedDashboardEntryUrl: null,
      cliEntrypoint: "/repo/apps/cli/dist/index.js",
      cliWorkingDirectory: "/repo/apps/cli",
      coreEntrypoint: "/repo/apps/core/dist/server.js",
      coreWorkingDirectory: "/repo/apps/core"
    });
  });

  it("builds orb and peek-card dashboard surfaces with the same apiBase behavior", () => {
    expect(buildDashboardUrl("http://127.0.0.1:4173", "desktop-orb")).toBe(
      "http://127.0.0.1:4173/?surface=desktop-orb"
    );
    expect(
      buildDashboardUrl(
        "file:///C:/runtime/dashboard/index.html",
        "desktop-orb-peek",
        "http://127.0.0.1:45183"
      )
    ).toBe(
      "file:///C:/runtime/dashboard/index.html?surface=desktop-orb-peek&apiBase=http%3A%2F%2F127.0.0.1%3A45183"
    );
  });

  it("resolves packaged desktop runtime files from resources and data from userData", () => {
    expect(
      resolveDesktopRuntimePaths({
        currentDir: "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\app.asar\\dist",
        isPackaged: true,
        userDataPath: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics"
      })
    ).toEqual({
      appRoot: "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\runtime",
      dataRoot: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data",
      desktopDistDir: "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\app.asar\\dist",
      coreApiBaseUrl: "http://127.0.0.1:45183",
      dashboardEntryUrl:
        "file:///C:/Users/test/AppData/Local/Programs/AgentMetrics/resources/runtime/dashboard/index.html?surface=desktop-main&apiBase=http%3A%2F%2F127.0.0.1%3A45183",
      packagedDashboardEntryUrl:
        "file:///C:/Users/test/AppData/Local/Programs/AgentMetrics/resources/runtime/dashboard/index.html",
      cliEntrypoint:
        "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\runtime\\cli\\dist\\index.js",
      cliWorkingDirectory:
        "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\runtime\\cli",
      coreEntrypoint:
        "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\runtime\\core\\dist\\server.js",
      coreWorkingDirectory:
        "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\runtime\\core"
    });
  });

  it("reuses resolved dashboard entries to build orb surfaces for dev and packaged shells", () => {
    const developmentPaths = resolveDesktopRuntimePaths({
      currentDir: "/repo/apps/desktop/dist",
      isPackaged: false,
      userDataPath: "/Users/test/Library/Application Support/Agent Metrics"
    });
    const packagedPaths = resolveDesktopRuntimePaths({
      currentDir: "C:\\Users\\test\\AppData\\Local\\Programs\\AgentMetrics\\resources\\app.asar\\dist",
      isPackaged: true,
      userDataPath: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics"
    });

    expect(buildDashboardUrl(developmentPaths.dashboardEntryUrl, "desktop-orb")).toBe(
      "http://127.0.0.1:4173/?surface=desktop-orb"
    );
    expect(
      buildDashboardUrl(
        packagedPaths.packagedDashboardEntryUrl ?? packagedPaths.dashboardEntryUrl,
        "desktop-orb-peek",
        packagedPaths.packagedDashboardEntryUrl ? packagedPaths.coreApiBaseUrl : undefined
      )
    ).toBe(
      "file:///C:/Users/test/AppData/Local/Programs/AgentMetrics/resources/runtime/dashboard/index.html?surface=desktop-orb-peek&apiBase=http%3A%2F%2F127.0.0.1%3A45183"
    );
  });

  it("prefers an explicit data root environment override", () => {
    expect(
      resolveDesktopDataRoot({
        userDataPath: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics",
        dataRootEnv: "C:\\agent-metrics-data"
      })
    ).toBe("C:\\agent-metrics-data");
  });

  it("keeps packaged data on the canonical Agent Metrics path even when legacy Electron data exists", () => {
    expect(
      resolveDesktopDataRoot({
        userDataPath: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics",
        appDataPath: "C:\\Users\\test\\AppData\\Roaming",
        fileExists: (filePath) => filePath.includes("\\Electron\\agent-metrics-data")
      })
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data");
  });
});
