import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendJsonLine,
  loadEventLedger,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import type { NormalizedEventV2 } from "@agent-metrics/event-schema";
import {
  normalizeCodebuddyLogRequest,
  normalizeCodebuddyLogSessionHeader,
  parseCodebuddyLog
} from "./codebuddy-log.js";

/** `logs/<name>.log`; `logs/memwatch/<pid>.log` is diagnostics, not billing. */
const REQUEST_LOG_NAME = /^(.+)\.log$/u;
const DATE_DIR_NAME = /^\d{4}-\d{2}-\d{2}$/u;
const LEDGER_PREFIX = "codebuddy-cli:";
const USAGE_KEY_INFIX = ":usage:";
/** Suffix of the ledger key that records "this request's credit was seen". */
const CREDIT_LEDGER_SUFFIX = ":credit";
/** Suffix of the ledger key that records "this request's cache split was seen". */
const CACHE_LEDGER_SUFFIX = ":cache";
/**
 * A billing line is written a few milliseconds before or after the `qua.end`
 * of the same request, so a pass can catch a request before its credit is on
 * disk. Such a request is written with no credit, and the ledger only records
 * "credit seen" once a value exists: when the value shows up later the event is
 * re-emitted and the projector patches the existing row.
 */
const DEFAULT_SETTLE_MS = 0;
/**
 * Bytes of already-consumed log re-read on each pass. A request's billing line
 * and its `qua.end` sit within a few lines of each other, so this overlap lets
 * a request that straddled two passes still be paired.
 */
const OVERLAP_BYTES = 128 * 1024;

type FileCursor = {
  offset: number;
};

type CodebuddyLogCursorState = {
  files: Record<string, FileCursor>;
};

export function resolveDefaultCodebuddyLogRoot(): string {
  return join(homedir(), ".codebuddy", "logs");
}

export function resolveCodebuddyLogRoot(input: { logRoot?: string } = {}): string {
  return (
    input.logRoot ??
    process.env.AGENT_METRICS_CODEBUDDY_LOG_ROOT ??
    resolveDefaultCodebuddyLogRoot()
  );
}

export type CodebuddyLogSyncSummary = {
  filesScanned: number;
  requestsWritten: number;
  requestsSkippedAsDuplicate: number;
};

/**
 * Collect model usage from the CodeBuddy CLI request logs.
 *
 * CodeBuddy CLI bills against the same WorkBuddy account as the desktop app, so
 * these events are reported under the WorkBuddy vendor. They are still a
 * separate adapter because the source format is a plain-text log rather than a
 * transcript, and because `--no-session-persistence` headless runs leave no
 * transcript to read at all.
 *
 * `workbuddyLedgerPath` points at the transcript adapter's ledger: a request
 * that already arrived through a transcript must not be counted twice, and the
 * message id is identical in both sources.
 */
export async function syncCodebuddyCliLogs(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  logRoot?: string;
  workbuddyLedgerPath?: string;
  /** Override the quiet period a log must reach before it is read. */
  settleMs?: number;
}): Promise<CodebuddyLogSyncSummary> {
  const summary: CodebuddyLogSyncSummary = {
    filesScanned: 0,
    requestsWritten: 0,
    requestsSkippedAsDuplicate: 0
  };

  const logRoot = resolveCodebuddyLogRoot({ logRoot: input.logRoot });
  if (!existsSync(logRoot)) {
    return summary;
  }

  const logFiles = await discoverRequestLogs(logRoot);
  if (logFiles.length === 0) {
    return summary;
  }

  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS;
  const settledBefore = Date.now() - settleMs;
  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: LEDGER_PREFIX
  });
  const baselineEventCount = seenEventIds.size;
  const transcriptMessageIds = await loadTranscriptMessageIds(input.workbuddyLedgerPath);
  let cursorChanged = false;

  for (const logPath of logFiles) {
    let fileStat;
    try {
      fileStat = await stat(logPath);
    } catch {
      continue;
    }
    if (fileStat.mtimeMs > settledBefore || fileStat.size === 0) {
      continue;
    }

    const previousOffset = cursorState.files[logPath]?.offset ?? 0;
    // A rotated or truncated log restarts from the beginning.
    const fromOffset = previousOffset > fileStat.size ? 0 : previousOffset;
    if (fromOffset === fileStat.size) {
      continue;
    }

    let tail;
    try {
      tail = await readLogTail(logPath, fromOffset, fileStat.size);
    } catch {
      continue;
    }
    summary.filesScanned += 1;
    if (tail.text.length === 0) {
      cursorState.files[logPath] = { offset: tail.nextOffset };
      cursorChanged = true;
      continue;
    }

    const scan = parseCodebuddyLog(tail.text, workspaceFromLogPath(logPath));

    for (const [sessionId, startedAt] of scan.sessionStartedAt) {
      const sessionHeader = normalizeCodebuddyLogSessionHeader({
        sessionId,
        startedAt,
        workspacePath:
          scan.requests.find((request) => request.sessionId === sessionId)?.workspacePath ??
          workspaceFromLogPath(logPath)
      });
      for (const event of sessionHeader) {
        await appendIfNew(input.eventLogPath, seenEventIds, event);
      }
    }

    for (const request of scan.requests) {
      if (transcriptMessageIds.has(request.messageId)) {
        summary.requestsSkippedAsDuplicate += 1;
        continue;
      }
      const event = normalizeCodebuddyLogRequest(request);
      const written = await appendIfNew(input.eventLogPath, seenEventIds, event);
      if (written) {
        summary.requestsWritten += 1;
      }
    }

    cursorState.files[logPath] = { offset: tail.nextOffset };
    cursorChanged = true;
  }

  if (cursorChanged) {
    await writeJsonFileAtomic(input.cursorPath, cursorState);
  }
  if (seenEventIds.size !== baselineEventCount) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }

  return summary;
}

