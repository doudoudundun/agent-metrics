import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { appendJsonLine } from "./jsonl.js";

describe("appendJsonLine", () => {
  it("creates parent directories and appends a json line", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-"));
    const filePath = join(root, "nested", "events.jsonl");

    await appendJsonLine(filePath, { type: "session.started" });

    const contents = await readFile(filePath, "utf8");

    expect(contents).toBe('{"type":"session.started"}\n');
  });
});
