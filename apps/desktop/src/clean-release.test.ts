import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Packaging helper is authored as plain ESM for the Node release script.
import { movePathAside, removePathSafely } from "../scripts/clean-release.mjs";

describe("clean release", () => {
  it("removes junctions without deleting their external target", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "agent-metrics-clean-release-"));
    const releaseRoot = join(testRoot, "release");
    const externalRoot = join(testRoot, "external-target");
    const externalFile = join(externalRoot, "keep.txt");
    const linkedRuntime = join(releaseRoot, "runtime-link");

    try {
      await mkdir(releaseRoot, { recursive: true });
      await mkdir(externalRoot, { recursive: true });
      await writeFile(externalFile, "keep");
      await symlink(externalRoot, linkedRuntime, "junction");

      await removePathSafely(releaseRoot);

      await expect(lstat(releaseRoot)).rejects.toThrow();
      await expect(lstat(externalFile)).resolves.toMatchObject({
        isFile: expect.any(Function)
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("removes long nested release paths on Windows", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "agent-metrics-clean-release-long-"));
    let nestedRoot = join(testRoot, "release");

    try {
      for (let index = 0; index < 18; index += 1) {
        nestedRoot = join(nestedRoot, "nested-release-runtime");
      }

      await mkdir(nestedRoot, { recursive: true });
      await writeFile(join(nestedRoot, "leaf.txt"), "leaf");

      await removePathSafely(join(testRoot, "release"));

      await expect(lstat(join(testRoot, "release"))).rejects.toThrow();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("moves stale release output aside without deleting it in the packaging path", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "agent-metrics-clean-release-move-"));
    const releaseRoot = join(testRoot, "win-unpacked");

    try {
      await mkdir(releaseRoot, { recursive: true });
      await writeFile(join(releaseRoot, "stale.txt"), "stale");

      const movedPath = await movePathAside(releaseRoot);

      await expect(lstat(releaseRoot)).rejects.toThrow();
      await expect(lstat(join(movedPath, "stale.txt"))).resolves.toMatchObject({
        isFile: expect.any(Function)
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
