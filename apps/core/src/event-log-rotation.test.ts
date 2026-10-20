import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEventLogCursor, readEventLogIncremental } from "./raw-ingest.js";
import {
  DEFAULT_EVENT_LOG_MAX_BYTES,
  DEFAULT_EVENT_LOG_RETENTION_DAYS,
  compressEventLogArchive,
  resolveEventLogRotationConfig,
  rotateEventLogIfNeeded
} from "./event-log-rotation.js";

const gunzipAsync = promisify(gunzip);

const NOW = new Date("2026-10-20T12:00:00.000Z");

function eventLine(id: string, timestamp: string): string {
  return `${JSON.stringify({ event_id: id, type: "session.started", timestamp })}\n`;
}

async function makeLogFile(lines: string[]): Promise<{ root: string; eventLogPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-rotation-"));
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(eventLogPath, lines.join(""), "utf8");
  return { root, eventLogPath };
}

describe("event log rotation config", () => {
  it("falls back to the documented defaults", () => {
    expect(resolveEventLogRotationConfig({})).toEqual({
      maxBytes: DEFAULT_EVENT_LOG_MAX_BYTES,
      retentionDays: DEFAULT_EVENT_LOG_RETENTION_DAYS
    });
  });

  it("reads overrides and ignores invalid values", () => {
    expect(
      resolveEventLogRotationConfig({
        AGENT_METRICS_EVENT_LOG_MAX_BYTES: "1024",
        AGENT_METRICS_EVENT_LOG_RETENTION_DAYS: "3"
      })
    ).toEqual({ maxBytes: 1024, retentionDays: 3 });

    expect(
      resolveEventLogRotationConfig({
        AGENT_METRICS_EVENT_LOG_MAX_BYTES: "not-a-number",
        AGENT_METRICS_EVENT_LOG_RETENTION_DAYS: "-5"
      })
    ).toEqual({
      maxBytes: DEFAULT_EVENT_LOG_MAX_BYTES,
      retentionDays: DEFAULT_EVENT_LOG_RETENTION_DAYS
    });
  });
});

describe("rotateEventLogIfNeeded", () => {
  it("does nothing when the log is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-rotation-missing-"));
    const result = await rotateEventLogIfNeeded({
      eventLogPath: join(root, "events.jsonl"),
      maxBytes: 1,
      retentionDays: 7,
      now: NOW
    });

    expect(result.rotated).toBe(false);
    expect(result.skipReason).toBe("missing");
    expect(result.archivePath).toBeNull();
  });

  it("leaves the log untouched below the threshold", async () => {
    const { eventLogPath } = await makeLogFile([eventLine("a", NOW.toISOString())]);
    const before = await readFile(eventLogPath, "utf8");

    const result = await rotateEventLogIfNeeded({
      eventLogPath,
      maxBytes: 1024 * 1024,
      retentionDays: 7,
      now: NOW
    });

    expect(result.rotated).toBe(false);
    expect(result.skipReason).toBe("below-threshold");
    expect(await readFile(eventLogPath, "utf8")).toBe(before);
  });

  it("keeps the retention window, archives the original, and reports counts", async () => {
    const lines = [
      eventLine("old-1", "2026-09-01T00:00:00.000Z"),
      eventLine("old-2", "2026-10-01T00:00:00.000Z"),
      eventLine("new-1", "2026-10-19T00:00:00.000Z"),
      eventLine("new-2", "2026-10-20T11:59:00.000Z")
    ];
    const { root, eventLogPath } = await makeLogFile(lines);

    const result = await rotateEventLogIfNeeded({
      eventLogPath,
      maxBytes: 100,
      retentionDays: 7,
      now: NOW
    });

    expect(result.rotated).toBe(true);
    expect(result.skipReason).toBeNull();
    expect(result.keptLines).toBe(2);
    expect(result.droppedLines).toBe(2);
    expect(result.droppedMalformedLines).toBe(0);
    expect(result.cutoffIso).toBe("2026-10-13T12:00:00.000Z");
    expect(result.originalBytes).toBeGreaterThan(100);

    const kept = await readFile(eventLogPath, "utf8");
    expect(kept).toContain("new-1");
    expect(kept).toContain("new-2");
    expect(kept).not.toContain("old-1");
    expect(kept).not.toContain("old-2");
    expect(result.keptBytes).toBe(Buffer.byteLength(kept, "utf8"));

    const archiveDir = join(root, "archive");
    const archived = await readdir(archiveDir);
    expect(archived).toHaveLength(1);
    expect(result.archivePath).toBe(join(archiveDir, archived[0]!));
    // The archive is a complete cold copy of the pre-rotation log.
    expect(await readFile(result.archivePath!, "utf8")).toBe(lines.join(""));

    // No rotation temp files left behind.
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("drops unparsable lines instead of dragging them forward forever", async () => {
    const { eventLogPath } = await makeLogFile([
      "{not-json}\n",
      `${JSON.stringify({ event_id: "no-timestamp" })}\n`,
      eventLine("kept", "2026-10-20T00:00:00.000Z")
    ]);

    const result = await rotateEventLogIfNeeded({
      eventLogPath,
      maxBytes: 10,
      retentionDays: 7,
      now: NOW
    });

    expect(result.rotated).toBe(true);
    expect(result.keptLines).toBe(1);
    expect(result.droppedLines).toBe(2);
    expect(result.droppedMalformedLines).toBe(2);
    expect(await readFile(eventLogPath, "utf8")).toContain("kept");
  });

  it("forces the projector to restart from offset 0 after rotation", async () => {
    const lines: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      lines.push(eventLine(`event-${index}`, "2026-09-15T00:00:00.000Z"));
    }
    lines.push(eventLine("recent", "2026-10-20T00:00:00.000Z"));
    const { eventLogPath } = await makeLogFile(lines);

    // Cursor committed against the pre-rotation file.
    const staleCursor = await createEventLogCursor(eventLogPath, (await stat(eventLogPath)).size);

    const result = await rotateEventLogIfNeeded({
      eventLogPath,
      maxBytes: 100,
      retentionDays: 7,
      now: NOW
    });
    expect(result.rotated).toBe(true);

    const read = await readEventLogIncremental({
      filePath: eventLogPath,
      cursor: staleCursor
    });

    expect(read.reset).toBe(true);
    expect(read.records.map((record) => record.line)).toEqual([
      JSON.stringify({ event_id: "recent", type: "session.started", timestamp: "2026-10-20T00:00:00.000Z" })
    ]);
  });
});

describe("compressEventLogArchive", () => {
  it("gzips the archive and removes the plain copy", async () => {
    const { root } = await makeLogFile([]);
    const archivePath = join(root, "events-20261020-120000.jsonl");
    const payload = `${eventLine("a", NOW.toISOString())}${eventLine("b", NOW.toISOString())}`;
    await writeFile(archivePath, payload, "utf8");

    const gzPath = await compressEventLogArchive(archivePath);

    expect(gzPath).toBe(`${archivePath}.gz`);
    expect((await gunzipAsync(await readFile(gzPath))).toString("utf8")).toBe(payload);
    await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a no-op for an already compressed path", async () => {
    const { root } = await makeLogFile([]);
    const gzPath = join(root, "events.jsonl.gz");
    await writeFile(gzPath, "x", "utf8");
    expect(await compressEventLogArchive(gzPath)).toBe(gzPath);
  });
});
