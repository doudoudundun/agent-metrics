import { describe, expect, it } from "vitest";
import { diffTextStats } from "./diff";

describe("diffTextStats", () => {
  it("reports insertions and deletions", () => {
    const result = diffTextStats("a\nb\n", "a\nc\nb\n");
    expect(result).toEqual({ insertions: 1, deletions: 0 });
  });

  it("counts a larger insertion block without inventing deletions", () => {
    const result = diffTextStats("a\nb\nc\n", "a\nx\ny\nb\nc\n");
    expect(result).toEqual({ insertions: 2, deletions: 0 });
  });

  it("ignores trailing newline-only differences", () => {
    const result = diffTextStats("a\n", "a\n");
    expect(result).toEqual({ insertions: 0, deletions: 0 });
  });
});
