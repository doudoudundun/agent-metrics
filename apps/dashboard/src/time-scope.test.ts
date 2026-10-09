import { describe, expect, it } from "vitest";
import {
  buildScopeLabel,
  buildScopeSearchParams,
  formatScopeDateTime,
  isSameScope,
  toolbarDatesForScope
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

  it("builds query parameters and labels for a custom range", () => {
    const startAt = "2026-07-31T16:00:00.000Z";
    const endAt = "2026-08-07T15:59:59.999Z";
    const params = buildScopeSearchParams({ mode: "custom", startAt, endAt });
    expect(params.get("mode")).toBe("custom");
    expect(params.get("startAt")).toBe(startAt);
    expect(params.get("endAt")).toBe(endAt);
    expect(buildScopeLabel({ mode: "custom", startAt, endAt })).toContain("2026");
  });

  it("matches scopes by mode and range", () => {
    expect(
      isSameScope({ mode: "calendar", range: "day" }, { mode: "calendar", range: "day" })
    ).toBe(true);
    expect(
      isSameScope({ mode: "calendar", range: "day" }, { mode: "calendar", range: "week" })
    ).toBe(false);
  });

  it("fills toolbar dates from the active preset", () => {
    const now = new Date("2026-09-01T12:00:00+08:00");
    expect(toolbarDatesForScope({ mode: "calendar", range: "day" }, now)).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-01"
    });
    expect(toolbarDatesForScope({ mode: "calendar", range: "week" }, now).startDate).toBe("2026-08-31");
    expect(toolbarDatesForScope({ mode: "lifetime", range: "day" }, now)).toEqual({
      startDate: "",
      endDate: ""
    });
  });

  it("formats timestamps using the API timezone", () => {
    expect(formatScopeDateTime("2026-05-27T01:30:00.000Z", "America/Los_Angeles")).toBe(
      "2026-05-26 18:30:00"
    );
  });
});
