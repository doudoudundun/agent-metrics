import { describe, expect, it } from "vitest";
import {
  buildScopeLabel,
  buildScopeSearchParams,
  formatScopeDateTime,
  isSameScope
} from "./time-scope";

describe("time scope helpers", () => {
  it("labels the default calendar day scope as Today", () => {
    expect(buildScopeLabel({ mode: "calendar", range: "day" })).toBe("Today");
  });

  it("labels the lifetime scope as All Time", () => {
    expect(buildScopeLabel({ mode: "lifetime", range: "day" })).toBe("All Time");
  });

  it("builds query parameters for rolling scopes", () => {
    expect(buildScopeSearchParams({ mode: "rolling", range: "week" }).toString()).toBe(
      "mode=rolling&range=week"
    );
  });

  it("matches scopes by mode and range", () => {
    expect(
      isSameScope({ mode: "calendar", range: "day" }, { mode: "calendar", range: "day" })
    ).toBe(true);
    expect(
      isSameScope({ mode: "calendar", range: "day" }, { mode: "calendar", range: "week" })
    ).toBe(false);
  });

  it("formats timestamps using the API timezone", () => {
    expect(formatScopeDateTime("2026-05-27T01:30:00.000Z", "America/Los_Angeles")).toBe(
      "2026-05-26 18:30:00"
    );
  });
});
