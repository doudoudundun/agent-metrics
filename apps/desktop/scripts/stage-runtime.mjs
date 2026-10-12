import { copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BUILD_TARGETS, DEPLOY_TARGETS } from "./stage-runtime-config.mjs";
import {
  assertNativeTarget,
  managedNodeFolderName,
  parseTargetArgs,
  resolveManagedNodeRuntime
} from "./package-target.mjs";
import { pruneRuntimeArtifacts } from "./prune-runtime-artifacts.mjs";
import { sanitizeRuntimeLinks } from "./sanitize-runtime-links.mjs";

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
  const target = parseTargetArgs();
  assertNativeTarget(target);
  const runtime = resolveManagedNodeRuntime(target);
  await ensureBuildArtifacts();

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  for (const target of DEPLOY_TARGETS) {
    const destination = join(stagingRoot, target.folderName);
    deployWorkspacePackage(target.packageName, destination, runtime);
    await sanitizeRuntimeLinks(destination);
    await pruneRuntimeArtifacts(destination);

    if (target.packageName === "@agent-metrics/core") {
      await ensureCoreNativeRuntime(destination, runtime);
    }
  }

  await cp(dashboardDist, join(stagingRoot, "dashboard"), { recursive: true });
  await pruneRuntimeArtifacts(join(stagingRoot, "dashboard"));
  await stageManagedNodeRuntime(target, runtime);
}

async function stageManagedNodeRuntime(target, runtime) {
  const runtimeDestination = join(stagingRoot, ".runtime", managedNodeFolderName(target));
  await stat(runtime.nodeCommand);
  const nodeDestination = target.platform === "win32"
    ? join(runtimeDestination, "node.exe")
    : join(runtimeDestination, "bin", "node");
  await mkdir(dirname(nodeDestination), { recursive: true });
  await copyFile(runtime.nodeCommand, nodeDestination);
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

function deployWorkspacePackage(packageName, destination, runtime) {
  execFileSync(
    corepackCommand,
    ["pnpm", "--dir", repoRoot, "deploy", "--legacy", "--filter", packageName, "--prod", destination],
    {
      ...corepackExecOptions,
      // Deploy triggers install scripts (better-sqlite3). Prepend the managed
      // Node runtime so those scripts see its ABI and take the published
      // prebuild; the system Node may be a newer ABI that only builds from
      // source, which fails on machines without VS Build Tools.
      env: {
        ...process.env,
        PATH: prependPath(runtime.binDir, process.env.PATH ?? "")
      }
    }
  );
}

async function ensureCoreNativeRuntime(coreRuntimeDir, runtime) {
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

function prependPath(pathEntry, currentPath) {
  return currentPath === "" ? pathEntry : `${pathEntry}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
}

void main().catch((error) => {
  console.error("Failed to stage desktop runtime bundle.", error);
  process.exit(1);
});
