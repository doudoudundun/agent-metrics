import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import {
  extractClaudeTranscriptObservations,
  normalizeClaudeTranscriptObservation,
  type ClaudeTranscriptObservation
} from "./transcript.js";

export type ClaudeTranscriptReference = {
  transcriptPath: string;
  workspacePath: string;
  sessionId?: string;
};

type TranscriptCursor = {
  offset: number;
  remainder: string;
};

type TranscriptCursorMap = Record<string, TranscriptCursor>;

type TranscriptLedger = {
  keys: string[];
};

export async function recordClaudeTranscriptReference(input: {
  manifestPath: string;
  transcriptPath: string;
  workspacePath: string;
  sessionId?: string;
}): Promise<void> {
  await withTranscriptStateLock(input.manifestPath, async () => {
    if (input.transcriptPath.length === 0 || input.workspacePath.length === 0) {
      return;
    }

    const manifest = await loadTranscriptManifest(input.manifestPath);
    const existingIndex = manifest.findIndex(
      (entry) => entry.transcriptPath === input.transcriptPath
    );
    const existingEntry = existingIndex >= 0 ? manifest[existingIndex] : undefined;
    const nextEntry: ClaudeTranscriptReference = {
      transcriptPath: input.transcriptPath,
      workspacePath: input.workspacePath,
      ...((input.sessionId ?? existingEntry?.sessionId)
        ? { sessionId: input.sessionId ?? existingEntry?.sessionId }
        : {})
    };

    if (existingIndex >= 0) {
      manifest[existingIndex] = nextEntry;
    } else {
      manifest.push(nextEntry);
    }

    await writeJsonFileAtomic(input.manifestPath, manifest);
  });
}

export async function syncKnownClaudeTranscripts(input: {
  manifestPath: string;
  eventLogPath: string;
  transcriptCursorPath: string;
  transcriptLedgerPath: string;
}): Promise<void> {
  await withTranscriptStateLock(input.manifestPath, async () => {
    const manifest = await loadTranscriptManifest(input.manifestPath);

    if (manifest.length === 0) {
      return;
    }

    const cursors = await loadTranscriptCursors(input.transcriptCursorPath);
    const ledger = await loadTranscriptLedger(input.transcriptLedgerPath);
    const seenKeys = await loadTranscriptLedgerKeysFromEventLog(input.eventLogPath);
    const baselineLedgerSize = seenKeys.size;

    for (const key of ledger.keys) {
      seenKeys.add(key);
    }

    let cursorsChanged = false;
    let ledgerChanged = seenKeys.size !== baselineLedgerSize;

    for (const reference of manifest) {
      const syncResult = await syncTranscriptReference({
        eventLogPath: input.eventLogPath,
        reference,
        cursor: cursors[reference.transcriptPath],
        seenKeys
      });

      if (syncResult.cursorChanged) {
        cursorsChanged = true;
        cursors[reference.transcriptPath] = syncResult.cursor;
      }

      if (syncResult.ledgerChanged) {
        ledgerChanged = true;
      }
    }

    if (cursorsChanged) {
      await writeJsonFileAtomic(input.transcriptCursorPath, cursors);
    }

    if (ledgerChanged) {
      await writeJsonFileAtomic(input.transcriptLedgerPath, {
        keys: [...seenKeys].sort()
      } satisfies TranscriptLedger);
    }
  });
}

async function syncTranscriptReference(input: {
  eventLogPath: string;
  reference: ClaudeTranscriptReference;
  cursor?: TranscriptCursor;
  seenKeys: Set<string>;
}): Promise<{
  cursor: TranscriptCursor;
  cursorChanged: boolean;
  ledgerChanged: boolean;
}> {
  const previousCursor = normalizeTranscriptCursor(input.cursor);
  let fileContents: Buffer;

  try {
    fileContents = await readFile(input.reference.transcriptPath);
  } catch {
    return {
      cursor: previousCursor,
      cursorChanged: false,
      ledgerChanged: false
    };
  }

  const cursor =
    previousCursor.offset > fileContents.length
      ? createEmptyTranscriptCursor()
      : previousCursor;
  const pendingText = `${cursor.remainder}${fileContents.subarray(cursor.offset).toString("utf8")}`;
  const splitLines = pendingText.split(/\r?\n/u);
  const hasCompleteTrailingNewline =
    pendingText.endsWith("\n") || pendingText.endsWith("\r");
  const remainder =
    hasCompleteTrailingNewline || splitLines.length === 0 ? "" : (splitLines.pop() ?? "");
  const completeLines = splitLines.filter((line) => line.length > 0);
  let ledgerChanged = false;

  for (const line of completeLines) {
    const record = parseTranscriptLine(line, input.reference);
    if (record === null) {
      continue;
    }

    const observations = extractClaudeTranscriptObservations(record);

    for (const observation of observations) {
      const ledgerKey = buildLedgerKey(observation);
      if (input.seenKeys.has(ledgerKey)) {
        continue;
      }

      await appendJsonLine(
        input.eventLogPath,
        normalizeClaudeTranscriptObservation(observation)
      );
      input.seenKeys.add(ledgerKey);
      ledgerChanged = true;
    }
  }

  const nextCursor = {
    offset: fileContents.length,
    remainder
  } satisfies TranscriptCursor;

  return {
    cursor: nextCursor,
    cursorChanged:
      nextCursor.offset !== previousCursor.offset || nextCursor.remainder !== previousCursor.remainder,
    ledgerChanged
  };
}

