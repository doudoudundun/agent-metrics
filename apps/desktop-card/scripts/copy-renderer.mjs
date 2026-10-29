import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(appRoot, "src", "renderer");
const destDir = join(appRoot, "dist", "renderer");

mkdirSync(destDir, { recursive: true });
cpSync(join(sourceDir, "index.html"), join(destDir, "index.html"));
cpSync(join(sourceDir, "styles.css"), join(destDir, "styles.css"));
