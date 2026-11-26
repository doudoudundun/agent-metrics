import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCoreRuntimeConfig } from "./server-runtime.js";

const workspace = process.platform === "win32" ? "D:\\projects\\dev\\agent-metrics" : "/projects/dev/agent-metrics";
const appData = process.platform === "win32" ? "C:\\Users\\test\\AppData\\Roaming" : "/Users/test/AppData/Roaming";
const runtimeRoot = join(appData, "Agent Metrics", "agent-metrics-data");
const moduleUrl = pathToFileURL(join(workspace, "apps", "core", "dist", "server.js")).href;

describe("resolveCoreRuntimeConfig", () => {
  it("falls back to workspace-relative defaults when no env override is provided", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl,
      env: {
        APPDATA: ""
      }
    });

    expect(config).toEqual({
      repoRoot: workspace,
      dbPath: join(workspace, "data", "sqlite", "metrics.sqlite"),
      eventLogPath: join(workspace, "data", "events", "events.jsonl")
    });
  });

  it("derives runtime paths from AGENT_METRICS_DATA_ROOT", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl,
      env: {
        AGENT_METRICS_DATA_ROOT: runtimeRoot
      }
    });

    expect(config).toEqual({
      repoRoot: runtimeRoot,
      dbPath: join(runtimeRoot, "data", "sqlite", "metrics.sqlite"),
      eventLogPath: join(runtimeRoot, "data", "events", "events.jsonl")
    });
  });

  it("prefers explicit db, event log, and repo-root env overrides over data root defaults", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl,
      env: {
        AGENT_METRICS_DATA_ROOT: "C:\\runtime-data",
        AGENT_METRICS_DB_PATH: "D:\\custom\\metrics.sqlite",
        AGENT_METRICS_EVENT_LOG_PATH: "D:\\custom\\events.jsonl",
        AGENT_METRICS_REPO_ROOT: "D:\\custom\\repo-root"
      }
    });

    expect(config).toEqual({
      repoRoot: "D:\\custom\\repo-root",
      dbPath: "D:\\custom\\metrics.sqlite",
      eventLogPath: "D:\\custom\\events.jsonl"
    });
  });

  it("defaults to the shared Windows app-data root when APPDATA is available", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl,
      env: {
        APPDATA: appData
      }
    });

    expect(config).toEqual({
      repoRoot: runtimeRoot,
      dbPath: join(runtimeRoot, "data", "sqlite", "metrics.sqlite"),
      eventLogPath: join(runtimeRoot, "data", "events", "events.jsonl")
    });
  });
});
