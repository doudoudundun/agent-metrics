import { describe, expect, it } from "vitest";
import { resolveTimeScope } from "./time-scope.js";

describe("resolveTimeScope", () => {
  const now = new Date("2026-05-27T10:30:00.000Z");

  it("defaults to calendar day using the local offset", () => {
    const scope = resolveTimeScope({}, { now, timezone: "Asia/Shanghai", offsetMinutes: 480 });

    expect(scope).toMatchObject({
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z"
    });
  });

  it("uses Monday as the start of the current calendar week", () => {
    const scope = resolveTimeScope(
      { mode: "calendar", range: "week" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope).toMatchObject({
      mode: "calendar",
      range: "week",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-24T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z"
    });
  });

  it("uses the first day of the month for calendar month", () => {
    const scope = resolveTimeScope(
      { mode: "calendar", range: "month" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope).toMatchObject({
      mode: "calendar",
      range: "month",
      timezone: "Asia/Shanghai",
      windowStart: "2026-04-30T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z"
    });
  });

  it("treats rolling month as the last 30 days", () => {
    const scope = resolveTimeScope(
      { mode: "rolling", range: "month" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope).toMatchObject({
      mode: "rolling",
      range: "month",
      timezone: "Asia/Shanghai",
      windowStart: "2026-04-27T10:30:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z"
    });
  });

  it("returns no bounds for lifetime mode", () => {
    const scope = resolveTimeScope(
      { mode: "lifetime", range: "week" },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope).toMatchObject({
      mode: "lifetime",
      range: "week",
      timezone: "Asia/Shanghai",
      windowStart: null,
      windowEnd: null
    });
  });
});
