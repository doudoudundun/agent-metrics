import { describe, expect, it } from "vitest";
import { resolveDesktopRuntimePaths } from "./runtime-paths.js";

describe("resolveDesktopRuntimePaths", () => {
  it("keeps development paths rooted at the repository checkout", () => {
    expect(
      resolveDesktopRuntimePaths({
        currentDir: "/repo/apps/desktop/dist",
        isPackaged: false,
        userDataPath: "/Users/test/Library/Application Support/Agent Metrics"
      })
    ).toEqual({
      appRoot: "/repo",
      dataRoot: "/repo",
      desktopDistDir: "/repo/apps/desktop/dist",
      dashboardEntryUrl: "http://127.0.0.1:4173/?surface=desktop-main",
      packagedDashboardEntryUrl: null,
      cliEntrypoint: "/repo/apps/cli/dist/index.js",
      cliWorkingDirectory: "/repo/apps/cli",
      coreEntrypoint: "/repo/apps/core/dist/server.js",
      coreWorkingDirectory: "/repo/apps/core"
    });
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
      dashboardEntryUrl:
        "file:///C:/Users/test/AppData/Local/Programs/AgentMetrics/resources/runtime/dashboard/index.html?surface=desktop-main",
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
});
