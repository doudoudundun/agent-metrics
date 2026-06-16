import { describe, expect, it } from "vitest";
import { resolveCoreRuntimeConfig } from "./server-runtime.js";

describe("resolveCoreRuntimeConfig", () => {
  it("falls back to workspace-relative defaults when no env override is provided", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl: "file:///D:/projects/dev/agent-metrics/apps/core/dist/server.js",
      env: {
        APPDATA: ""
      }
    });

    expect(config).toEqual({
      repoRoot: "D:\\projects\\dev\\agent-metrics",
      dbPath: "D:\\projects\\dev\\agent-metrics\\data\\sqlite\\metrics.sqlite",
      eventLogPath: "D:\\projects\\dev\\agent-metrics\\data\\events\\events.jsonl"
    });
  });

  it("derives runtime paths from AGENT_METRICS_DATA_ROOT", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl: "file:///D:/projects/dev/agent-metrics/apps/core/dist/server.js",
      env: {
        AGENT_METRICS_DATA_ROOT: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data"
      }
    });

    expect(config).toEqual({
      repoRoot: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data",
      dbPath:
        "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data\\data\\sqlite\\metrics.sqlite",
      eventLogPath:
        "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data\\data\\events\\events.jsonl"
    });
  });

  it("prefers explicit db, event log, and repo-root env overrides over data root defaults", () => {
    const config = resolveCoreRuntimeConfig({
      moduleUrl: "file:///D:/projects/dev/agent-metrics/apps/core/dist/server.js",
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
      moduleUrl: "file:///D:/projects/dev/agent-metrics/apps/core/dist/server.js",
      env: {
        APPDATA: "C:\\Users\\test\\AppData\\Roaming"
      }
    });

    expect(config).toEqual({
      repoRoot: "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data",
      dbPath:
        "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data\\data\\sqlite\\metrics.sqlite",
      eventLogPath:
        "C:\\Users\\test\\AppData\\Roaming\\Agent Metrics\\agent-metrics-data\\data\\events\\events.jsonl"
    });
  });
});
