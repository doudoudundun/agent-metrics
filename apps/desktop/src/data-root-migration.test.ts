import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyDataRoots } from "./data-root-migration.js";

describe("migrateLegacyDataRoots", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("merges legacy event streams into the canonical data root without duplicating events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-data-root-"));
    roots.push(root);
    const dataRoot = join(root, "Agent Metrics", "agent-metrics-data");
    const legacyRoot = join(root, "Electron", "agent-metrics-data");

    await mkdir(join(dataRoot, "data", "events"), { recursive: true });
    await mkdir(join(legacyRoot, "data", "events"), { recursive: true });
    await writeFile(
      join(dataRoot, "data", "events", "events.jsonl"),
      `${JSON.stringify({ event_id: "evt_existing", type: "session_started" })}\n`,
      "utf8"
    );
    await writeFile(
      join(legacyRoot, "data", "events", "events.jsonl"),
      [
        JSON.stringify({ event_id: "evt_existing", type: "session_started" }),
        JSON.stringify({ event_id: "evt_legacy", type: "tool_execution" })
      ].join("\n") + "\n",
      "utf8"
    );

    const result = await migrateLegacyDataRoots({
      dataRoot,
      legacyDataRoots: [legacyRoot],
      now: () => new Date("2026-06-08T09:00:00.000Z")
    });

    const merged = await readFile(join(dataRoot, "data", "events", "events.jsonl"), "utf8");
    expect(merged.trim().split("\n").map((line) => JSON.parse(line).event_id)).toEqual([
      "evt_existing",
      "evt_legacy"
    ]);
    expect(result.migrated).toBe(true);
    expect(result.appendedLines).toEqual({
      "data/events/events.jsonl": 1,
      "data/hooks/raw/claude-code.jsonl": 0
    });
    await expect(stat(result.backupPath ?? "")).resolves.toEqual(expect.anything());
  });
});
