import { describe, expect, it } from "vitest";
import { assertProductWindowInvariant, enumerateProductWindows } from "./product-windows.js";

describe("enumerateProductWindows", () => {
  it("counts at most one main and one widget", () => {
    const enumeration = enumerateProductWindows({
      mainWindow: { id: 1, isDestroyed: () => false },
      widgetWindow: { id: 2, isDestroyed: () => false },
      widgetEnabled: true
    });
    expect(enumeration.count).toBe(2);
    expect(enumeration.main?.role).toBe("main");
    expect(enumeration.widget?.role).toBe("widget");
    expect(() => assertProductWindowInvariant(enumeration)).not.toThrow();
  });

  it("omits widget when disabled even if a stale handle exists", () => {
    const enumeration = enumerateProductWindows({
      mainWindow: { id: 1, isDestroyed: () => false },
      widgetWindow: { id: 2, isDestroyed: () => false },
      widgetEnabled: false
    });
    expect(enumeration.widget).toBeNull();
    expect(enumeration.count).toBe(1);
  });

  it("ignores destroyed windows", () => {
    const enumeration = enumerateProductWindows({
      mainWindow: { id: 1, isDestroyed: () => true },
      widgetWindow: { id: 2, isDestroyed: () => true },
      widgetEnabled: true
    });
    expect(enumeration.count).toBe(0);
  });
});
