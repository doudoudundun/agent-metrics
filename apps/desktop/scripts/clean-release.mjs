import { lstat, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDir, "..");
const releaseRoot = join(desktopRoot, "release");

export async function cleanReleaseTargets(targets = []) {
  if (targets.length === 0) {
    await movePathAside(releaseRoot);
    return;
  }

  for (const target of targets) {
    await movePathAside(join(releaseRoot, target));
  }
}

export async function movePathAside(targetPath) {
  const fsPath = toSafeFsPath(targetPath);

  try {
    await lstat(fsPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const parentDir = dirname(targetPath);
  const targetName = basename(targetPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = attempt === 0 ? timestamp : `${timestamp}-${attempt}`;
    const movedPath = join(parentDir, `.cleaned-${targetName}-${suffix}`);

    try {
      await rename(fsPath, toSafeFsPath(movedPath));
      return movedPath;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error(`Unable to move release target aside: ${targetPath}`);
}

export async function removePathSafely(targetPath) {
  let stats;
  const fsPath = toSafeFsPath(targetPath);

  try {
    stats = await lstat(fsPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    await rm(fsPath, { force: true });
    return;
  }

  if (!stats.isDirectory()) {
    await rm(fsPath, { force: true });
    return;
  }

  const entries = await readdir(fsPath);

  for (const entryName of entries) {
    await removePathSafely(join(targetPath, entryName));
  }

  await rmdir(fsPath);
}

if (isMainModule()) {
  cleanReleaseTargets(process.argv.slice(2)).catch((error) => {
    console.error("Failed to clean desktop release output.", error);
    process.exit(1);
  });
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function toSafeFsPath(targetPath) {
  return process.platform === "win32" ? toNamespacedPath(targetPath) : targetPath;
}
