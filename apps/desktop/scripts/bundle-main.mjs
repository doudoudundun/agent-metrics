import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(desktopRoot, "dist", "main-v2.js");
const require = createRequire(import.meta.url);

let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  ({ build } = require(join(desktopRoot, "../../node_modules/esbuild/lib/main.js")));
}

await mkdir(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: desktopRoot,
  entryPoints: [join(desktopRoot, "src", "main-v2.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  sourcemap: true,
  packages: "bundle",
  external: ["electron"]
});
