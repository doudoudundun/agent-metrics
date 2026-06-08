import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadParserState, saveParserState } from "./parser-state.js";

describe("loadParserState", () => {
  it("keeps a valid nextLine when seen raw event ids are malformed", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parser-state-"));
    const statePath = join(repoRoot, "parser-state.json");

    await writeFile(
      statePath,
      JSON.stringify({
        nextLine: 5470,
        seenRawEventIds: {}
      }),
      "utf8"
    );

    await expect(loadParserState(statePath)).resolves.toEqual({
      nextLine: 5470,
      seenRawEventIds: []
    });
  });
});

describe("saveParserState", () => {
  it("does not overwrite a newer parser cursor with an older cursor", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parser-state-"));
    const statePath = join(repoRoot, "parser-state.json");

    await saveParserState(statePath, {
      nextLine: 100,
      seenRawEventIds: ["raw_100"]
    });
    await saveParserState(statePath, {
      nextLine: 20,
      seenRawEventIds: ["raw_20"]
    });

    await expect(loadParserState(statePath)).resolves.toEqual({
      nextLine: 100,
      seenRawEventIds: ["raw_100", "raw_20"]
    });
  });
});
