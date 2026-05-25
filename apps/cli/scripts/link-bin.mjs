import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(packageDir, "..");
const repoRootDir = join(projectDir, "..", "..");
const binDir = join(projectDir, "node_modules", ".bin");
const rootBinDir = join(repoRootDir, "node_modules", ".bin");
const unixBinPath = join(binDir, "agent-metrics");
const windowsBinPath = join(binDir, "agent-metrics.cmd");
const rootUnixBinPath = join(rootBinDir, "agent-metrics");
const rootWindowsBinPath = join(rootBinDir, "agent-metrics.cmd");

await mkdir(binDir, { recursive: true });
await mkdir(rootBinDir, { recursive: true });

await writeFile(
  unixBinPath,
  "#!/bin/sh\nDIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec node \"$DIR/../../dist/index.js\" \"$@\"\n",
  "utf8"
);
await chmod(unixBinPath, 0o755);

await writeFile(
  windowsBinPath,
  "@echo off\r\nsetlocal\r\nset \"DIR=%~dp0\"\r\nnode \"%DIR%..\\..\\dist\\index.js\" %*\r\n",
  "utf8"
);

await writeFile(
  rootUnixBinPath,
  "#!/bin/sh\nDIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec node \"$DIR/../../apps/cli/dist/index.js\" \"$@\"\n",
  "utf8"
);
await chmod(rootUnixBinPath, 0o755);

await writeFile(
  rootWindowsBinPath,
  "@echo off\r\nsetlocal\r\nset \"DIR=%~dp0\"\r\nnode \"%DIR%..\\..\\apps\\cli\\dist\\index.js\" %*\r\n",
  "utf8"
);
