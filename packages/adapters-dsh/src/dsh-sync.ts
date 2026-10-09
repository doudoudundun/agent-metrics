import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as zlib from "node:zlib";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import { normalizeWorkspacePath } from "@agent-metrics/event-schema";
import {
  createDshParseState,
  normalizeDshLogRecord,
  normalizeDshSessionHeader
} from "./dsh.js";

const ZSTD_MAGIC = 0xfd2fb528;
const SESSION_LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u;

type FileCursor = {
  size: number;
  lastSeq: number;
};

type DshCursorState = {
  sessions: Record<string, true>;
  files: Record<string, FileCursor>;
};

type DiscoveredSessionLog = {
  logPath: string;
  sessionIdHint: string;
};

export function resolveDefaultDshHome(): string {
  return join(homedir(), ".dsh");
}

export function resolveDshHome(input: { homePath?: string } = {}): string {
  return (
    input.homePath ??
    process.env.AGENT_METRICS_DSH_HOME ??
    process.env.DSH_HOME ??
    resolveDefaultDshHome()
  );
}

export function resolveDshSourcePaths(input: { homePath?: string } = {}): {
  homePath: string;
  sessionsRoot: string;
} {
  const homePath = resolveDshHome(input);
  return {
    homePath,
    sessionsRoot: join(homePath, "sessions")
  };
}

export async function syncDshSessions(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  homePath?: string;
}): Promise<void> {
  const paths = resolveDshSourcePaths(input);
  if (!existsSync(paths.sessionsRoot)) {
    return;
  }

  const logs = await discoverSessionLogs(paths.sessionsRoot);
  if (logs.length === 0) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "dsh:"
  });
  const baselineEventCount = seenEventIds.size;
  let cursorChanged = false;

  for (const log of logs) {
    const previous = cursorState.files[log.logPath] ?? { size: 0, lastSeq: -1 };
    let fileContents: Buffer;
    try {
      fileContents = await readFile(log.logPath);
    } catch {
      continue;
    }

    if (fileContents.length === 0) {
      continue;
    }

    if (fileContents.length === previous.size && previous.size > 0) {
      continue;
    }

    const lastSeq = fileContents.length < previous.size ? -1 : previous.lastSeq;
    const nextSeq = await syncSessionLog({
      logPath: log.logPath,
      fileContents,
      lastSeq,
      sessionIdHint: log.sessionIdHint,
      eventLogPath: input.eventLogPath,
      seenEventIds,
      cursorState
    });

    cursorState.files[log.logPath] = { size: fileContents.length, lastSeq: nextSeq };
    cursorChanged = true;
  }

  if (cursorChanged) {
    await writeJsonFileAtomic(input.cursorPath, cursorState);
  }

  if (seenEventIds.size !== baselineEventCount) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

async function discoverSessionLogs(sessionsRoot: string): Promise<DiscoveredSessionLog[]> {
  const logs: DiscoveredSessionLog[] = [];
  const workspaces = await readdir(sessionsRoot, { withFileTypes: true });
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const workspaceDir = join(sessionsRoot, workspace.name);
    const children = await readdir(workspaceDir, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) {
        continue;
      }
      const sessionDir = join(workspaceDir, child.name);
      const fileNames = (await readdir(sessionDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      const logPath = resolveSessionLogPath(sessionDir, fileNames);
      if (logPath !== null) {
        logs.push({ logPath, sessionIdHint: child.name });
      }
    }
  }
  return logs.sort((left, right) => left.logPath.localeCompare(right.logPath));
}

function resolveSessionLogPath(sessionDir: string, fileNames: string[]): string | null {
  let best: { name: string; version: number; compressed: number } | null = null;
  for (const name of fileNames) {
    const match = SESSION_LOG_NAME.exec(name);
    if (match === null) {
      continue;
    }
    const version = match[1] === undefined ? 0 : Number(match[1]);
    const compressed = match[2] === undefined ? 0 : 1;
    if (
      best === null ||
      version > best.version ||
      (version === best.version && compressed > best.compressed)
    ) {
      best = { name, version, compressed };
    }
  }
  return best === null ? null : join(sessionDir, best.name);
}