function parseTranscriptLine(
  line: string,
  reference: ClaudeTranscriptReference
): Record<string, unknown> | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  return {
    ...parsed,
    sessionId: coalesceString(parsed.sessionId, parsed.session_id, reference.sessionId),
    cwd: coalesceString(parsed.cwd, parsed.workspace_path, reference.workspacePath)
  };
}

function buildLedgerKey(observation: ClaudeTranscriptObservation): string {
  if (observation.kind === "prompt_submitted") {
    return `prompt:${observation.sessionId}:${observation.promptId}`;
  }

  if (observation.kind === "assistant_responded") {
    return `assistant:${observation.sessionId}:${observation.messageId}`;
  }

  return `usage:${observation.sessionId}:${observation.messageId}`;
}

async function loadTranscriptManifest(manifestPath: string): Promise<ClaudeTranscriptReference[]> {
  const parsed = await readJsonFile(manifestPath);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter(isRecord)
    .flatMap((entry) => {
      const transcriptPath = normalizeOptionalString(entry.transcriptPath);
      const workspacePath = normalizeOptionalString(entry.workspacePath);

      if (!transcriptPath || !workspacePath) {
        return [];
      }

      const sessionId = normalizeOptionalString(entry.sessionId);
      return [
        {
          transcriptPath,
          workspacePath,
          ...(sessionId ? { sessionId } : {})
        }
      ];
    });
}

async function loadTranscriptCursors(cursorPath: string): Promise<TranscriptCursorMap> {
  const parsed = await readJsonFile(cursorPath);

  if (!isRecord(parsed)) {
    return {};
  }

  const entries = Object.entries(parsed).flatMap(([transcriptPath, value]) => {
    if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
      return [];
    }

    const cursor = normalizeTranscriptCursor(value);
    return [[transcriptPath, cursor] as const];
  });

  return Object.fromEntries(entries);
}

async function loadTranscriptLedger(ledgerPath: string): Promise<TranscriptLedger> {
  const parsed = await readJsonFile(ledgerPath);

  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    return { keys: [] };
  }

  return {
    keys: parsed.keys.filter((entry): entry is string => typeof entry === "string")
  };
}

async function loadTranscriptLedgerKeysFromEventLog(eventLogPath: string): Promise<Set<string>> {
  const seenKeys = new Set<string>();
  let contents: string;

  try {
    contents = await readFile(eventLogPath, "utf8");
  } catch {
    return seenKeys;
  }

  for (const line of contents.split("\n").filter((entry) => entry.length > 0)) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      continue;
    }

    if (
      parsed.type === "prompt.submitted" &&
      typeof parsed.session_id === "string" &&
      typeof parsed.prompt_id === "string"
    ) {
      seenKeys.add(`prompt:${parsed.session_id}:${parsed.prompt_id}`);
      continue;
    }

    if (
      parsed.type === "assistant.responded" &&
      typeof parsed.session_id === "string" &&
      typeof parsed.message_id === "string"
    ) {
      seenKeys.add(`assistant:${parsed.session_id}:${parsed.message_id}`);
      continue;
    }

    if (
      parsed.type === "token.usage.recorded" &&
      typeof parsed.session_id === "string" &&
      typeof parsed.message_id === "string"
    ) {
      seenKeys.add(`usage:${parsed.session_id}:${parsed.message_id}`);
    }
  }

  return seenKeys;
}

function normalizeTranscriptCursor(value: unknown): TranscriptCursor {
  if (!isRecord(value)) {
    return createEmptyTranscriptCursor();
  }

  const offset =
    typeof value.offset === "number" && Number.isInteger(value.offset) && value.offset >= 0
      ? value.offset
      : 0;
  const remainder = typeof value.remainder === "string" ? value.remainder : "";

  return {
    offset,
    remainder
  };
}

function createEmptyTranscriptCursor(): TranscriptCursor {
  return {
    offset: 0,
    remainder: ""
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");

  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
    if (error) {
      return;
    }
  }
}

function coalesceString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);

    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTranscriptStateLock<T>(
  manifestPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = join(dirname(manifestPath), "transcript-state.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5000;

  while (true) {
    let handle:
      | Awaited<ReturnType<typeof open>>
      | undefined;

    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isExistingFileError(error) || Date.now() >= deadline) {
        throw error;
      }

      await delay(25);
    } finally {
      if (handle) {
        await handle.close();
      }
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function isExistingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
