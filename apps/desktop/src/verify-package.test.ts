import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Packaging helper is authored as plain ESM for the Node staging script.
import { verifyPackage } from "../scripts/verify-package.mjs";

describe("packaged runtime portability", () => {
  it.each([
    { missing: false, internal: false },
    { missing: true, internal: false },
    { missing: false, internal: true }
  ])("rejects absolute dependency junctions: %j", async ({ missing, internal }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "agent-metrics-package-links-"));
    const runtimeRoot = join(testRoot, "runtime");
    const target = join(internal ? runtimeRoot : join(testRoot, "staging"), "dependency");
    try {
      await mkdir(join(runtimeRoot, "core", "node_modules"), { recursive: true });
      await mkdir(target, { recursive: true });
      await symlink(target, join(runtimeRoot, "core", "node_modules", "dependency"), "junction");
      if (missing) await rm(target, { recursive: true, force: true });

      await expect(verifyPackage({
        artifact: runtimeRoot,
        target: { platform: process.platform, arch: process.arch }
      })).rejects.toThrow(/non-portable runtime link/i);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
