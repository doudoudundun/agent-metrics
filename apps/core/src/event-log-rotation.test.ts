import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readTrustedIngestionCursor, repairBrokenIngestionCursor } from "./event-log-projector.js";
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

function createCursorDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE ingestion_state (stream_name TEXT PRIMARY KEY, offset_bytes INTEGER, size_bytes INTEGER, mtime_ms REAL, file_identity TEXT, committed_prefix_hash TEXT)`);
  return db;
}

async function rotateWithSavedCursor(db: Database.Database, eventLogPath: string) {
  const trustedCursor = await readTrustedIngestionCursor({ db: db as never, eventLogPath });
  const rotation = await rotateEventLogIfNeeded({
    eventLogPath, maxBytes: 100, retentionDays: 7, now: NOW,
    committedOffset: trustedCursor?.committedOffset
  });
  expect(rotation.rotated).toBe(true);
  await repairBrokenIngestionCursor({
    db: db as never, eventLogPath, resetForRotatedLog: true,
    committedOffsetAfterRotation: rotation.committedOffsetAfterRotation
  });
  const saved = db.prepare("SELECT * FROM ingestion_state").get() as {
    offset_bytes: number; file_identity: string; committed_prefix_hash: string;
  };
  const read = await readEventLogIncremental({ filePath: eventLogPath, cursor: {
    committedOffset: saved.offset_bytes, fileIdentity: saved.file_identity, committedPrefixHash: saved.committed_prefix_hash
  } });
  return { rotation, saved, read };
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

  it("rejects an unmapped stale pre-rotation cursor", async () => {
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

  it("maps a trusted caught-up cursor to retained EOF without replaying projections", async () => {
    const lines = [
      eventLine("old", "2026-09-15T00:00:00.000Z"),
      eventLine("recent-中文", "2026-10-20T00:00:00.000Z").replace(/\n$/u, "\r\n"),
      "\r\n",
      "{not-json}\n",
      eventLine("recent-2", "2026-10-20T00:00:00.000Z")
    ];
    const { eventLogPath } = await makeLogFile(lines);
    const originalSize = (await stat(eventLogPath)).size;
    const cursor = await createEventLogCursor(eventLogPath, originalSize);
    const db = createCursorDatabase();
    try {
      db.prepare("INSERT INTO ingestion_state VALUES ('events.jsonl', ?, ?, 0, ?, ?)")
        .run(originalSize, originalSize, cursor.fileIdentity, cursor.committedPrefixHash);
      const { rotation, saved, read } = await rotateWithSavedCursor(db, eventLogPath);
      expect(rotation.committedOffsetAfterRotation).toBe(rotation.keptBytes);
      expect(saved.offset_bytes).toBe((await stat(eventLogPath)).size);
      expect(read.reset).toBe(false);
      expect(read.records).toEqual([]);
    } finally { db.close(); }
  });

  it("maps a partial trusted boundary and reads the retained unprojected suffix", async () => {
    const committedLine = eventLine(`committed-${"中".repeat(25_000)}`, "2026-10-20T00:00:00.000Z");
    const lines = [
      eventLine("old", "2026-09-15T00:00:00.000Z"),
      committedLine.replace(/\n$/u, "\r\n"),
      "\r\n",
      eventLine("unprojected-old", "2026-09-15T00:00:00.000Z"),
      eventLine("unprojected-recent", "2026-10-20T00:00:00.000Z")
    ];
    const { eventLogPath } = await makeLogFile(lines);
    const offset = Buffer.byteLength(lines.slice(0, 3).join(""), "utf8");
    const cursor = await createEventLogCursor(eventLogPath, offset);
    const db = createCursorDatabase();
    try {
      db.prepare("INSERT INTO ingestion_state VALUES ('events.jsonl', ?, ?, 0, ?, ?)")
        .run(offset, (await stat(eventLogPath)).size, cursor.fileIdentity, cursor.committedPrefixHash);
      const { rotation, read } = await rotateWithSavedCursor(db, eventLogPath);
      expect(rotation.committedOffsetAfterRotation).toBe(Buffer.byteLength(committedLine, "utf8"));
      expect(read.reset).toBe(false);
      expect(read.records.map(record => JSON.parse(record.line).event_id)).toEqual(["unprojected-recent"]);
    } finally { db.close(); }
  });

  it("keeps an unterminated retained record uncommitted", async () => {
    const { eventLogPath } = await makeLogFile([
      eventLine("old", "2026-09-15T00:00:00.000Z"),
      eventLine("recent", "2026-10-20T00:00:00.000Z").trimEnd()
    ]);
    // Even a cursor materialized at EOF must not imply that a record without a
    // newline was projected: the incremental reader never commits such a row.
    const originalSize = (await stat(eventLogPath)).size;
    const cursor = await createEventLogCursor(eventLogPath, originalSize);
    const db = createCursorDatabase();
    try {
      db.prepare("INSERT INTO ingestion_state VALUES ('events.jsonl', ?, ?, 0, ?, ?)")
        .run(originalSize, originalSize, cursor.fileIdentity, cursor.committedPrefixHash);
      const { rotation, read } = await rotateWithSavedCursor(db, eventLogPath);
      expect(rotation.committedOffsetAfterRotation).toBe(0);
      expect(read.records.map(record => JSON.parse(record.line).event_id)).toEqual(["recent"]);
    } finally { db.close(); }
  });

  it.each(["absent-row", "missing-metadata", "wrong-identity", "wrong-prefix", "beyond-eof"])("resets an untrusted rotated cursor without skipping retained rows (%s)", async (broken) => {
    const { eventLogPath } = await makeLogFile([
      ...Array.from({ length: 40 }, (_, i) => eventLine(`old-${i}`, "2026-09-15T00:00:00.000Z")),
      eventLine("recent", "2026-10-20T00:00:00.000Z")
    ]);
    const originalSize = (await stat(eventLogPath)).size;
    const stale = await createEventLogCursor(eventLogPath, originalSize);
    const db = createCursorDatabase();
    try {
      if (broken !== "absent-row") {
        db.prepare("INSERT INTO ingestion_state VALUES ('events.jsonl', ?, ?, 0, ?, ?)")
          .run(broken === "beyond-eof" ? originalSize + 1 : originalSize, originalSize,
            broken === "missing-metadata" ? null : broken === "wrong-identity" ? "stale" : stale.fileIdentity,
            broken === "missing-metadata" ? null : broken === "wrong-prefix" ? "0".repeat(64) : stale.committedPrefixHash);
      }
      const { rotation, saved, read } = await rotateWithSavedCursor(db, eventLogPath);
      expect(rotation.committedOffsetAfterRotation).toBeNull();
      expect(saved.offset_bytes).toBe(0);
      expect(read.reset).toBe(false);
      expect(read.records.map(record => JSON.parse(record.line).event_id)).toEqual(["recent"]);
    } finally { db.close(); }
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
