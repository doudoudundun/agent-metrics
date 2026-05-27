import { describe, expect, it } from "vitest";
import { buildScopeLabel, buildScopeSearchParams, isSameScope } from "./time-scope";

describe("time scope helpers", () => {
  it("labels the default calendar day scope as Today", () => {
    expect(buildScopeLabel({ mode: "calendar", range: "day" })).toBe("Today");
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
});
