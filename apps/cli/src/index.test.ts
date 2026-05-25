import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runWrappedSession } from "./index.js";

describe("runWrappedSession", () => {
  it("writes session.started and session.ended events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-"));
    const outputFile = join(root, "events.jsonl");

    const exitCode = await runWrappedSession({
      args: ["claude", "--version"],
      eventLogPath: outputFile,
      workspacePath: root,
      runCommand: async () => 0
    });

    const lines = (await readFile(outputFile, "utf8")).trim().split("\n");

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\"type\":\"session.started\"");
    expect(lines[1]).toContain("\"type\":\"session.ended\"");
  });
});
