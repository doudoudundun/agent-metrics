import { describe, expect, it } from "vitest";
// @ts-expect-error Packaging helper is authored as plain ESM for the Node release scripts.
import { assertNativeTarget, managedNodeFolderName, parseTargetArgs } from "../scripts/package-target.mjs";

describe("package target arguments", () => {
  it("requires explicit platform and architecture", () => {
    expect(parseTargetArgs(["--target-platform=win32", "--target-arch=x64"])).toMatchObject({
      platform: "win32",
      arch: "x64"
    });
    expect(() => parseTargetArgs(["--target-platform=linux", "--target-arch=x64"])).toThrow("target-platform");
  });

  it("uses the requested target when naming managed Node assets", () => {
    expect(managedNodeFolderName({ platform: "darwin", arch: "arm64" })).toBe("node-v22.22.3-darwin-arm64");
  });

  it("rejects cross-host staging instead of silently using host assets", () => {
    const otherPlatform = process.platform === "win32" ? "darwin" : "win32";
    const otherArch = process.arch === "arm64" ? "x64" : "arm64";
    expect(() => assertNativeTarget({ platform: otherPlatform, arch: otherArch })).toThrow("Cannot stage");
  });
});
