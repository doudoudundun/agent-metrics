import { describe, expect, it } from "vitest";
// @ts-expect-error Packaging config is authored as plain ESM for the Node staging script.
import { BUILD_TARGETS, DEPLOY_TARGETS, MANAGED_NODE_VERSION } from "../scripts/stage-runtime-config.mjs";

describe("stage runtime config", () => {
  it("uses the managed Node version for packaged runtime assets", () => {
    expect(MANAGED_NODE_VERSION).toBe("22.22.3");
  });

  it("builds every desktop packaging dependency before staging runtime assets", () => {
    expect(BUILD_TARGETS).toEqual([
      "@agent-metrics/dashboard",
      "@agent-metrics/core",
      "@agent-metrics/cli",
      "@agent-metrics/desktop"
    ]);
  });

  it("deploys the cli and core runtime packages into the bundle", () => {
    expect(DEPLOY_TARGETS).toEqual([
      { packageName: "@agent-metrics/cli", folderName: "cli" },
      { packageName: "@agent-metrics/core", folderName: "core" }
    ]);
  });
});
