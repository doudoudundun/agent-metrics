import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export async function ensureParentDir(filePath) {
    await mkdir(dirname(filePath), { recursive: true });
}
