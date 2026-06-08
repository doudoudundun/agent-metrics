import { copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BUILD_TARGETS, DEPLOY_TARGETS } from "./stage-runtime-config.mjs";
import { sanitizeRuntimeLinks } from "./sanitize-runtime-links.mjs";

const MANAGED_NODE_VERSION = "22.22.3";
const CORE_RUNTIME_CHECK_SCRIPT =
  "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();";
const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const stagingRoot = join(desktopRoot, ".runtime-bundle");
const dashboardDist = join(repoRoot, "apps", "dashboard", "dist");
const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
const corepackExecOptions = {
  cwd: repoRoot,
  shell: process.platform === "win32",
  stdio: "inherit"
};

async function main() {
  await ensureBuildArtifacts();

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  for (const target of DEPLOY_TARGETS) {
    const destination = join(stagingRoot, target.folderName);
    deployWorkspacePackage(target.packageName, destination);
    await sanitizeRuntimeLinks(destination);

    if (target.packageName === "@agent-metrics/core") {
      await ensureCoreNativeRuntime(destination);
    }
  }

  await cp(dashboardDist, join(stagingRoot, "dashboard"), { recursive: true });
}

async function ensureBuildArtifacts() {
  for (const packageName of BUILD_TARGETS) {
    buildWorkspacePackage(packageName);
  }

  await stat(dashboardDist);
}

function buildWorkspacePackage(packageName) {
  execFileSync(
    corepackCommand,
    ["pnpm", "--dir", repoRoot, "--filter", packageName, "build"],
    corepackExecOptions
  );
}

function deployWorkspacePackage(packageName, destination) {
  execFileSync(
    corepackCommand,
    ["pnpm", "--dir", repoRoot, "deploy", "--legacy", "--filter", packageName, "--prod", destination],
    corepackExecOptions
  );
}

async function ensureCoreNativeRuntime(coreRuntimeDir) {
  const runtime = resolveManagedNodeRuntime();

  if (validateCoreRuntime(coreRuntimeDir, runtime.nodeCommand)) {
    return;
  }

  const packageRoot = resolveRuntimePackageRoot(coreRuntimeDir, runtime.nodeCommand, "better-sqlite3");
  await buildNativePackageInTemp(runtime, packageRoot, "better-sqlite3");

  if (!validateCoreRuntime(coreRuntimeDir, runtime.nodeCommand)) {
    throw new Error("Staged better-sqlite3 is not compatible with the managed desktop Node runtime.");
  }
}

async function buildNativePackageInTemp(runtime, targetPackageRoot, packageName) {
  const packageVersion = JSON.parse(readFileSync(join(targetPackageRoot, "package.json"), "utf8")).version;
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-metrics-native-"));
  const installOptions = {
    cwd: tempRoot,
    env: {
      ...process.env,
      PATH: prependPath(runtime.binDir, process.env.PATH ?? "")
    },
    shell: process.platform === "win32",
    stdio: "inherit"
  };

  try {
    await writeFile(
      join(tempRoot, "package.json"),
      JSON.stringify({ name: "agent-metrics-native-build", private: true }, null, 2)
    );
    execFileSync(runtime.npmCommand, ["install", `${packageName}@${packageVersion}`, "--build-from-source", "--omit=dev"], installOptions);

    const builtNativeModule = join(tempRoot, "node_modules", packageName, "build", "Release", "better_sqlite3.node");
    const targetNativeModule = join(targetPackageRoot, "build", "Release", "better_sqlite3.node");
    await mkdir(dirname(targetNativeModule), { recursive: true });
    await copyFile(builtNativeModule, targetNativeModule);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function validateCoreRuntime(coreRuntimeDir, nodeCommand) {
  try {
    execFileSync(nodeCommand, ["-e", CORE_RUNTIME_CHECK_SCRIPT], {
      cwd: coreRuntimeDir,
      stdio: "ignore"
    });

    return true;
  } catch (validationError) {
    return false;
  }
}

function resolveRuntimePackageRoot(coreRuntimeDir, nodeCommand, packageName) {
  const packageJsonPath = execFileSync(
    nodeCommand,
    ["-e", `console.log(require.resolve('${packageName}/package.json'))`],
    {
      cwd: coreRuntimeDir,
      encoding: "utf8"
    }
  ).trim();

  return dirname(packageJsonPath);
}

function resolveManagedNodeRuntime() {
  const explicitNodePath = process.env.AGENT_METRICS_NODE_PATH;

  if (explicitNodePath !== undefined && explicitNodePath.trim() !== "") {
    const nodeCommand = resolve(explicitNodePath);
    const binDir = dirname(nodeCommand);

    return {
      binDir,
      nodeCommand,
      npmCommand: process.platform === "win32" ? join(binDir, "npm.cmd") : join(binDir, "npm")
    };
  }

  const runtimeRoot = join(repoRoot, ".runtime", buildManagedNodeFolderName());
  const binDir = process.platform === "win32" ? runtimeRoot : join(runtimeRoot, "bin");

  return {
    binDir,
    nodeCommand: process.platform === "win32" ? join(runtimeRoot, "node.exe") : join(binDir, "node"),
    npmCommand: process.platform === "win32" ? join(runtimeRoot, "npm.cmd") : join(binDir, "npm")
  };
}

function buildManagedNodeFolderName() {
  if (process.platform === "win32") {
    return `node-v${MANAGED_NODE_VERSION}-win-${process.arch === "arm64" ? "arm64" : "x64"}`;
  }

  if (process.platform === "darwin") {
    return `node-v${MANAGED_NODE_VERSION}-darwin-${process.arch === "x64" ? "x64" : "arm64"}`;
  }

  return `node-v${MANAGED_NODE_VERSION}-linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
}

function prependPath(pathEntry, currentPath) {
  return currentPath === "" ? pathEntry : `${pathEntry}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
}

void main().catch((error) => {
  console.error("Failed to stage desktop runtime bundle.", error);
  process.exit(1);
});
