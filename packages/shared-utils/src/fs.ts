import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
