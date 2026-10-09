import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadDesktopSettingsV2, migrateLegacySettings, saveDesktopSettingsV2 } from "./desktop-settings-v2.js";

describe("Desktop settings v2", () => {
  it("maps legacy floating and orb fields into one recoverable widget configuration", () => {
    const settings = migrateLegacySettings({
      closeBehavior: "quit-app",
      enableOrb: true,
      showOrbOnStartup: true,
      orbCollapsed: false,
      orbDockEdge: "left",
      orbBounds: { x: 12, y: 30, width: 104, height: 104 },
      floatingWindowBounds: { x: 40, y: 50, width: 440, height: 320 }
    });

    expect(settings).toMatchObject({
      settingsVersion: 2,
      closeBehavior: "quit-app",
      widgetEnabled: true,
      showWidgetOnStartup: true,
      widgetModeOnStartup: "pinned",
      // Spec §16.8: no legacy source for widgetModeAfterOpenMain; default "collapsed".
      widgetModeAfterOpenMain: "collapsed",
      widgetDockEdge: "left"
    });
    // Spec §16.8 widgetBounds rule: source rectangle selects display and
    // vertical-center ratio only; the migrated bounds are the centrally defined
    // collapsed size (88x88) at the selected dock edge, not the raw legacy rect.
    expect(settings.widgetBounds).toEqual({ x: 12, y: 46, width: 88, height: 88 });
  });

  it("section 16.8: preferredSurface drives widgetEnabled/mode/startup when enableOrb is absent", () => {
    // preferredSurface=floating-window, no enableOrb → widgetEnabled true per row 1.
    const floating = migrateLegacySettings({
      preferredSurface: "floating-window",
      reopenFloatingWindowOnStartup: true,
      floatingWindowBounds: { x: 40, y: 50, width: 440, height: 320 }
    });
    expect(floating.widgetEnabled).toBe(true);
    expect(floating.showWidgetOnStartup).toBe(true);
    // preferred floating-window with reopen true → pinned.
    expect(floating.widgetModeOnStartup).toBe("pinned");

    // preferredSurface=main-window → widgetEnabled falls back to default (true),
    // showWidgetOnStartup falls back to default.
    const main = migrateLegacySettings({ preferredSurface: "main-window" });
    expect(main.widgetEnabled).toBe(true);
    expect(main.showWidgetOnStartup).toBe(true);
    expect(main.showMainWindowOnStartup).toBe(true);

    // preferredSurface=orb, orbCollapsed=true → collapsed.
    const collapsedOrb = migrateLegacySettings({
      preferredSurface: "orb",
      orbCollapsed: true,
      orbBounds: { x: 0, y: 0, width: 88, height: 88 }
    });
    expect(collapsedOrb.widgetModeOnStartup).toBe("collapsed");
  });

  it("section 16.8: disabling the widget forces showWidgetOnStartup false", () => {
    const settings = migrateLegacySettings({
      enableOrb: false,
      showOrbOnStartup: true
    });
    expect(settings.widgetEnabled).toBe(false);
    expect(settings.showWidgetOnStartup).toBe(false);
  });

  it("writes only version 2 settings through an atomic temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-settings-v2-"));
    const filePath = join(root, "settings.json");
    const legacy = { enableOrb: false, orbBounds: { x: 1, y: 2, width: 88, height: 88 } };
    await writeFile(filePath, JSON.stringify(legacy), "utf8");
    const migrated = await loadDesktopSettingsV2(filePath);
    await saveDesktopSettingsV2(filePath, migrated);

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(parsed.settingsVersion).toBe(2);
    expect(parsed).not.toHaveProperty("enableOrb");
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