async function syncSessionLog(input: {
  logPath: string;
  fileContents: Buffer;
  lastSeq: number;
  sessionIdHint: string;
  eventLogPath: string;
  seenEventIds: Set<string>;
  cursorState: DshCursorState;
}): Promise<number> {
  const text = decodeSessionLog(input.fileContents);
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return input.lastSeq;
  }

  let sessionId = input.sessionIdHint;
  let workspacePath = ".";
  let maxSeq = input.lastSeq;
  const parseState = createDshParseState();

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }

    if (index === 0 && parsed.type === "session") {
      const headerId = readString(parsed.id);
      if (headerId !== null) {
        sessionId = headerId;
      }
      workspacePath = normalizeWorkspacePath(readString(parsed.cwd));
      if (input.cursorState.sessions[sessionId] !== true) {
        const createdAt =
          typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
            ? parsed.createdAt
            : Date.now();
        for (const event of normalizeDshSessionHeader({
          id: sessionId,
          createdAt,
          cwd: readString(parsed.cwd) ?? undefined
        })) {
          await appendIfNew(input.eventLogPath, input.seenEventIds, event);
        }
        input.cursorState.sessions[sessionId] = true;
      }
      continue;
    }

    const seq = typeof parsed.seq === "number" && Number.isInteger(parsed.seq) ? parsed.seq : null;
    const events = normalizeDshLogRecord(parsed, sessionId, workspacePath, parseState);
    if (seq !== null && seq <= input.lastSeq) {
      continue;
    }

    for (const event of events) {
      await appendIfNew(input.eventLogPath, input.seenEventIds, event);
    }
    if (seq !== null) {
      maxSeq = Math.max(maxSeq, seq);
    }
  }

  return maxSeq;
}

async function appendIfNew(
  eventLogPath: string,
  seenEventIds: Set<string>,
  event: { event_id: string; source_record_id?: string | null }
): Promise<void> {
  const ledgerKey = event.source_record_id ?? event.event_id;
  if (seenEventIds.has(ledgerKey)) {
    return;
  }
  await appendJsonLine(eventLogPath, event);
  seenEventIds.add(ledgerKey);
}

function decodeSessionLog(buffer: Buffer): string {
  try {
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
      return decodeZstdFrames(buffer).toString("utf8");
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function zstdDecompressFrame(frame: Buffer): Buffer {
  const decompress = (
    zlib as typeof zlib & { zstdDecompressSync?: (input: Buffer) => Buffer }
  ).zstdDecompressSync;
  if (decompress === undefined) {
    throw new Error("zstd session logs require Node.js 22.15+");
  }
  return decompress(frame);
}

function decodeZstdFrames(buffer: Buffer): Buffer {
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) {
    return zstdDecompressFrame(buffer);
  }
  return Buffer.concat(frames.map((frame) => zstdDecompressFrame(buffer.subarray(frame.start, frame.end))));
}

function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      break;
    }
    offset += 4;
    if (offset >= buffer.length) {
      break;
    }

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      break;
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      break;
    }
    offset += remainingHeaderBytes;

    let complete = false;
    while (buffer.length - offset >= 3) {
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        complete = false;
        break;
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        complete = false;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) {
        break;
      }
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return frames;
}

async function loadCursorState(cursorPath: string): Promise<DshCursorState> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { sessions: {}, files: {} };
    }
    return {
      sessions: isRecord(parsed.sessions)
        ? Object.fromEntries(
            Object.entries(parsed.sessions).filter((entry): entry is [string, true] => entry[1] === true)
          )
        : {},
      files: isRecord(parsed.files)
        ? Object.fromEntries(
            Object.entries(parsed.files).flatMap(([key, value]) => {
              if (!isRecord(value)) {
                return [];
              }
              const size = typeof value.size === "number" && value.size >= 0 ? value.size : 0;
              const lastSeq = typeof value.lastSeq === "number" && value.lastSeq >= -1 ? value.lastSeq : -1;
              return [[key, { size, lastSeq }]] as Array<[string, FileCursor]>;
            })
          )
        : {}
    };
  } catch {
    return { sessions: {}, files: {} };
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  try {
    await rename(tempPath, filePath);
  } catch {
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
