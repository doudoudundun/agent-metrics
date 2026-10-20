import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

/**
 * `events.jsonl` is an append-only canonical log with no rotation. It grows by
 * roughly 15 MB/day on an active machine, and once it reaches multiple GB the
 * startup catch-up ingest wedges the event loop: `/api/health` accepts the TCP
 * connection but never answers, the desktop supervisor declares a readiness
 * timeout and kills Core, and dashboards silently show stale data.
 *
 * This module keeps the log bounded. When the file exceeds `maxBytes` we
 * (1) stream it line by line, (2) keep only records within `retentionDays`,
 * (3) move the original into `<data>/events/archive/` as a cold backup, and
 * (4) atomically replace the live log with the trimmed copy.
 *
 * The ingestion cursor is intentionally left alone: `readEventLogIncremental`
 * compares the committed offset against the new (smaller) file size and the
 * prefix hash, so the next sync resets to offset 0 and re-projects. Reprojection
 * is idempotent (`INSERT OR IGNORE` on `normalized_events`, event-id keyed
 * `INSERT OR REPLACE` on the legacy tables), so already-projected history is
 * never duplicated or lost.
 */

export const DEFAULT_EVENT_LOG_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIMESTAMP_SCAN_CHARS = 1024;
const TIMESTAMP_PATTERN = /"timestamp"\s*:\s*"([^"]+)"/u;

export type EventLogRotationConfig = {
  maxBytes: number;
  retentionDays: number;
};

export type EventLogRotationLogger = {
  info?(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
};

export function resolveEventLogRotationConfig(
  env: NodeJS.ProcessEnv = process.env
): EventLogRotationConfig {
  return {
    maxBytes: readPositiveInteger(
      env.AGENT_METRICS_EVENT_LOG_MAX_BYTES,
      DEFAULT_EVENT_LOG_MAX_BYTES
    ),
    retentionDays: readPositiveInteger(
      env.AGENT_METRICS_EVENT_LOG_RETENTION_DAYS,
      DEFAULT_EVENT_LOG_RETENTION_DAYS
    )
  };
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type EventLogRotationSkipReason = "missing" | "below-threshold";

export type EventLogRotationResult = {
  rotated: boolean;
  skipReason: EventLogRotationSkipReason | null;
  /** Size of the live log before rotation (0 when the file is missing). */
  originalBytes: number;
  /** Size of the live log after rotation. */
  keptBytes: number;
  keptLines: number;
  droppedLines: number;
  droppedMalformedLines: number;
  /** Cold backup of the pre-rotation log, or null when nothing was rotated. */
  archivePath: string | null;
  /** Cutoff actually applied, as an ISO string; records older than this were dropped. */
  cutoffIso: string | null;
};

export type EventLogRotationInput = {
  eventLogPath: string;
  maxBytes?: number;
  retentionDays?: number;
  /** Defaults to `<dirname(eventLogPath)>/archive`. */
  archiveDir?: string;
  now?: Date;
  logger?: EventLogRotationLogger;
};

export async function rotateEventLogIfNeeded(
  input: EventLogRotationInput
): Promise<EventLogRotationResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES;
  const retentionDays = input.retentionDays ?? DEFAULT_EVENT_LOG_RETENTION_DAYS;
  const emptyResult: EventLogRotationResult = {
    rotated: false,
    skipReason: null,
    originalBytes: 0,
    keptBytes: 0,
    keptLines: 0,
    droppedLines: 0,
    droppedMalformedLines: 0,
    archivePath: null,
    cutoffIso: null
  };

  let details;
  try {
    details = await stat(input.eventLogPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ...emptyResult, skipReason: "missing" };
    }
    throw error;
  }

  if (!details.isFile() || details.size <= maxBytes) {
    return { ...emptyResult, skipReason: "below-threshold", originalBytes: details.size };
  }

  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * MS_PER_DAY;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const directory = dirname(input.eventLogPath);
  const archiveDir = input.archiveDir ?? join(directory, "archive");
  const tempPath = join(directory, `.events.jsonl.rotate-${process.pid}-${Date.now()}.tmp`);

  await mkdir(archiveDir, { recursive: true });

  let trimmed;
  try {
    trimmed = await trimEventLogFile({
      sourcePath: input.eventLogPath,
      targetPath: tempPath,
      cutoffMs
    });
  } catch (error) {
    await safeUnlink(tempPath);
    throw error;
  }

  const archivePath = await nextArchivePath(archiveDir, details.mtime);
  await rename(input.eventLogPath, archivePath);
  try {
    await rename(tempPath, input.eventLogPath);
  } catch (error) {
    // Put the original back so the canonical log never disappears.
    await rename(archivePath, input.eventLogPath).catch(() => undefined);
    await safeUnlink(tempPath);
    throw error;
  }

  const result: EventLogRotationResult = {
    rotated: true,
    skipReason: null,
    originalBytes: details.size,
    keptBytes: trimmed.keptBytes,
    keptLines: trimmed.keptLines,
    droppedLines: trimmed.droppedLines,
    droppedMalformedLines: trimmed.malformedLines,
    archivePath,
    cutoffIso
  };

  input.logger?.warn(
    {
      eventLogPath: input.eventLogPath,
      archivePath,
      originalBytes: result.originalBytes,
      keptBytes: result.keptBytes,
      keptLines: result.keptLines,
      droppedLines: result.droppedLines,
      droppedMalformedLines: result.droppedMalformedLines,
      cutoffIso
    },
    "rotated oversized events.jsonl"
  );

  if (result.keptBytes > maxBytes) {
    input.logger?.warn(
      { eventLogPath: input.eventLogPath, keptBytes: result.keptBytes, maxBytes, retentionDays },
      "events.jsonl still exceeds the size threshold after retention trim; lower AGENT_METRICS_EVENT_LOG_RETENTION_DAYS"
    );
  }

  return result;
}

