import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadDesktopSettings, saveDesktopSettings } from "./settings.js";
import {
  clampBoundsToDisplay,
  defaultDesktopSettings,
  sanitizeDesktopSettings
} from "./window-state.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempSettingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-metrics-desktop-"));
  tempDirs.push(directory);
  return join(directory, "settings.json");
}

describe("window state", () => {
  it("clamps an off-screen floating window back into the visible display", () => {
    expect(
      clampBoundsToDisplay(
        { x: -1800, y: -900, width: 420, height: 260 },
        { x: 0, y: 0, width: 1440, height: 900 }
      )
    ).toEqual({ x: 0, y: 0, width: 420, height: 260 });
  });

  it("returns hide-to-tray as the default close behavior", () => {
    expect(defaultDesktopSettings().closeBehavior).toBe("hide-to-tray");
  });

  it("falls back to defaults when the settings file is missing", async () => {
    const filePath = await createTempSettingsPath();

    await expect(loadDesktopSettings(filePath)).resolves.toEqual(defaultDesktopSettings());
  });

  it("sanitizes invalid persisted values and partial bounds objects", async () => {
    const filePath = await createTempSettingsPath();

    await writeFile(
      filePath,
      JSON.stringify({
        closeBehavior: "minimize",
        launchAtLogin: "yes",
        showMainWindowOnStartup: false,
        reopenFloatingWindowOnStartup: true,
        preferredSurface: "detached-window",
        mainWindowBounds: { x: 10, y: 20, width: 800 },
        floatingWindowBounds: { x: 12, y: 24, width: 500, height: 300, pinned: true }
      })
    );

    await expect(loadDesktopSettings(filePath)).resolves.toEqual({
      ...defaultDesktopSettings(),
      showMainWindowOnStartup: false,
      reopenFloatingWindowOnStartup: true,
      floatingWindowBounds: { x: 12, y: 24, width: 500, height: 300 }
    });
  });

  it("rejects persisted bounds with non-positive sizes", async () => {
    const filePath = await createTempSettingsPath();

    await writeFile(
      filePath,
      JSON.stringify({
        mainWindowBounds: { x: 10, y: 20, width: 0, height: 500 },
        floatingWindowBounds: { x: 12, y: 24, width: -5, height: 300 }
      })
    );

    await expect(loadDesktopSettings(filePath)).resolves.toEqual(defaultDesktopSettings());
  });

  it("rejects persisted bounds with non-finite numbers", async () => {
    expect(
      sanitizeDesktopSettings({
        mainWindowBounds: { x: 10, y: 20, width: 800, height: Number.NaN },
        floatingWindowBounds: { x: 12, y: Number.POSITIVE_INFINITY, width: 500, height: 300 }
      })
    ).toEqual(defaultDesktopSettings());
  });

  it("throws a contextual error for malformed JSON", async () => {
    const filePath = await createTempSettingsPath();

    await writeFile(filePath, "{ not-valid-json");

    await expect(loadDesktopSettings(filePath)).rejects.toThrow(
      `Failed to parse desktop settings at ${filePath}`
    );
  });

  it("saves and reloads a settings round trip", async () => {
    const filePath = await createTempSettingsPath();
    const settings = {
      closeBehavior: "quit-app" as const,
      launchAtLogin: true,
      showMainWindowOnStartup: false,
      reopenFloatingWindowOnStartup: true,
      preferredSurface: "floating-window" as const,
      mainWindowBounds: { x: 100, y: 120, width: 900, height: 700 },
      floatingWindowBounds: { x: 20, y: 30, width: 450, height: 320 }
    };

    await saveDesktopSettings(filePath, settings);

    await expect(loadDesktopSettings(filePath)).resolves.toEqual(settings);
    await expect(readFile(filePath, "utf8")).resolves.toContain('"closeBehavior": "quit-app"');
  });
});
