import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_NODE_VERSION } from "./stage-runtime-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TARGET_PLATFORMS = ["win32", "darwin"];
export const TARGET_ARCHITECTURES = ["x64", "arm64"];

export function resolveDefaultArtifact(target, root = desktopRoot) {
  const releaseRoot = join(root, "release");
  if (target.platform === "win32") {
    return join(releaseRoot, "win-unpacked");
  }
  return join(releaseRoot, "mac");
}

export function parseTargetArgs(argv = process.argv.slice(2), { requireArtifact = false, resolveArtifactDefault = false } = {}) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator >= 0) {
      values.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const platform = values.get("target-platform");
  const arch = values.get("target-arch");
  const artifact = values.get("artifact");
  if (!TARGET_PLATFORMS.includes(platform)) {
    throw new Error(`--target-platform must be one of: ${TARGET_PLATFORMS.join(", ")}`);
  }
  if (!TARGET_ARCHITECTURES.includes(arch)) {
    throw new Error(`--target-arch must be one of: ${TARGET_ARCHITECTURES.join(", ")}`);
  }
  let resolvedArtifact = artifact && artifact.trim() !== "" ? resolve(artifact) : null;
  if (requireArtifact && resolvedArtifact === null) {
    if (resolveArtifactDefault) {
      resolvedArtifact = resolveDefaultArtifact({ platform, arch });
    } else {
      throw new Error("--artifact is required");
    }
  }
  return { platform, arch, artifact: resolvedArtifact };
}

export function assertNativeTarget(target) {
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform !== target.platform || hostArch !== target.arch) {
    throw new Error(
      `Cannot stage ${target.platform}/${target.arch} on ${process.platform}/${hostArch}; ` +
        "run the packaging job on a matching native host or provide a target-native runtime explicitly."
    );
  }
}

export function managedNodeFolderName(target) {
  return `node-v${MANAGED_NODE_VERSION}-${target.platform === "win32" ? "win" : "darwin"}-${target.arch}`;
}

export function resolveManagedNodeRuntime(target) {
  const explicitNodePath = process.env.AGENT_METRICS_NODE_PATH;
  if (explicitNodePath !== undefined && explicitNodePath.trim() !== "") {
    const nodeCommand = resolve(explicitNodePath);
    if (!existsSync(nodeCommand)) {
      throw new Error(`AGENT_METRICS_NODE_PATH does not exist: ${nodeCommand}`);
    }
    const reported = execFileSync(nodeCommand, ["-p", "`${process.platform}/${process.arch}`"], {
      encoding: "utf8"
    }).trim();
    const expected = `${target.platform}/${target.arch}`;
    if (reported !== expected) {
      throw new Error(`Managed Node reports ${reported}; expected ${expected}.`);
    }
    const binDir = resolve(nodeCommand, "..");
    return {
      binDir,
      nodeCommand,
      npmCommand: target.platform === "win32" ? resolve(binDir, "npm.cmd") : resolve(binDir, "npm")
    };
  }

  const runtimeRoot = resolve(repoRoot, ".runtime", managedNodeFolderName(target));
  const binDir = target.platform === "win32" ? runtimeRoot : resolve(runtimeRoot, "bin");
  const nodeCommand = target.platform === "win32" ? resolve(runtimeRoot, "node.exe") : resolve(binDir, "node");
  if (!existsSync(nodeCommand)) {
    throw new Error(`Managed Node runtime is missing for ${target.platform}/${target.arch}: ${nodeCommand}`);
  }
  return {
    binDir,
    nodeCommand,
    npmCommand: target.platform === "win32" ? resolve(runtimeRoot, "npm.cmd") : resolve(binDir, "npm")
  };
}
