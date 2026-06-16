import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDefaultDbPath, resolveDefaultEventLogPath } from "./app.js";

export type CoreRuntimeConfig = {
  repoRoot: string;
  dbPath: string;
  eventLogPath: string;
};

export function resolveCoreRuntimeConfig(input: {
  moduleUrl: string;
  env?: NodeJS.ProcessEnv;
}): CoreRuntimeConfig {
  const env = input.env ?? process.env;
  const dataRoot = resolveCoreDataRoot(env);
  const repoRoot =
    env.AGENT_METRICS_REPO_ROOT ??
    (dataRoot ? dataRoot : normalizeRootPath(fileURLToPath(new URL("../../..", input.moduleUrl))));

  return {
    repoRoot: normalizeRootPath(repoRoot),
    dbPath:
      env.AGENT_METRICS_DB_PATH ??
      (dataRoot
        ? join(dataRoot, "data", "sqlite", "metrics.sqlite")
        : resolveDefaultDbPath(input.moduleUrl)),
    eventLogPath:
      env.AGENT_METRICS_EVENT_LOG_PATH ??
      (dataRoot
        ? join(dataRoot, "data", "events", "events.jsonl")
        : resolveDefaultEventLogPath(input.moduleUrl))
  };
}

function resolveCoreDataRoot(env: NodeJS.ProcessEnv): string | null {
  const explicitRoot = env.AGENT_METRICS_DATA_ROOT?.trim();

  if (explicitRoot) {
    return normalizeRootPath(explicitRoot);
  }

  const appDataRoot = env.APPDATA?.trim();

  if (appDataRoot) {
    return normalizeRootPath(join(appDataRoot, "Agent Metrics", "agent-metrics-data"));
  }

  const xdgDataRoot = env.XDG_DATA_HOME?.trim();

  if (xdgDataRoot) {
    return normalizeRootPath(join(xdgDataRoot, "Agent Metrics", "agent-metrics-data"));
  }

  const homeRoot = env.HOME?.trim();

  if (homeRoot) {
    return normalizeRootPath(join(homeRoot, ".local", "share", "Agent Metrics", "agent-metrics-data"));
  }

  return null;
}

function normalizeRootPath(filePath: string): string {
  const normalized = normalize(filePath);

  if (normalized.length <= 1) {
    return normalized;
  }

  if (/^[A-Za-z]:\\$/.test(normalized) || normalized === "\\\\") {
    return normalized;
  }

  return normalized.replace(/[\\/]+$/u, "");
}
