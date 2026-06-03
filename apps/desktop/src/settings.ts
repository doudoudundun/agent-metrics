import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeDesktopSettings, type DesktopSettings } from "./window-state.js";

export async function loadDesktopSettings(filePath: string): Promise<DesktopSettings> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const errorWithCode = error as NodeJS.ErrnoException;

    if (errorWithCode.code === "ENOENT") {
      return sanitizeDesktopSettings(undefined);
    }

    throw new Error(`Failed to read desktop settings at ${filePath}`, { cause: error });
  }

  try {
    return sanitizeDesktopSettings(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse desktop settings at ${filePath}`, { cause: error });
    }

    throw error;
  }
}

export async function saveDesktopSettings(
  filePath: string,
  settings: DesktopSettings
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(settings, null, 2));
  } catch (error) {
    throw new Error(`Failed to save desktop settings at ${filePath}`, { cause: error });
  }
}
