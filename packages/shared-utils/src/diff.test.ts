import { describe, expect, it } from "vitest";
import { diffTextStats } from "./diff";

describe("diffTextStats", () => {
  it("reports insertions and deletions", () => {
    const result = diffTextStats("a\nb\n", "a\nc\nb\n");
    expect(result).toEqual({ insertions: 1, deletions: 0 });
  });
});
