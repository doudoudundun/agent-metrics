import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Packaging helper is authored as plain ESM for the Node staging script.
import { sanitizeRuntimeLinks } from "../scripts/sanitize-runtime-links.mjs";

describe("sanitize runtime links", () => {
  it("removes only junctions that escape the staged runtime bundle", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "agent-metrics-runtime-links-"));
    const bundleRoot = join(testRoot, "bundle");
    const insideTarget = join(bundleRoot, "inside-target");
    const externalRoot = join(testRoot, "external-target");
    const insideLink = join(bundleRoot, "inside-link");
    const externalLink = join(bundleRoot, "external-link");

    try {
      await mkdir(bundleRoot, { recursive: true });
      await mkdir(insideTarget, { recursive: true });
      await mkdir(externalRoot, { recursive: true });
      await symlink(insideTarget, insideLink, "junction");
      await symlink(externalRoot, externalLink, "junction");

      const removedPaths = await sanitizeRuntimeLinks(bundleRoot);

      expect(removedPaths).toEqual([externalLink]);
      await expect(lstat(insideLink)).resolves.toMatchObject({
        isSymbolicLink: expect.any(Function)
      });
      await expect(lstat(externalLink)).rejects.toThrow();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
