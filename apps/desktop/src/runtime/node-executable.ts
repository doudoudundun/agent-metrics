import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_MANAGED_NODE_VERSION = "22.22.3";
const COMPATIBILITY_CHECK_SCRIPT =
  "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();";

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    stdio: "ignore";
  }
) => SpawnSyncReturns<Buffer>;

export function resolveDesktopNodeExecutable({
  cliWorkingDirectory,
  coreWorkingDirectory,
  currentExecutablePath,
  env = globalThis.process.env,
  platform = globalThis.process.platform,
  arch = globalThis.process.arch,
  fileExists = existsSync,
  spawnNode = spawnSync as SpawnSyncFn
}: {
  cliWorkingDirectory: string;
  coreWorkingDirectory: string;
  currentExecutablePath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fileExists?: (filePath: string) => boolean;
  spawnNode?: SpawnSyncFn;
}): string {
  const candidates = collectNodeCandidates({
    cliWorkingDirectory,
    coreWorkingDirectory,
    currentExecutablePath,
    env,
    platform,
    arch,
    fileExists
  });

  for (const candidate of candidates) {
    if (supportsCoreRuntime(candidate, coreWorkingDirectory, spawnNode)) {
      return candidate;
    }
  }

  throw new Error(
    "No compatible Node runtime was found for the desktop service chain. Set AGENT_METRICS_NODE_PATH to a Node 22 executable."
  );
}

function collectNodeCandidates(input: {
  cliWorkingDirectory: string;
  coreWorkingDirectory: string;
  currentExecutablePath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  fileExists: (filePath: string) => boolean;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: string | null) => {
    if (candidate === null) {
      return;
    }

    const normalizedCandidate = normalizeCandidate(candidate);

    if (seen.has(normalizedCandidate)) {
      return;
    }

    seen.add(normalizedCandidate);
    candidates.push(candidate);
  };

  pushCandidate(input.env.AGENT_METRICS_NODE_PATH ?? null);
  pushCandidate(resolveManagedNodePath(input));

  if (isNodeExecutablePath(input.currentExecutablePath)) {
    pushCandidate(input.currentExecutablePath);
  }

  pushCandidate("node");
  return candidates;
}

function resolveManagedNodePath(input: {
  cliWorkingDirectory: string;
  coreWorkingDirectory: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  fileExists: (filePath: string) => boolean;
}): string | null {
  const managedVersion = input.env.AGENT_METRICS_NODE_VERSION ?? DEFAULT_MANAGED_NODE_VERSION;
  const managedFolder = buildManagedNodeFolderName(managedVersion, input.platform, input.arch);

  if (managedFolder === null) {
    return null;
  }

  for (const searchRoot of [input.cliWorkingDirectory, input.coreWorkingDirectory]) {
    let currentDir = resolve(searchRoot);

    while (true) {
      const candidate = buildManagedNodeCandidate(currentDir, managedFolder, input.platform);

      if (input.fileExists(candidate)) {
        return candidate;
      }

      const parentDir = dirname(currentDir);

      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }
  }

  return null;
}

function buildManagedNodeFolderName(
  version: string,
  platform: NodeJS.Platform,
  arch: string
): string | null {
  if (platform === "win32") {
    return `node-v${version}-win-${arch === "arm64" ? "arm64" : "x64"}`;
  }

  if (platform === "darwin") {
    return `node-v${version}-darwin-${arch === "x64" ? "x64" : "arm64"}`;
  }

  if (platform === "linux") {
    return `node-v${version}-linux-${arch === "arm64" ? "arm64" : "x64"}`;
  }

  return null;
}

function buildManagedNodeCandidate(
  rootDir: string,
  managedFolder: string,
  platform: NodeJS.Platform
): string {
  if (platform === "win32") {
    return join(rootDir, ".runtime", managedFolder, "node.exe");
  }

  return join(rootDir, ".runtime", managedFolder, "bin", "node");
}

function supportsCoreRuntime(
  candidate: string,
  coreWorkingDirectory: string,
  spawnNode: SpawnSyncFn
): boolean {
  const result = spawnNode(candidate, ["-e", COMPATIBILITY_CHECK_SCRIPT], {
    cwd: coreWorkingDirectory,
    stdio: "ignore"
  });

  return result.status === 0;
}

function isNodeExecutablePath(filePath: string): boolean {
  const executableName = basename(filePath).toLowerCase();
  return executableName === "node" || executableName === "node.exe";
}

function normalizeCandidate(candidate: string): string {
  return candidate.trim().toLowerCase();
}
