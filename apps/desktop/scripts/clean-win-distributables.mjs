import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { movePathAside } from "./clean-release.mjs";

const currentDir = dirname(fileURLToPath(import.meta.url));
const releaseRoot = resolve(currentDir, "..", "release");

/** Move aside prior NSIS/zip distributables so a fresh package does not mix versions. */
export async function cleanWinDistributables() {
  let entries = [];
  try {
    entries = await readdir(releaseRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name;
    const isSetup = /^Agent Metrics-Setup-.*\.exe$/i.test(name) || /^AgentMetrics.?Setup.*\.exe$/i.test(name);
    const isZip = /^Agent Metrics-.*-(win|windows)-.*\.zip$/i.test(name) || /^Agent Metrics-.*\.zip$/i.test(name);
    const isBuilderMeta = /^(latest|builder-.*)\.ya?ml$/i.test(name) || name.endsWith(".blockmap");
    if (isSetup || isZip || isBuilderMeta) {
      await movePathAside(join(releaseRoot, name));
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cleanWinDistributables().catch((error) => {
    console.error("Failed to clean Windows distributables.", error);
    process.exit(1);
  });
}
