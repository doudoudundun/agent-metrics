import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const stagingRoot = join(desktopRoot, ".runtime-bundle");
const dashboardDist = join(repoRoot, "apps", "dashboard", "dist");
const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";

async function main() {
  await ensureBuildArtifacts();

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  deployWorkspacePackage("@agent-metrics/cli", join(stagingRoot, "cli"));
  deployWorkspacePackage("@agent-metrics/core", join(stagingRoot, "core"));
  await cp(dashboardDist, join(stagingRoot, "dashboard"), { recursive: true });
}

async function ensureBuildArtifacts() {
  await stat(dashboardDist);
}

function deployWorkspacePackage(packageName, destination) {
  execFileSync(
    corepackCommand,
    ["pnpm", "--dir", repoRoot, "deploy", "--legacy", "--filter", packageName, "--prod", destination],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );
}

void main().catch((error) => {
  console.error("Failed to stage desktop runtime bundle.", error);
  process.exit(1);
});
