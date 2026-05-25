import { describe, expect, it } from "vitest";
import { toCsv, toJson } from "./index.js";

describe("toCsv", () => {
  it("serializes records with a header row", () => {
    expect(toCsv([{ toolName: "Read", count: 4 }])).toBe("toolName,count\nRead,4");
  });
});

describe("toJson", () => {
  it("serializes values with stable indentation", () => {
    expect(toJson([{ toolName: "Read", count: 4 }])).toBe(
      '[\n  {\n    "toolName": "Read",\n    "count": 4\n  }\n]'
    );
  });
});
