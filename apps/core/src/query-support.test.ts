import { describe, expect, it } from "vitest";
import { resolveSourceVendor, withScopeMetadata } from "./query-support.js";

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
