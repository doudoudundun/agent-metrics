import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat as fsStat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  PREFIX_HASH_BYTES,
  compareNames,
  computeFileIdentityFromHandle,
  cursorMatchesFile,
  decodeLine,
  hashRange,
  isErrorCode,
  normalizeNow,
  readRange,
  sha256Hex
} from "./raw-primitives.js";

export { sha256Hex } from "./raw-primitives.js";

const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_SPOOL_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type EventLogCursor = {
  fileIdentity: string;
  committedOffset: number;
  committedPrefixHash: string;
};

export type MalformedEventLogLine = {
  line: string;
  offsetBytes: number;
  endOffsetBytes: number;
  message: string;
};

export type EventLogLineRecord = {
  line: string;
  offsetBytes: number;
  endOffsetBytes: number;
};

export type EventLogReadResult = {
  fileIdentity: string;
  startOffset: number;
  reset: boolean;
  lines: string[];
  records: EventLogLineRecord[];
  validLines: string[];
  malformedLines: MalformedEventLogLine[];
  trailingLine: string;
  nextCursor: EventLogCursor;
  nextCursorCandidate: EventLogCursor;
  nextOffset: number;
};

export type ReadEventLogOptions = {
  filePath: string;
  cursor?: EventLogCursor | null;
  maxBytes?: number;
  chunkBytes?: number;
};

export type RawSpoolWriteOptions = {
  spoolDirectory: string;
  envelope: unknown;
  now?: number | Date;
};

export type RawSpoolWriteResult = {
  filename: string;
  path: string;
  filePath: string;
};

export type CleanupSpoolTempsOptions = {
  spoolDirectory: string;
  now?: number | Date;
  maxAgeMs?: number;
};

export type CanonicalLeaseOptions = {
  lockPath: string;
  canonicalPath?: string;
};

export type CanonicalWriterLease = {
  readonly lockPath: string;
  readonly canonicalPath: string | null;
  append(record: unknown, canonicalPath?: string): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
};

export async function computeFileIdentity(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const details = await handle.stat();
    return await computeFileIdentityFromHandle(filePath, handle, details);
  } finally {
    await handle.close();
  }
}

export async function createEventLogCursor(
  filePath: string,
  committedOffset = 0
): Promise<EventLogCursor> {
  if (!Number.isSafeInteger(committedOffset) || committedOffset < 0) {
    throw new RangeError("committedOffset must be a non-negative safe integer");
  }

  const handle = await open(filePath, "r");
  try {
    const details = await handle.stat();
    if (committedOffset > details.size) {
      throw new RangeError("committedOffset cannot exceed the file size");
    }
    const fileIdentity = await computeFileIdentityFromHandle(filePath, handle, details);
    return {
      fileIdentity,
      committedOffset,
      committedPrefixHash: await hashRange(handle, committedOffset - Math.min(committedOffset, PREFIX_HASH_BYTES), committedOffset)
    };
  } finally {
    await handle.close();
  }
}

