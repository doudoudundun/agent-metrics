import { describe, expect, it } from "vitest";
// @ts-expect-error Packaging config is authored as plain ESM for the Node staging script.
import { BUILD_TARGETS, DEPLOY_TARGETS } from "../scripts/stage-runtime-config.mjs";

describe("stage runtime config", () => {
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
