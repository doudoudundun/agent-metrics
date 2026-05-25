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

  it("runs the wrapped command with the default runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-"));
    const outputFile = join(root, "events.jsonl");

    const exitCode = await runWrappedSession({
      args: [process.execPath, "-e", "process.exit(7)"],
      eventLogPath: outputFile,
      workspacePath: root
    });

    expect(exitCode).toBe(7);
  });

  it("writes session.ended when the wrapped command rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-"));
    const outputFile = join(root, "events.jsonl");

    await expect(
      runWrappedSession({
        args: ["ignored"],
        eventLogPath: outputFile,
        workspacePath: root,
        runCommand: async () => {
          throw new Error("launch failed");
        }
      })
    ).rejects.toThrow("launch failed");

    const lines = (await readFile(outputFile, "utf8")).trim().split("\n");
    const endedEvent = JSON.parse(lines[1]) as { exit_code?: number | null };

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("\"type\":\"session.ended\"");
    expect(endedEvent.exit_code).toBeNull();
  });
});
