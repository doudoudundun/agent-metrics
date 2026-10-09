import { describe, expect, it } from "vitest";
import { resolveSourceVendor } from "./query-support.js";

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
