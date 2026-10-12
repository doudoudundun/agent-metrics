import { describe, expect, it } from "vitest";
import {
  andWhere,
  buildToolActivityWindow,
  resolveSourceVendor,
  withScopeMetadata
} from "./query-support.js";

describe("resolveSourceVendor", () => {
  it("does not treat an unrecognized sourceVendor as all", () => {
    expect(resolveSourceVendor({ sourceVendor: "dsh" })).toBe("dsh");
    expect(resolveSourceVendor({ sourceVendor: "not-a-real-vendor" })).toBe("not-a-real-vendor");
  });

  it("keeps all as the default filter", () => {
    expect(resolveSourceVendor({})).toBe("all");
    expect(resolveSourceVendor({ sourceVendor: "all" })).toBe("all");
    expect(resolveSourceVendor({ sourceVendor: "" })).toBe("all");
  });
});

const scope = {
  mode: "custom" as const,
  range: null,
  timezone: "Asia/Shanghai",
  windowStart: "2026-03-01T00:00:00.000Z",
  windowEnd: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z"
};

describe("withScopeMetadata trend bucket", () => {
  it("promotes an agreed row bucket to the envelope", () => {
    const payload = withScopeMetadata(
      { rows: [{ bucket: "week" }, { bucket: "week" }] },
      scope
    );

    expect(payload.bucket).toBe("week");
    expect(payload.mode).toBe("custom");
  });

  it("omits the envelope bucket when rows disagree, omit it, or are empty", () => {
    const mixed = withScopeMetadata({ rows: [{ bucket: "week" }, { bucket: "month" }] }, scope);
    const legacy = withScopeMetadata({ rows: [{ label: "03-01" }] }, scope);
    const unknownBucket = withScopeMetadata({ rows: [{ bucket: "quarter" }] }, scope);
    const empty = withScopeMetadata({ rows: [] }, scope);
    const unrelated = withScopeMetadata({ rows: [{ toolName: "Read" }] }, scope);

    for (const payload of [mixed, legacy, unknownBucket, empty, unrelated]) {
      expect(payload).not.toHaveProperty("bucket");
    }
    expect(unrelated.mode).toBe("custom");
  });
});

describe("buildToolActivityWindow", () => {
  it("dates tool activity by COALESCE(started_at, finished_at) and filters on the joined session vendor", () => {
    expect(buildToolActivityWindow()).toEqual({ whereSql: "", params: [] });

    const window = buildToolActivityWindow(scope, "codex");

    expect(window.whereSql).toBe(
      " WHERE COALESCE(tool_calls.started_at, tool_calls.finished_at) >= ?" +
        " AND COALESCE(tool_calls.started_at, tool_calls.finished_at) <= ?" +
        " AND domain_sessions.source_vendor = ?"
    );
    expect(window.params).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "codex"
    ]);
  });
});

describe("andWhere", () => {
  it("joins an extra predicate to a window and opens its own WHERE clause when empty", () => {
    expect(andWhere({ whereSql: "", params: [] }, "event_type = 'prompt.submitted'")).toBe(
      " WHERE event_type = 'prompt.submitted'"
    );
    expect(
      andWhere(
        { whereSql: " WHERE timestamp >= ?", params: ["2026-03-01T00:00:00.000Z"] },
        "event_type = 'code.edit.applied'"
      )
    ).toBe(" WHERE timestamp >= ? AND event_type = 'code.edit.applied'");
  });
});
