import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export async function sanitizeRuntimeLinks(rootDir) {
  const rootPath = normalizeForComparison(await realpath(rootDir));
  const removedPaths = [];

  await walkDirectory(rootDir);

  return removedPaths;

  async function walkDirectory(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      const entryStats = await lstat(entryPath);

      if (entryStats.isSymbolicLink()) {
        const targetPath = await resolveLinkTarget(entryPath);

        if (targetPath !== null && !isInsideRoot(rootPath, targetPath)) {
          await rm(entryPath, { recursive: true, force: true });
          removedPaths.push(entryPath);
        }

        continue;
      }

      if (entryStats.isDirectory()) {
        await walkDirectory(entryPath);
      }
    }
  }
}

async function resolveLinkTarget(linkPath) {
  try {
    return normalizeForComparison(await realpath(linkPath));
  } catch {
    return null;
  }
}

function isInsideRoot(rootPath, targetPath) {
  if (targetPath === rootPath) {
    return true;
  }

  return targetPath.startsWith(`${rootPath}${normalizedSeparator()}`);
}

function normalizeForComparison(filePath) {
  const normalizedPath = resolve(filePath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function normalizedSeparator() {
  return process.platform === "win32" ? sep.toLowerCase() : sep;
}
