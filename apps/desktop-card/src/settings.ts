import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeBounds, type WindowBounds } from "./layout.js";

export type CardSettings = {
  alwaysOnTop: boolean;
  bounds: WindowBounds | null;
};

export function defaultCardSettings(): CardSettings {
  return {
    alwaysOnTop: false,
    bounds: null
  };
}

export function sanitizeCardSettings(value: unknown): CardSettings {
  const defaults = defaultCardSettings();
  if (value === null || typeof value !== "object") {
    return defaults;
  }
  const record = value as Record<string, unknown>;
  return {
    alwaysOnTop: false,
    bounds: sanitizeBounds(record.bounds)
  };
}

export async function loadCardSettings(filePath: string): Promise<CardSettings> {
  try {
    const raw = await readFile(filePath, "utf8");
    return sanitizeCardSettings(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return defaultCardSettings();
    }
    return defaultCardSettings();
  }
}

export async function saveCardSettings(filePath: string, settings: CardSettings): Promise<void> {
  const parsed = sanitizeCardSettings(settings);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
