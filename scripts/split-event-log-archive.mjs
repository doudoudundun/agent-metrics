#!/usr/bin/env node
/**
 * Split an archived `events.jsonl` snapshot into per-day gzip files so a single
 * day can be replayed without ever streaming the whole (multi-GB) archive into
 * the projector.
 *
 *   node scripts/split-event-log-archive.mjs <archive.jsonl> [options]
 *
 * Options:
 *   --out-dir <dir>    Output directory (default: <archive dir>/by-day)
 *   --keep-plain       Keep the uncompressed per-day files too
 *   --delete-source    Delete the archive after a verified split
 *
 * Output layout:
 *   <out-dir>/events-YYYY-MM-DD.jsonl.gz
 *   <out-dir>/events-unknown.jsonl.gz   (lines without a parsable timestamp)
 *   <out-dir>/manifest.json
 *
 * Replay one day (Core must be stopped):
 *   gunzip -c events-2026-09-15.jsonl.gz >> "$APPDATA/Agent Metrics/agent-metrics-data/data/events/events.jsonl"
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join, resolve } from "node:path";

const MAX_OPEN_HANDLES = 16;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function parseArgs(argv) {
  const args = { source: null, outDir: null, keepPlain: false, deleteSource: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      args.outDir = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--keep-plain") {
      args.keepPlain = true;
    } else if (arg === "--delete-source") {
      args.deleteSource = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/split-event-log-archive.mjs <archive.jsonl> [--out-dir DIR] [--keep-plain] [--delete-source]"
      );
      process.exit(0);
    } else if (args.source === null) {
      args.source = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.source === null) {
    throw new Error("missing <archive.jsonl> argument");
  }
  return args;
}

function dayOfTimestamp(value) {
  if (typeof value !== "string" || value.length < 10) {
    return null;
  }
  const day = value.slice(0, 10);
  return DAY_PATTERN.test(day) ? day : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(args.source);
  const source = await stat(sourcePath).catch(() => null);
  if (source === null || !source.isFile()) {
    throw new Error(`archive not found: ${sourcePath}`);
  }

  const outDir = args.outDir === null ? join(dirname(sourcePath), "by-day") : resolve(args.outDir);
  await mkdir(outDir, { recursive: true });

  // Appending to a half-written split would silently duplicate lines, so refuse
  // to reuse a directory that already holds output.
  const existing = (await readdir(outDir)).filter((name) => name.startsWith("events-"));
  if (existing.length > 0) {
    throw new Error(
      `output directory already contains ${existing.length} split file(s): ${outDir}\n` +
        "Pick a fresh --out-dir, or remove the old output first."
    );
  }

  const openHandles = new Map();
  const perDay = new Map();

  const recordFor = (day) => {
    let entry = perDay.get(day);
    if (entry === undefined) {
      entry = { day, lines: 0, bytes: 0 };
      perDay.set(day, entry);
    }
    return entry;
  };

  const handleFor = async (day) => {
    const existing = openHandles.get(day);
    if (existing !== undefined) {
      // Refresh insertion order so the FIFO eviction keeps hot days open.
      openHandles.delete(day);
      openHandles.set(day, existing);
      return existing;
    }
    if (openHandles.size >= MAX_OPEN_HANDLES) {
      const oldestDay = openHandles.keys().next().value;
      const oldest = openHandles.get(oldestDay);
      openHandles.delete(oldestDay);
      await oldest.close();
    }
    const handle = await open(join(outDir, `events-${day}.jsonl`), "a");
    openHandles.set(day, handle);
    return handle;
  };

  let totalLines = 0;
  let malformedLines = 0;
  const reader = createInterface({
    input: createReadStream(sourcePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of reader) {
    if (line.length === 0) {
      continue;
    }
    totalLines += 1;
    let day = null;
    try {
      day = dayOfTimestamp(JSON.parse(line).timestamp);
    } catch {
      day = null;
    }
    if (day === null) {
      malformedLines += 1;
    }
    const bucket = day ?? "unknown";
    const entry = recordFor(bucket);
    const payload = `${line}\n`;
    const bytes = Buffer.byteLength(payload, "utf8");
    const handle = await handleFor(bucket);
    await handle.write(payload);
    entry.lines += 1;
    entry.bytes += bytes;
    if (totalLines % 500000 === 0) {
      console.log(`... ${totalLines} lines read`);
    }
  }

  for (const handle of openHandles.values()) {
    await handle.close();
  }

  const produced = (await readdir(outDir)).filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"));
  const days = [];
  for (const fileName of produced.sort()) {
    const plainPath = join(outDir, fileName);
    const gzPath = `${plainPath}.gz`;
    await pipeline(createReadStream(plainPath), createGzip({ level: 6 }), createWriteStream(gzPath));
    const plainSize = (await stat(plainPath)).size;
    const gzSize = (await stat(gzPath)).size;
    if (!args.keepPlain) {
      await unlink(plainPath);
    }
    const day = basename(fileName).replace(/^events-/u, "").replace(/\.jsonl$/u, "");
    const entry = perDay.get(day) ?? { lines: 0, bytes: plainSize };
    days.push({
      day,
      file: basename(gzPath),
      lines: entry.lines,
      plainBytes: plainSize,
      gzipBytes: gzSize,
      keptPlain: args.keepPlain
    });
  }

  const countedLines = days.reduce((sum, day) => sum + day.lines, 0);
  const manifest = {
    source: sourcePath,
    generatedAt: new Date().toISOString(),
    totalLines,
    malformedLines,
    countedLines,
    sourceBytes: source.size,
    gzipBytes: days.reduce((sum, day) => sum + day.gzipBytes, 0),
    days: days.sort((left, right) => left.day.localeCompare(right.day))
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    `split ${totalLines} lines into ${days.length} day files ` +
      `(${manifest.gzipBytes} bytes gzip, source ${source.size} bytes)`
  );
  if (countedLines !== totalLines) {
    throw new Error(`line accounting mismatch: counted ${countedLines}, read ${totalLines}`);
  }

  if (args.deleteSource) {
    await unlink(sourcePath);
    console.log(`removed source archive ${sourcePath}`);
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
