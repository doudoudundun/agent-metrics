import { lstat, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

const FORBIDDEN_PATH =
  /(^|\/)(\.idea|\.zcode|docs?|design|data|telemetry|tmp|tests?|__tests__)(\/|$)/i;
const FORBIDDEN_FILE = /(^|\/)(\.tmp[^/]*|.*\.(test|spec)\.[^.]+|.*\.map)$/i;

/**
 * Remove source tests, maps, and other non-runtime artifacts that pnpm deploy
 * may copy from workspace packages or transitive dependencies (e.g. zod/src/tests).
 */
export async function pruneRuntimeArtifacts(rootDir) {
  const removed = [];
  await visit(rootDir);
  return removed;

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      const relativePath = relative(rootDir, entryPath).replaceAll("\\", "/");

      if (FORBIDDEN_PATH.test(relativePath) || (!entry.isDirectory() && FORBIDDEN_FILE.test(relativePath))) {
        await rm(entryPath, { recursive: true, force: true });
        removed.push(relativePath);
        continue;
      }

      const stats = await lstat(entryPath).catch(() => null);
      if (stats?.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
}
