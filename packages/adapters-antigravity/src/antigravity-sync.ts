import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  appendJsonLine,
  loadEventLedger,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import type { NormalizedEventV2 } from "@agent-metrics/event-schema";
import { normalizeAntigravitySessionStarted, normalizeAntigravityTranscriptRecord } from "./antigravity.js";
import {
  loadAntigravitySessionTimings,
  readAntigravityTimingDbSignature,
  type AntigravityTimingIndex
} from "./antigravity-timing.js";
import { readAntigravityConversationWorkspaces } from "./antigravity-workspaces.js";

const ANTIGRAVITY_LEDGER_PREFIX = "antigravity:";
const TIMING_LEDGER_SUFFIX = ":timing-v1";
const ACP_DIR_NAME = "antigravity-acp";
const BRAIN_DIR_NAME = "brain";
const CONVERSATIONS_DIR_NAME = "conversations";
const CONVERSATION_SUMMARIES_DB_FILE = "conversation_summaries.db";
const TRANSCRIPT_PARENT_DIRS = [".system_generated", "logs"];
const TRANSCRIPT_FILE_NAME = "transcript_full.jsonl";

type TranscriptFileSignature = {
  size: number;
  mtimeMs: number;
  timingDbSignature?: string;
};

type AntigravityCursorState = {
  files: Record<string, TranscriptFileSignature>;
  sessions: Record<string, true>;
};

type DiscoveredTranscript = {
  transcriptPath: string;
  conversationDbPath: string;
  acpRoot: string;
  sessionId: string;
};

function readOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveDefaultAntigravityProvidersRoot(): string {
  return join(homedir(), ".t3", "userdata", "providers", "antigravity");
}