export async function readEventLogIncremental(filePath: string, cursor?: EventLogCursor | null): Promise<EventLogReadResult>;
export async function readEventLogIncremental(options: ReadEventLogOptions): Promise<EventLogReadResult>;
export async function readEventLogIncremental(
  input: string | ReadEventLogOptions,
  inputCursor?: EventLogCursor | null
): Promise<EventLogReadResult> {
  const options: ReadEventLogOptions =
    typeof input === "string" ? { filePath: input, cursor: inputCursor } : input;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }

  const handle = await open(options.filePath, "r");
  try {
    const details = await handle.stat();
    const fileIdentity = await computeFileIdentityFromHandle(options.filePath, handle, details);
    const cursor = options.cursor ?? null;
    const reset = cursor !== null && !(await cursorMatchesFile(cursor, fileIdentity, details.size, handle));
    const startOffset = reset ? 0 : cursor?.committedOffset ?? 0;
    const lines: string[] = [];
    const records: EventLogLineRecord[] = [];
    const validLines: string[] = [];
    const malformedLines: MalformedEventLogLine[] = [];
    let pending = Buffer.alloc(0);
    let pendingStartOffset = startOffset;
    let committedOffset = startOffset;
    let readOffset = startOffset;
    let bytesRead = 0;

    while (readOffset < details.size && bytesRead < maxBytes) {
      const readLength = Math.min(chunkBytes, maxBytes - bytesRead, details.size - readOffset);
      const chunk = Buffer.alloc(readLength);
      const { bytesRead: currentBytes } = await handle.read(chunk, 0, readLength, readOffset);
      if (currentBytes === 0) {
        break;
      }

      readOffset += currentBytes;
      bytesRead += currentBytes;
      pending = pending.length === 0 ? chunk.subarray(0, currentBytes) : Buffer.concat([pending, chunk.subarray(0, currentBytes)]);

      let newlineIndex = pending.indexOf(0x0a);
      while (newlineIndex >= 0) {
        const rawLine = pending.subarray(0, newlineIndex);
        const line = decodeLine(rawLine);
        const endOffsetBytes = pendingStartOffset + newlineIndex + 1;
        lines.push(line);
        records.push({ line, offsetBytes: pendingStartOffset, endOffsetBytes });
        try {
          JSON.parse(line);
          validLines.push(line);
        } catch (error) {
          malformedLines.push({
            line,
            offsetBytes: pendingStartOffset,
            endOffsetBytes,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        committedOffset = endOffsetBytes;
        pending = pending.subarray(newlineIndex + 1);
        pendingStartOffset = committedOffset;
        newlineIndex = pending.indexOf(0x0a);
      }
    }

    const nextCursor: EventLogCursor = {
      fileIdentity,
      committedOffset,
      committedPrefixHash: await hashRange(
        handle,
        committedOffset - Math.min(committedOffset, PREFIX_HASH_BYTES),
        committedOffset
      )
    };

    return {
      fileIdentity,
      startOffset,
      reset,
      lines,
      records,
      validLines,
      malformedLines,
      trailingLine: decodeLine(pending, false),
      nextCursor,
      nextCursorCandidate: nextCursor,
      nextOffset: committedOffset
    };
  } finally {
    await handle.close();
  }
}

export const readIncrementalEventLog = readEventLogIncremental;

export async function writeRawSpoolEnvelope(
  spoolDirectory: string,
  envelope: unknown,
  now?: number | Date
): Promise<RawSpoolWriteResult>;
export async function writeRawSpoolEnvelope(options: RawSpoolWriteOptions): Promise<RawSpoolWriteResult>;
export async function writeRawSpoolEnvelope(
  input: string | RawSpoolWriteOptions,
  inputEnvelope?: unknown,
  inputNow?: number | Date
): Promise<RawSpoolWriteResult> {
  const options: RawSpoolWriteOptions =
    typeof input === "string"
      ? { spoolDirectory: input, envelope: inputEnvelope, now: inputNow }
      : input;
  const nowMs = normalizeNow(options.now);
  const serialized = JSON.stringify(options.envelope);
  if (serialized === undefined) {
    throw new TypeError("raw spool envelope must be JSON serializable");
  }

  await mkdir(options.spoolDirectory, { recursive: true });
  await cleanupStaleSpoolTemps(options.spoolDirectory, nowMs);

  const filename = `${String(nowMs).padStart(13, "0")}-${randomUUID()}.json`;
  const tempPath = `${join(options.spoolDirectory, filename)}.tmp`;
  const finalPath = join(options.spoolDirectory, filename);
  let handle: FileHandle | null = null;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, finalPath);
    return { filename, path: finalPath, filePath: finalPath };
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export const writeSpoolEnvelope = writeRawSpoolEnvelope;

export async function cleanupStaleSpoolTemps(
  spoolDirectory: string,
  now?: number | Date,
  maxAgeMs?: number
): Promise<number>;
export async function cleanupStaleSpoolTemps(options: CleanupSpoolTempsOptions): Promise<number>;
export async function cleanupStaleSpoolTemps(
  input: string | CleanupSpoolTempsOptions,
  inputNow?: number | Date,
  inputMaxAgeMs?: number
): Promise<number> {
  const options: CleanupSpoolTempsOptions =
    typeof input === "string"
      ? { spoolDirectory: input, now: inputNow, maxAgeMs: inputMaxAgeMs }
      : input;
  const nowMs = normalizeNow(options.now);
  const maxAge = options.maxAgeMs ?? DEFAULT_SPOOL_TMP_MAX_AGE_MS;
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    throw new RangeError("maxAgeMs must be a non-negative finite number");
  }

  let entries;
  try {
    entries = await readdir(options.spoolDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) {
      continue;
    }
    const path = join(options.spoolDirectory, entry.name);
    let details;
    try {
      details = await fsStat(path);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (nowMs - details.mtimeMs > maxAge) {
      await unlink(path).catch((error) => {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
      removed += 1;
    }
  }
  return removed;
}

export async function listReadySpoolFiles(spoolDirectory: string): Promise<string[]>;
export async function listReadySpoolFiles(options: { spoolDirectory: string }): Promise<string[]>;
export async function listReadySpoolFiles(input: string | { spoolDirectory: string }): Promise<string[]> {
  const spoolDirectory = typeof input === "string" ? input : input.spoolDirectory;
  let entries;
  try {
    entries = await readdir(spoolDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(compareNames)
    .map((filename) => join(spoolDirectory, filename));
}

export async function listReadySpoolFilenames(spoolDirectory: string): Promise<string[]> {
  return (await listReadySpoolFiles(spoolDirectory)).map((path) => basename(path));
}

export async function acquireCanonicalLease(
  lockPath: string,
  canonicalPath?: string
): Promise<CanonicalWriterLease | false>;
export async function acquireCanonicalLease(options: CanonicalLeaseOptions): Promise<CanonicalWriterLease | false>;
export async function acquireCanonicalLease(
  input: string | CanonicalLeaseOptions,
  inputCanonicalPath?: string
): Promise<CanonicalWriterLease | false> {
  const options: CanonicalLeaseOptions =
    typeof input === "string" ? { lockPath: input, canonicalPath: inputCanonicalPath } : input;
  await mkdir(dirname(options.lockPath), { recursive: true });

  let lockHandle: FileHandle | null = await tryOpenExclusiveLock(options.lockPath);
  if (lockHandle === null) {
    if (await tryReclaimStaleWriterLock(options.lockPath)) {
      lockHandle = await tryOpenExclusiveLock(options.lockPath);
    }
  }
  if (lockHandle === null) {
    return false;
  }

  try {
    await lockHandle.writeFile(
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8"
    );
    await lockHandle.sync();
  } catch (error) {
    await lockHandle.close().catch(() => undefined);
    await unlink(options.lockPath).catch(() => undefined);
    throw error;
  }

  let closing = false;
  let closed = false;
  let releasePromise: Promise<void> | null = null;
  let canonicalHandle: FileHandle | null = null;
  let selectedCanonicalPath = options.canonicalPath ?? null;
  let operationQueue = Promise.resolve();

  const append = (record: unknown, requestedCanonicalPath?: string): Promise<void> => {
    if (closing || closed) {
      return Promise.reject(new Error("canonical lease is already closing"));
    }
    const operation = operationQueue.then(async () => {
      const targetPath = requestedCanonicalPath ?? selectedCanonicalPath;
      if (targetPath === null) {
        throw new Error("canonicalPath is required for the first canonical append");
      }
      if (selectedCanonicalPath !== null && selectedCanonicalPath !== targetPath) {
        throw new Error("canonical lease cannot switch canonical paths");
      }
      selectedCanonicalPath = targetPath;
      const serialized = JSON.stringify(record);
      if (serialized === undefined) {
        throw new TypeError("canonical record must be JSON serializable");
      }
      if (canonicalHandle === null) {
        await mkdir(dirname(targetPath), { recursive: true });
        canonicalHandle = await open(targetPath, "a");
      }
      await canonicalHandle.writeFile(`${serialized}\n`, "utf8");
      await canonicalHandle.sync();
    });
    operationQueue = operation.catch(() => undefined);
    return operation;
  };

  const release = async (): Promise<void> => {
    if (releasePromise !== null) {
      return releasePromise;
    }
    closing = true;
    releasePromise = (async () => {
      let firstError: unknown = null;
      await operationQueue;
      if (canonicalHandle !== null) {
        try {
          await canonicalHandle.sync();
          await canonicalHandle.close();
        } catch (error) {
          firstError = error;
        } finally {
          canonicalHandle = null;
        }
      }
      try {
        await lockHandle.sync();
        await lockHandle.close();
      } catch (error) {
        firstError ??= error;
      } finally {
        closed = true;
      }
      try {
        await unlink(options.lockPath);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          firstError ??= error;
        }
      }
      if (firstError !== null) {
        throw firstError;
      }
    })();
    return releasePromise;
  };

  return {
    lockPath: options.lockPath,
    get canonicalPath() {
      return selectedCanonicalPath;
    },
    append,
    release,
    close: release
  };
}

export async function appendCanonicalRecord(
  lease: CanonicalWriterLease | false,
  record: unknown
): Promise<boolean>;
export async function appendCanonicalRecord(
  lease: CanonicalWriterLease | false,
  canonicalPath: string,
  record: unknown
): Promise<boolean>;
export async function appendCanonicalRecord(
  lease: CanonicalWriterLease | false,
  pathOrRecord: string | unknown,
  maybeRecord?: unknown
): Promise<boolean> {
  if (lease === false) {
    return false;
  }
  if (arguments.length >= 3) {
    await lease.append(maybeRecord, pathOrRecord as string);
  } else {
    await lease.append(pathOrRecord);
  }
  return true;
}

export const appendCanonicalJsonLine = appendCanonicalRecord;

export async function releaseCanonicalLease(lease: CanonicalWriterLease | false): Promise<void> {
  if (lease !== false) {
    await lease.release();
  }
}

async function tryOpenExclusiveLock(lockPath: string): Promise<FileHandle | null> {
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      return null;
    }
    throw error;
  }
}

/** Break writer locks left behind by crashed Core/CLI processes. */
async function tryReclaimStaleWriterLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }

  let ownerPid: number | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pid = (parsed as { pid?: unknown }).pid;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        ownerPid = pid;
      }
    }
  } catch {
    ownerPid = null;
  }

  if (ownerPid !== null && isProcessAlive(ownerPid)) {
    return false;
  }

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