/**
 * Read from `fromOffset` (minus the pairing overlap) to the end of the file.
 * A trailing partial line (the CLI is mid-write) is left for the next pass, so
 * the returned offset always lands on a line boundary.
 */
async function readLogTail(
  logPath: string,
  fromOffset: number,
  size: number
): Promise<{ text: string; nextOffset: number }> {
  const start = Math.max(0, fromOffset - OVERLAP_BYTES);
  const length = size - start;
  const handle = await open(logPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    const chunk = buffer.toString("utf8");
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline === -1) {
      // Nothing complete yet; keep the offset so the next pass re-reads it.
      return { text: "", nextOffset: fromOffset };
    }
    const complete = chunk.slice(0, lastNewline + 1);
    const nextOffset = size - Buffer.byteLength(chunk.slice(lastNewline + 1), "utf8");
    if (start === 0) {
      return { text: complete, nextOffset };
    }
    const newline = complete.indexOf("\n");
    return { text: newline === -1 ? "" : complete.slice(newline + 1), nextOffset };
  } finally {
    await handle.close();
  }
}

async function discoverRequestLogs(logRoot: string): Promise<string[]> {
  const logs: string[] = [];
  let days;
  try {
    days = await readdir(logRoot, { withFileTypes: true });
  } catch {
    return logs;
  }

  for (const day of days) {
    if (!day.isDirectory() || !DATE_DIR_NAME.test(day.name)) {
      continue;
    }
    const dayDir = join(logRoot, day.name);
    let entries;
    try {
      entries = await readdir(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || REQUEST_LOG_NAME.exec(entry.name) === null) {
        continue;
      }
      logs.push(join(dayDir, entry.name));
    }
  }

  return logs.sort((left, right) => left.localeCompare(right));
}

/**
 * Message ids already collected from a transcript. The transcript adapter
 * records them as `<vendor>:usage:<messageId>` ledger keys, which lets the two
 * sources be reconciled without reading the event log.
 */
async function loadTranscriptMessageIds(ledgerPath: string | undefined): Promise<Set<string>> {
  const messageIds = new Set<string>();
  if (ledgerPath === undefined) {
    return messageIds;
  }
  for (const key of await loadEventLedger(ledgerPath)) {
    const index = key.lastIndexOf(USAGE_KEY_INFIX);
    if (index === -1) {
      continue;
    }
    const messageId = key.slice(index + USAGE_KEY_INFIX.length);
    if (messageId.length > 0) {
      messageIds.add(messageId);
    }
  }
  return messageIds;
}

/**
 * `d-projects-dev-tools-any-subagent__cc63707d.log` names the workspace by its
 * slug; the interactive path in the log body is preferred, this is the
 * fallback for logs that start mid-session.
 */
function workspaceFromLogPath(logPath: string): string {
  const fileName = logPath.replaceAll("\\", "/").split("/").pop() ?? "";
  const stem = fileName.replace(REQUEST_LOG_NAME, "");
  const slug = stem.split("__")[0] ?? "";
  if (slug.length === 0) {
    return ".";
  }
  const decoded = slug.replace(/^([a-zA-Z])-/u, "$1:/").replaceAll("-", "/");
  return /^[a-zA-Z]:\//u.test(decoded) ? decoded : slug;
}

function ledgerKeys(event: NormalizedEventV2): {
  key: string;
  creditKey: string | null;
  cacheKey: string | null;
} {
  const key = event.source_record_id ?? event.event_id;
  const isUsage = event.type === "token.usage.recorded";
  // A request first written without a credit is re-emitted once the billing
  // line appears; the extra ledger entry is what allows that second write.
  const creditKey =
    isUsage && event.credit !== undefined && event.credit !== null
      ? `${key}${CREDIT_LEDGER_SUFFIX}`
      : null;
  // Same for the cache split, which the provider layer logs on a later line.
  const cacheKey =
    isUsage && event.cache_read_input_tokens > 0 ? `${key}${CACHE_LEDGER_SUFFIX}` : null;
  return { key, creditKey, cacheKey };
}

async function appendIfNew(
  eventLogPath: string,
  seenEventIds: Set<string>,
  event: NormalizedEventV2
): Promise<boolean> {
  const { key, creditKey, cacheKey } = ledgerKeys(event);
  const missingDetail =
    (creditKey !== null && !seenEventIds.has(creditKey)) ||
    (cacheKey !== null && !seenEventIds.has(cacheKey));
  if (seenEventIds.has(key) && !missingDetail) {
    return false;
  }
  await appendJsonLine(eventLogPath, event);
  seenEventIds.add(key);
  if (creditKey !== null) {
    seenEventIds.add(creditKey);
  }
  if (cacheKey !== null) {
    seenEventIds.add(cacheKey);
  }
  return true;
}

async function loadCursorState(cursorPath: string): Promise<CodebuddyLogCursorState> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.files)) {
      return { files: {} };
    }
    return {
      files: Object.fromEntries(
        Object.entries(parsed.files).flatMap(([key, value]) => {
          if (!isRecord(value)) {
            return [];
          }
          // `size` was the pre-offset cursor field; keep reading old cursors.
          const offset = readOffset(value.offset) ?? readOffset(value.size) ?? 0;
          return [[key, { offset }]] as Array<[string, FileCursor]>;
        })
      )
    };
  } catch {
    return { files: {} };
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

function readOffset(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
