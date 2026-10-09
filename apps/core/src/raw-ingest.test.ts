import { appendFile, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  acquireCanonicalLease,
  appendCanonicalRecord,
  cleanupStaleSpoolTemps,
  computeFileIdentity,
  createEventLogCursor,
  listReadySpoolFiles,
  readEventLogIncremental,
  writeRawSpoolEnvelope
} from "./raw-ingest.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("raw ingest primitives", () => {
  it("derives a stable identity from the canonical path and uses the empty hash at offset zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-identity-"));
    const eventLogPath = join(root, "events.jsonl");
    await writeFile(eventLogPath, "seed", "utf8");

    expect(await computeFileIdentity(eventLogPath)).toBe(
      await computeFileIdentity(relative(process.cwd(), eventLogPath))
    );
    expect((await createEventLogCursor(eventLogPath, 0)).committedPrefixHash).toBe(sha256(Buffer.alloc(0)));
  });

  it("reads appended bytes, keeps a partial trailing line, and commits byte cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-reader-"));
    const eventLogPath = join(root, "events.jsonl");
    const first = `${JSON.stringify({ event_id: "one", padding: "x".repeat(5000) })}\n`;
    const partial = '{"event_id":"two"}';
    await writeFile(eventLogPath, `${first}${partial}`, "utf8");

    const initial = await readEventLogIncremental({ filePath: eventLogPath });

    expect(initial.lines).toEqual([first.slice(0, -1)]);
    expect(initial.records).toEqual([
      {
        line: first.slice(0, -1),
        offsetBytes: 0,
        endOffsetBytes: Buffer.byteLength(first)
      }
    ]);
    expect(initial.validLines).toEqual(initial.lines);
    expect(initial.trailingLine).toBe(partial);
    expect(initial.startOffset).toBe(0);
    expect(initial.reset).toBe(false);
    expect(initial.nextCursor.committedOffset).toBe(Buffer.byteLength(first));
    expect(initial.nextCursor.committedPrefixHash).toBe(sha256(Buffer.from(first).subarray(-4096)));

    await appendFile(eventLogPath, `\n{"event_id":"three"}\n`, "utf8");
    const appended = await readEventLogIncremental({
      filePath: eventLogPath,
      cursor: initial.nextCursor
    });

    expect(appended.lines).toEqual([partial, '{"event_id":"three"}']);
    expect(appended.records.map((record) => record.offsetBytes)).toEqual([
      initial.nextCursor.committedOffset,
      initial.nextCursor.committedOffset + Buffer.byteLength(`${partial}\n`)
    ]);
    expect(appended.trailingLine).toBe("");
    expect(appended.startOffset).toBe(initial.nextCursor.committedOffset);
    expect(appended.nextCursor.committedOffset).toBe((await stat(eventLogPath)).size);
  });

  it("reports malformed complete lines without blocking later valid records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-malformed-"));
    const eventLogPath = join(root, "events.jsonl");
    await writeFile(eventLogPath, '{"event_id":"good-before"}\nnot-json\n{"event_id":"good-after"}\n', "utf8");

    const result = await readEventLogIncremental({ filePath: eventLogPath });

    expect(result.lines).toHaveLength(3);
    expect(result.validLines).toEqual(['{"event_id":"good-before"}', '{"event_id":"good-after"}']);
    expect(result.malformedLines).toEqual([
      expect.objectContaining({ line: "not-json", offsetBytes: Buffer.byteLength('{"event_id":"good-before"}\n') })
    ]);
    expect(result.nextCursor.committedOffset).toBe((await stat(eventLogPath)).size);
  });

  it("replays from zero after truncation or same-path replacement and resumes unchanged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-recovery-"));
    const eventLogPath = join(root, "events.jsonl");
    const original = '{"event_id":"original"}\n{"event_id":"second"}\n';
    await writeFile(eventLogPath, original, "utf8");

    const committed = await readEventLogIncremental({ filePath: eventLogPath });
    await writeFile(eventLogPath, '{"event_id":"original"}\n', "utf8");
    const truncated = await readEventLogIncremental({ filePath: eventLogPath, cursor: committed.nextCursor });

    expect(truncated.reset).toBe(true);
    expect(truncated.startOffset).toBe(0);
    expect(truncated.lines).toEqual(['{"event_id":"original"}']);

    await writeFile(eventLogPath, '{"event_id":"replacement"}\n', "utf8");
    const replaced = await readEventLogIncremental({ filePath: eventLogPath, cursor: truncated.nextCursor });

    expect(replaced.reset).toBe(true);
    expect(replaced.lines).toEqual(['{"event_id":"replacement"}']);

    const unchanged = await readEventLogIncremental({ filePath: eventLogPath, cursor: replaced.nextCursor });
    expect(unchanged.reset).toBe(false);
    expect(unchanged.lines).toEqual([]);
    expect(unchanged.nextCursor).toEqual(replaced.nextCursor);
  });

  it("writes complete spool envelopes atomically and lists ready files by filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-spool-"));
    const first = await writeRawSpoolEnvelope({
      spoolDirectory: root,
      envelope: { event_id: "first", payload: "完整 UTF-8" },
      now: 2_000
    });
    const second = await writeRawSpoolEnvelope({
      spoolDirectory: root,
      envelope: { event_id: "second" },
      now: 1_000
    });

    const entries = await readdir(root);
    expect(entries.every((entry) => !entry.endsWith(".tmp"))).toBe(true);
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ event_id: "first", payload: "完整 UTF-8" });
    expect(JSON.parse(await readFile(second.path, "utf8"))).toEqual({ event_id: "second" });
    expect((await listReadySpoolFiles(root)).map((path) => basename(path))).toEqual([
      basename(second.path),
      basename(first.path)
    ]);
  });

  it("ignores fresh spool temps and removes only temps older than 24 hours", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-spool-cleanup-"));
    const now = Date.now();
    const oldTemp = join(root, "old.tmp");
    const freshTemp = join(root, "fresh.tmp");
    await writeFile(oldTemp, "old", "utf8");
    await writeFile(freshTemp, "fresh", "utf8");
    await utimes(oldTemp, new Date(now - 24 * 60 * 60 * 1000 - 1), new Date(now - 24 * 60 * 60 * 1000 - 1));
    await utimes(freshTemp, new Date(now - 1000), new Date(now - 1000));

    expect(await cleanupStaleSpoolTemps(root, now)).toBe(1);
    expect(await readdir(root)).toEqual(["fresh.tmp"]);
    expect(await listReadySpoolFiles(root)).toEqual([]);
  });

  it("allows one canonical writer, appends one JSON line per operation, and releases the lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-lease-"));
    const lockPath = join(root, "canonical.lock");
    const canonicalPath = join(root, "canonical.jsonl");
    const lease = await acquireCanonicalLease({ lockPath, canonicalPath });
    expect(lease).not.toBe(false);
    if (lease === false) {
      throw new Error("expected the first lease to be acquired");
    }

    const competingLease = await acquireCanonicalLease({ lockPath, canonicalPath });
    expect(competingLease).toBe(false);
    await appendCanonicalRecord(lease, { schema_version: 2, event_id: "one" });
    await lease.release();

    const nextLease = await acquireCanonicalLease({ lockPath, canonicalPath });
    expect(nextLease).not.toBe(false);
    if (nextLease === false) {
      throw new Error("expected the released lease to become available");
    }
    await appendCanonicalRecord(nextLease, { schema_version: 2, event_id: "two" });
    await nextLease.release();

    expect(await readFile(canonicalPath, "utf8")).toBe(
      '{"schema_version":2,"event_id":"one"}\n{"schema_version":2,"event_id":"two"}\n'
    );
  });

  it("has an exclusive acquisition result under concurrent lease contenders", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-raw-lease-race-"));
    const lockPath = join(root, "canonical.lock");
    const results = await Promise.all([
      acquireCanonicalLease(lockPath),
      acquireCanonicalLease(lockPath)
    ]);

    expect(results.filter((result) => result !== false)).toHaveLength(1);
    await Promise.all(results.filter((result) => result !== false).map((result) => result.release()));
  });
});