export function resolveDefaultAntigravityCliHome(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

export function resolveAntigravitySourcePaths(
  input: { providersRoot?: string; cliHome?: string } = {}
): {
  providersRoot: string;
  cliHome: string | null;
} {
  const explicitProvidersRoot =
    input.providersRoot ?? readOptionalEnv(process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT);
  const explicitCliHome =
    input.cliHome ?? readOptionalEnv(process.env.AGENT_METRICS_ANTIGRAVITY_CLI_HOME);
  return {
    providersRoot: explicitProvidersRoot ?? resolveDefaultAntigravityProvidersRoot(),
    cliHome:
      explicitCliHome ??
      (explicitProvidersRoot === undefined ? resolveDefaultAntigravityCliHome() : null)
  };
}

/**
 * Sync Antigravity ACP brain transcripts into the domain event log.
 *
 * Only `<account>/antigravity-acp/brain/<session>/.system_generated/logs/
 * transcript_full.jsonl` is discovered for usage counts; sibling state/auth/
 * cache/chunk stores cover the same sessions and would double-count. Per-step
 * TTFT and streaming duration are optionally enriched from the sibling
 * `<account>/antigravity-acp/conversations/<session>.db` (`gen_metadata`)
 * matched by `step_index` and exact token counts. The cursor keys each file on
 * transcript size+mtimeMs plus the DB signature so stable ids and `:timing-v1`
 * ledger entries keep rescan and late timing backfill append-only.
 */
export async function syncAntigravityAcpSessions(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  providersRoot?: string;
  cliHome?: string;
}): Promise<void> {
  const paths = resolveAntigravitySourcePaths(input);
  const transcripts = await discoverAntigravityTranscripts(paths);
  if (transcripts.length === 0) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadAntigravityLedger({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath
  });
  const baselineEventCount = seenEventIds.size;
  const workspacesByRoot = new Map<string, Map<string, string>>();
  let cursorChanged = false;

  for (const transcript of transcripts) {
    const signature = await readFileSignature(transcript.transcriptPath);
    if (signature === null) {
      continue;
    }
    const timingDbSignature = await readAntigravityTimingDbSignature(transcript.conversationDbPath);

    const previous = cursorState.files[transcript.transcriptPath];
    if (
      previous !== undefined &&
      previous.size === signature.size &&
      previous.mtimeMs === signature.mtimeMs &&
      previous.timingDbSignature === timingDbSignature
    ) {
      continue;
    }

    let workspaces = workspacesByRoot.get(transcript.acpRoot);
    if (workspaces === undefined) {
      workspaces = readAntigravityConversationWorkspaces(
        join(transcript.acpRoot, CONVERSATION_SUMMARIES_DB_FILE)
      );
      workspacesByRoot.set(transcript.acpRoot, workspaces);
    }
    const workspacePath = workspaces.get(transcript.sessionId);

    const timings =
      timingDbSignature.length > 0
        ? loadAntigravitySessionTimings(transcript.conversationDbPath)
        : undefined;
    const events = await readTranscriptEvents(
      transcript.transcriptPath,
      transcript.sessionId,
      timings,
      workspacePath
    );
    let sessionStartedEmitted = cursorState.sessions[transcript.sessionId] === true;
    for (const event of events) {
      if (!sessionStartedEmitted) {
        await appendIfNew(
          input.eventLogPath,
          seenEventIds,
          normalizeAntigravitySessionStarted({
            sessionId: transcript.sessionId,
            timestamp: event.timestamp,
            workspacePath
          })
        );
        cursorState.sessions[transcript.sessionId] = true;
        sessionStartedEmitted = true;
        cursorChanged = true;
      }
      await appendIfNew(input.eventLogPath, seenEventIds, event);
    }

    cursorState.files[transcript.transcriptPath] = { ...signature, timingDbSignature };
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
 * Enumerate `<acpRoot>/brain/<session>/.system_generated/logs/transcript_full.jsonl`
 * across every hosted account (`providersRoot/<account>/antigravity-acp`) and,
 * when active, the standalone Antigravity CLI home (`~/.gemini/antigravity-cli`),
 * alongside its optional sibling `conversations/<session>.db` and
 * `conversation_summaries.db`. Everything else in the brain tree is untouched.
 */
async function discoverAntigravityTranscripts(paths: {
  providersRoot: string;
  cliHome: string | null;
}): Promise<DiscoveredTranscript[]> {
  const transcripts: DiscoveredTranscript[] = [];
  const seenTranscriptPaths = new Set<string>();

  if (existsSync(paths.providersRoot)) {
    for (const account of await listDirectories(paths.providersRoot)) {
      await collectAcpRootTranscripts(
        join(paths.providersRoot, account, ACP_DIR_NAME),
        transcripts,
        seenTranscriptPaths
      );
    }
  }

  if (paths.cliHome !== null && existsSync(paths.cliHome)) {
    await collectAcpRootTranscripts(paths.cliHome, transcripts, seenTranscriptPaths);
  }

  return transcripts.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
}

async function collectAcpRootTranscripts(
  acpRoot: string,
  transcripts: DiscoveredTranscript[],
  seenTranscriptPaths: Set<string>
): Promise<void> {
  const brainRoot = join(acpRoot, BRAIN_DIR_NAME);
  if (!existsSync(brainRoot)) {
    return;
  }
  const conversationsRoot = join(acpRoot, CONVERSATIONS_DIR_NAME);
  for (const session of await listDirectories(brainRoot)) {
    const transcriptPath = join(brainRoot, session, ...TRANSCRIPT_PARENT_DIRS, TRANSCRIPT_FILE_NAME);
    if (existsSync(transcriptPath) && !seenTranscriptPaths.has(transcriptPath)) {
      seenTranscriptPaths.add(transcriptPath);
      transcripts.push({
        transcriptPath,
        conversationDbPath: join(conversationsRoot, `${session}.db`),
        acpRoot,
        sessionId: session
      });
    }
  }
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
  sessionId: string,
  timings: AntigravityTimingIndex | undefined,
  workspacePath: string | undefined
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
    events.push(...normalizeAntigravityTranscriptRecord(parsed, { sessionId, timings, workspacePath }));
  }
  return events;
}

async function loadAntigravityLedger(input: {
  ledgerPath: string;
  eventLogPath: string;
}): Promise<Set<string>> {
  const existing = await loadEventLedger(input.ledgerPath);
  if (existing.size > 0) {
    return existing;
  }

  const rebuilt = new Set<string>();
  if (!existsSync(input.eventLogPath)) {
    return rebuilt;
  }

  const stream = createReadStream(input.eventLogPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      const sourceRecordId =
        typeof parsed.source_record_id === "string" && parsed.source_record_id.length > 0
          ? parsed.source_record_id
          : null;
      const eventId =
        typeof parsed.event_id === "string" && parsed.event_id.length > 0 ? parsed.event_id : null;
      const key = sourceRecordId ?? eventId;
      if (key === null || !key.startsWith(ANTIGRAVITY_LEDGER_PREFIX)) {
        continue;
      }
      rebuilt.add(key);
      if (
        parsed.type === "token.usage.recorded" &&
        ((typeof parsed.first_token_latency_ms === "number" && parsed.first_token_latency_ms > 0) ||
          (typeof parsed.decode_duration_ms === "number" && parsed.decode_duration_ms > 0))
      ) {
        rebuilt.add(`${key}${TIMING_LEDGER_SUFFIX}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (rebuilt.size > 0) {
    await persistEventLedger(input.ledgerPath, rebuilt);
  }
  return rebuilt;
}

function timingLedgerKeyForEvent(event: NormalizedEventV2, baseKey: string): string | null {
  if (event.type !== "token.usage.recorded") {
    return null;
  }
  const hasTiming =
    (event.first_token_latency_ms ?? 0) > 0 || (event.decode_duration_ms ?? 0) > 0;
  return hasTiming ? `${baseKey}${TIMING_LEDGER_SUFFIX}` : null;
}

async function appendIfNew(
  eventLogPath: string,
  seenEventIds: Set<string>,
  event: NormalizedEventV2
): Promise<void> {
  const key = event.source_record_id ?? event.event_id;
  const timingKey = timingLedgerKeyForEvent(event, key);
  if (seenEventIds.has(key) && (timingKey === null || seenEventIds.has(timingKey))) {
    return;
  }
  await appendJsonLine(eventLogPath, event);
  seenEventIds.add(key);
  if (timingKey !== null) {
    seenEventIds.add(timingKey);
  }
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
              const timingDbSignature =
                typeof value.timingDbSignature === "string" ? value.timingDbSignature : undefined;
              return [[key, { size, mtimeMs, ...(timingDbSignature !== undefined ? { timingDbSignature } : {}) }]] as Array<
                [string, TranscriptFileSignature]
              >;
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
