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

  it("uses explicit startAt/endAt for a custom range", () => {
    const scope = resolveTimeScope(
      {
        mode: "custom",
        startAt: "2026-08-01T00:00:00.000+08:00",
        endAt: "2026-08-07T23:59:59.999+08:00"
      },
      { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
    );

    expect(scope).toMatchObject({
      mode: "custom",
      range: null,
      timezone: "Asia/Shanghai",
      windowStart: "2026-07-31T16:00:00.000Z",
      windowEnd: "2026-08-07T15:59:59.999Z"
    });
  });

  it("rejects a custom range without timestamps", () => {
    expect(() =>
      resolveTimeScope({ mode: "custom" }, { now, timezone: "Asia/Shanghai", offsetMinutes: 480 })
    ).toThrow("Custom time scope requires startAt and endAt");
  });

  it("rejects a custom range whose start is not earlier than end", () => {
    expect(() =>
      resolveTimeScope(
        {
          mode: "custom",
          startAt: "2026-08-07T00:00:00.000Z",
          endAt: "2026-08-01T00:00:00.000Z"
        },
        { now, timezone: "Asia/Shanghai", offsetMinutes: 480 }
      )
    ).toThrow("startAt earlier than endAt");
  });
});
