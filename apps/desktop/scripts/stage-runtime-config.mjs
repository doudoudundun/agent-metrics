export const MANAGED_NODE_VERSION = "22.22.3";

export const BUILD_TARGETS = [
  "@agent-metrics/dashboard",
  "@agent-metrics/core",
  "@agent-metrics/cli",
  "@agent-metrics/desktop"
];

export const DEPLOY_TARGETS = [
  { packageName: "@agent-metrics/cli", folderName: "cli" },
  { packageName: "@agent-metrics/core", folderName: "core" }
];
