import { appendFile } from "node:fs/promises";
import { ensureParentDir } from "./fs.js";
export async function appendJsonLine(filePath, value) {
    await ensureParentDir(filePath);
    await appendFile(filePath, JSON.stringify(value) + "\n", "utf8");
}
