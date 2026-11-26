import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import type { NormalizedEventV2 } from "@agent-metrics/event-schema";
import { normalizeAntigravitySessionStarted, normalizeAntigravityTranscriptRecord } from "./antigravity.js";

const ANTIGRAVITY_LEDGER_PREFIX = "antigravity:";
const ACP_DIR_NAME = "antigravity-acp";
const BRAIN_DIR_NAME = "brain";
const TRANSCRIPT_PARENT_DIRS = [".system_generated", "logs"];
const TRANSCRIPT_FILE_NAME = "transcript_full.jsonl";

type TranscriptFileSignature = {
  size: number;
  mtimeMs: number;
};

type AntigravityCursorState = {
  files: Record<string, TranscriptFileSignature>;
  sessions: Record<string, true>;
};

type DiscoveredTranscript = {
  transcriptPath: string;
  sessionId: string;
};

export function resolveDefaultAntigravityProvidersRoot(): string {
  return join(homedir(), ".t3", "userdata", "providers", "antigravity");
}

export function resolveAntigravitySourcePaths(input: { providersRoot?: string } = {}): {
  providersRoot: string;
} {
  return {
    providersRoot:
      input.providersRoot ??
      process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT ??
      resolveDefaultAntigravityProvidersRoot()
  };
}

/**
 * Sync Antigravity ACP brain transcripts into the domain event log.
 *
 * Only `<account>/antigravity-acp/brain/<session>/.system_generated/logs/
 * transcript_full.jsonl` is discovered; sibling state/auth/cache/chunk stores
 * cover the same sessions and would double-count. The cursor keys each file on
 * size+mtimeMs and re-reads the whole transcript on any change — stable
 * session/step/model-scoped ids plus the ledger keep that re-read append-only.
 */
export async function syncAntigravityAcpSessions(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  providersRoot?: string;
}): Promise<void> {
  const paths = resolveAntigravitySourcePaths(input);
  if (!existsSync(paths.providersRoot)) {
    return;
  }

  const transcripts = await discoverAntigravityTranscripts(paths.providersRoot);
  if (transcripts.length === 0) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: ANTIGRAVITY_LEDGER_PREFIX
  });
  const baselineEventCount = seenEventIds.size;
  let cursorChanged = false;

  for (const transcript of transcripts) {
    const signature = await readFileSignature(transcript.transcriptPath);
    if (signature === null) {
      continue;
    }

    const previous = cursorState.files[transcript.transcriptPath];
    if (
      previous !== undefined &&
      previous.size === signature.size &&
      previous.mtimeMs === signature.mtimeMs
    ) {
      continue;
    }

    const events = await readTranscriptEvents(transcript.transcriptPath, transcript.sessionId);
    let sessionStartedEmitted = cursorState.sessions[transcript.sessionId] === true;
    for (const event of events) {
      if (!sessionStartedEmitted) {
        await appendIfNew(
          input.eventLogPath,
          seenEventIds,
          normalizeAntigravitySessionStarted({
            sessionId: transcript.sessionId,
            timestamp: event.timestamp
          })
        );
        cursorState.sessions[transcript.sessionId] = true;
        sessionStartedEmitted = true;
        cursorChanged = true;
      }
      await appendIfNew(input.eventLogPath, seenEventIds, event);
    }

    cursorState.files[transcript.transcriptPath] = signature;
    cursorChanged = true;
  }

  if (cursorChanged) {
    await writeJsonFileAtomic(input.cursorPath, cursorState);
  }

  if (seenEventIds.size !== baselineEventCount) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

/**
 * Enumerate `providersRoot/<account>/antigravity-acp/brain/<session>/
 * .system_generated/logs/transcript_full.jsonl` across every account. Only the
 * exact transcript path is considered a source; everything else in the brain
 * tree (statev2, auth, cache, chunks) is deliberately untouched.
 */
async function discoverAntigravityTranscripts(providersRoot: string): Promise<DiscoveredTranscript[]> {
  const transcripts: DiscoveredTranscript[] = [];
  for (const account of await listDirectories(providersRoot)) {
    const brainRoot = join(providersRoot, account, ACP_DIR_NAME, BRAIN_DIR_NAME);
    if (!existsSync(brainRoot)) {
      continue;
    }
    for (const session of await listDirectories(brainRoot)) {
      const transcriptPath = join(brainRoot, session, ...TRANSCRIPT_PARENT_DIRS, TRANSCRIPT_FILE_NAME);
      if (existsSync(transcriptPath)) {
        transcripts.push({ transcriptPath, sessionId: session });
      }
    }
  }
  return transcripts.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readFileSignature(filePath: string): Promise<TranscriptFileSignature | null> {
  try {
    const details = await stat(filePath);
    return { size: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return null;
  }
}

async function readTranscriptEvents(
  transcriptPath: string,
  sessionId: string
): Promise<NormalizedEventV2[]> {
  let contents: string;
  try {
    contents = await readFile(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const events: NormalizedEventV2[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // Antigravity appends record-by-record, so the tail line is often a
      // half-written record; it parses once the append completes and the file
      // signature changes again.
      continue;
    }
    events.push(...normalizeAntigravityTranscriptRecord(parsed, { sessionId }));
  }
  return events;
}

async function appendIfNew(
  eventLogPath: string,
  seenEventIds: Set<string>,
  event: NormalizedEventV2
): Promise<void> {
  const ledgerKey = event.source_record_id ?? event.event_id;
  if (seenEventIds.has(ledgerKey)) {
    return;
  }
  await appendJsonLine(eventLogPath, event);
  seenEventIds.add(ledgerKey);
}

async function loadCursorState(cursorPath: string): Promise<AntigravityCursorState> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { files: {}, sessions: {} };
    }
    return {
      files: isRecord(parsed.files)
        ? Object.fromEntries(
            Object.entries(parsed.files).flatMap(([key, value]) => {
              if (!isRecord(value)) {
                return [];
              }
              const size = typeof value.size === "number" && value.size >= 0 ? value.size : null;
              const mtimeMs = typeof value.mtimeMs === "number" && value.mtimeMs >= 0 ? value.mtimeMs : null;
              if (size === null || mtimeMs === null) {
                return [];
              }
              return [[key, { size, mtimeMs }]] as Array<[string, TranscriptFileSignature]>;
            })
          )
        : {},
      sessions: isRecord(parsed.sessions)
        ? Object.fromEntries(
            Object.entries(parsed.sessions).filter((entry): entry is [string, true] => entry[1] === true)
          )
        : {}
    };
  } catch {
    return { files: {}, sessions: {} };
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
