export const MANAGED_NODE_VERSION = "22.22.3";

// Use `...` filters so workspace adapter/schema deps rebuild before deploy.
// Otherwise stale package dist/ (e.g. adapters-codex) can ship without Multica roots.
export const BUILD_TARGETS = [
  "@agent-metrics/dashboard...",
  "@agent-metrics/core...",
  "@agent-metrics/cli...",
  "@agent-metrics/desktop"
];

export const DEPLOY_TARGETS = [
  { packageName: "@agent-metrics/cli", folderName: "cli" },
  { packageName: "@agent-metrics/core", folderName: "core" }
];
