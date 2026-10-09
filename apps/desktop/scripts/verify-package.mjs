import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedNodeFolderName, parseTargetArgs } from "./package-target.mjs";

const runtimeRequirements = [
  "cli/dist/index.js",
  "core/dist/server.js",
  "dashboard/index.html"
];
const nativeLoadScript =
  "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();";

export async function verifyPackage({ artifact, target }) {
  const runtimeRoot = await resolveRuntimeRoot(artifact);
  const files = await collectFiles(runtimeRoot);
  assertCleanContents(files, runtimeRoot);
  for (const requirement of runtimeRequirements) {
    await assertFile(join(runtimeRoot, requirement), requirement);
  }
  const nodeCommand = resolveBundledNode(runtimeRoot, target);
  const reportedTarget = execFileSync(nodeCommand, ["-p", "`${process.platform}/${process.arch}`"], {
    encoding: "utf8"
  }).trim();
  const expectedTarget = `${target.platform}/${target.arch}`;
  if (reportedTarget !== expectedTarget) {
    throw new Error(`Bundled Node reports ${reportedTarget}; expected ${expectedTarget}.`);
  }
  execFileSync(nodeCommand, ["-e", nativeLoadScript], {
    cwd: join(runtimeRoot, "core"),
    stdio: "inherit"
  });
  const dashboardHtml = await readFile(join(runtimeRoot, "dashboard", "index.html"), "utf8");
  if (!/<script[^>]+src=/i.test(dashboardHtml) || !/id=["']root["']/i.test(dashboardHtml)) {
    throw new Error("Dashboard entry does not contain the expected root and script tags.");
  }
  return { runtimeRoot, nodeCommand, fileCount: files.length };
}

async function resolveRuntimeRoot(artifact) {
  const candidates = [
    artifact,
    join(artifact, "resources", "runtime"),
    join(artifact, "Contents", "Resources", "runtime"),
    join(artifact, "resources", "app.asar.unpacked", "runtime")
  ];
  for (const candidate of candidates) {
    if (await isDirectory(join(candidate, "core"))) {
      return candidate;
    }
  }
  throw new Error(`Unable to locate the packaged runtime under ${artifact}.`);
}

async function collectFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  }
  await visit(root);
  return result;
}

function assertCleanContents(files, root) {
  const violations = files
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) =>
      /(^|\/)(\.idea|\.zcode|docs?|design|data|telemetry|tmp|tests?|__tests__)(\/|$)/i.test(file) ||
      /(^|\/)(\.tmp[^/]*|.*\.(test|spec)\.[^.]+|.*\.map)$/.test(file)
    );
  if (violations.length > 0) {
    throw new Error(`Packaged runtime contains forbidden files:\n${violations.slice(0, 20).join("\n")}`);
  }
}

async function assertFile(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`Packaged runtime is missing ${label}: ${path}`);
  }
}

function resolveBundledNode(runtimeRoot, target) {
  const runtimeDirectory = join(runtimeRoot, ".runtime", managedNodeFolderName(target));
  return target.platform === "win32" ? join(runtimeDirectory, "node.exe") : join(runtimeDirectory, "bin", "node");
}

async function isDirectory(path) {
  return (await lstat(path).catch(() => null))?.isDirectory() === true;
}

async function main() {
  const target = parseTargetArgs(process.argv.slice(2), { requireArtifact: true, resolveArtifactDefault: true });
  const result = await verifyPackage({ artifact: target.artifact, target });
  console.log(`Package verified: ${basename(result.runtimeRoot)} (${result.fileCount} runtime files).`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Package verification failed.", error);
    process.exit(1);
  });
}
