import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(appRoot, "src", "renderer");
const destDir = join(appRoot, "dist", "renderer");

mkdirSync(destDir, { recursive: true });
cpSync(join(sourceDir, "index.html"), join(destDir, "index.html"));
cpSync(join(sourceDir, "styles.css"), join(destDir, "styles.css"));

if (process.platform === "win32") {
  const compiler = join(process.env.SystemRoot || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const source = join(appRoot, "native", "DesktopHost.cs");
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const nativeDir = join(appRoot, "dist", "native");
  const executable = `desktop-host-${hash}.exe`;
  mkdirSync(nativeDir, { recursive: true });
  if (!existsSync(join(nativeDir, executable))) {
    const result = spawnSync(compiler, [
    "/nologo", "/optimize+", "/target:winexe", "/platform:anycpu",
      `/out:${join(nativeDir, executable)}`, source
    ], { windowsHide: true, encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw result.error || new Error(result.stdout || result.stderr || "Desktop host compilation failed.");
    }
  }
  writeFileSync(join(nativeDir, "manifest.json"), JSON.stringify({ executable }));
}