async function trimEventLogFile(input: {
  sourcePath: string;
  targetPath: string;
  cutoffMs: number;
}): Promise<{ keptLines: number; droppedLines: number; malformedLines: number; keptBytes: number }> {
  const reader = createInterface({
    input: createReadStream(input.sourcePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  const writer = createWriteStream(input.targetPath, { encoding: "utf8" });

  let keptLines = 0;
  let droppedLines = 0;
  let malformedLines = 0;
  let keptBytes = 0;

  try {
    for await (const line of reader) {
      if (line.length === 0) {
        continue;
      }
      const timestampMs = extractTimestampMs(line);
      if (timestampMs === null) {
        malformedLines += 1;
        droppedLines += 1;
        continue;
      }
      if (timestampMs < input.cutoffMs) {
        droppedLines += 1;
        continue;
      }
      const record = `${line}\n`;
      keptLines += 1;
      keptBytes += Buffer.byteLength(record, "utf8");
      if (!writer.write(record)) {
        await once(writer, "drain");
      }
    }
    writer.end();
    await once(writer, "finish");
  } catch (error) {
    writer.destroy();
    throw error;
  } finally {
    reader.close();
  }

  return { keptLines, droppedLines, malformedLines, keptBytes };
}

function extractTimestampMs(line: string): number | null {
  const head = line.length > TIMESTAMP_SCAN_CHARS ? line.slice(0, TIMESTAMP_SCAN_CHARS) : line;
  let raw: unknown;
  const match = TIMESTAMP_PATTERN.exec(head);
  if (match !== null) {
    raw = match[1];
  } else {
    try {
      raw = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    } catch {
      return null;
    }
  }
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function nextArchivePath(archiveDir: string, mtime: Date): Promise<string> {
  const stamp = formatStamp(mtime);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = join(archiveDir, `events-${stamp}${suffix}.jsonl`);
    try {
      await stat(candidate);
    } catch (error) {
      if (isMissingFileError(error)) {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error(`unable to allocate an event log archive name under ${archiveDir}`);
}

function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Gzip a rotated archive and delete the plain copy. Best-effort: callers run
 * this after the HTTP server is listening so compression never sits on the
 * readiness path.
 */
export async function compressEventLogArchive(archivePath: string): Promise<string> {
  if (archivePath.endsWith(".gz")) {
    return archivePath;
  }
  const gzPath = `${archivePath}.gz`;
  try {
    await pipeline(
      createReadStream(archivePath),
      createGzip({ level: 6 }),
      createWriteStream(gzPath)
    );
  } catch (error) {
    await safeUnlink(gzPath);
    throw error;
  }
  await unlink(archivePath);
  return gzPath;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
