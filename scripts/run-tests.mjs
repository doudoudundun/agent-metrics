#!/usr/bin/env node
// Test runner that executes vitest using the project's managed Node runtime
// (.runtime/node-v*) when present. The managed runtime is the exact Node
// version the desktop app ships with, and it is the ABI better-sqlite3 is
// compiled against. Running tests under it avoids NODE_MODULE_VERSION mismatch
// errors on machines whose system Node is a different major version.
//
// Behavior:
//   - If the managed runtime exists and can load better-sqlite3, use it.
//   - Otherwise fall back to the current Node (CI without a staged runtime).
//
// Invoked by each package's `test` script as: node ../../scripts/run-tests.mjs [vitest args...]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function findManagedNodeExecutable() {
  const defaultVersion = "22.22.3";
  const requestedVersion = process.env.AGENT_METRICS_NODE_VERSION ?? defaultVersion;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const folderName =
    process.platform === "win32"
      ? `node-v${requestedVersion}-win-${arch}`
      : `node-v${requestedVersion}-${process.platform}-${arch}`;
  const executableName = process.platform === "win32" ? "node.exe" : "node";

  // The runtime is staged under the repo root for dev, and bundled into the
  // packaged app under apps/desktop. Search both roots plus their parents.
  const searchRoots = [repoRoot, join(repoRoot, "apps", "desktop")];

  for (const root of searchRoots) {
    let currentDir = resolve(root);
    while (true) {
      const candidate =
        process.platform === "win32"
          ? join(currentDir, ".runtime", folderName, executableName)
          : join(currentDir, ".runtime", folderName, "bin", executableName);

      if (existsSync(candidate)) {
        return candidate;
      }

      const parent = dirname(currentDir);
      if (parent === currentDir) {
        break;
      }
      currentDir = parent;
    }
  }

  // Allow an explicit override.
  if (process.env.AGENT_METRICS_NODE_PATH && existsSync(process.env.AGENT_METRICS_NODE_PATH)) {
    return process.env.AGENT_METRICS_NODE_PATH;
  }

  return null;
}

function canLoadBetterSqlite(nodeExecutable, cwd) {
  const probe =
    "try { require('better-sqlite3'); } catch (e) { if (e.message.includes('NODE_MODULE_VERSION')) process.exit(1); }";
  const result = spawnSync(nodeExecutable, ["-e", probe], { cwd, stdio: "ignore" });
  return result.status === 0;
}

function findVitestEntry(cwd) {
  // Walk up from cwd to find node_modules/vitest entry, honoring pnpm's layout.
  let currentDir = resolve(cwd);
  while (true) {
    const candidates = [
      join(currentDir, "node_modules", "vitest", "vitest.mjs"),
      join(currentDir, "node_modules", "vitest", "dist", "cli.js")
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }
    currentDir = parent;
  }
}

function main() {
  const cwd = process.cwd();
  const vitestArgs = process.argv.slice(2);

  const managedNode = findManagedNodeExecutable();
  // Prefer the managed runtime when it can actually load the native module;
  // otherwise stay on the current Node so CI without a staged runtime still works.
  const useManaged =
    managedNode &&
    existsSync(managedNode) &&
    canLoadBetterSqlite(managedNode, cwd);

  const nodeExecutable = useManaged ? managedNode : process.execPath;

  if (useManaged && nodeExecutable !== process.execPath) {
    process.stderr.write(`[run-tests] using managed runtime: ${nodeExecutable}\n`);
  }

  const vitestEntry = findVitestEntry(cwd);
  if (!vitestEntry) {
    process.stderr.write("[run-tests] vitest not found; falling back to vitest CLI\n");
    // Fall back to the bin shim on PATH.
    const result = spawnSync("vitest", vitestArgs, { cwd, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  const result = spawnSync(nodeExecutable, [vitestEntry, ...vitestArgs], {
    cwd,
    stdio: "inherit"
  });

  process.exit(result.status ?? 1);
}

main();
