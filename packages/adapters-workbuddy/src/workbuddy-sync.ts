import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendJsonLine,
  loadEventLedger,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import { normalizeWorkspacePath } from "@agent-metrics/event-schema";
import type { NormalizedEventV2 } from "@agent-metrics/event-schema";
import {
  createWorkbuddyParseState,
  normalizeWorkbuddyRecord,
  normalizeWorkbuddySessionHeader
} from "./workbuddy.js";
import { createWorkbuddyTimingReader, type WorkbuddyTimingIndex } from "./workbuddy-timing.js";

/**
 * A timing reader caches per-file offsets, so every home directory needs its
 * own reader: a single shared one would drop its cache each time the scan
 * switched between the WorkBuddy and CodeBuddy homes.
 */
const timingReaders = new Map<string, ReturnType<typeof createWorkbuddyTimingReader>>();

function readTimings(homePath: string): Promise<{
  index: WorkbuddyTimingIndex;
  signature: string;
}> {
  let reader = timingReaders.get(homePath);
  if (reader === undefined) {
    reader = createWorkbuddyTimingReader();
    timingReaders.set(homePath, reader);
  }
  return reader(homePath);
}

const SESSION_LOG_NAME = /^(.+)\.jsonl$/u;

type FileCursor = {
  size: number;
};

type WorkbuddyCursorState = {
  timingSignature?: string;
  /** Per-projects-root log signature, so each home rescans independently. */
  timingSignatures?: Record<string, string>;
  sessions: Record<string, true>;
  files: Record<string, FileCursor>;
};

export type WorkbuddySyncRoot = {
  homePath: string;
  projectsRoot: string;
  /** The WorkBuddy home owns the legacy single-home cursor fields. */
  primary: boolean;
};

type DiscoveredSessionLog = {
  logPath: string;
  sessionIdHint: string;
};

export function resolveDefaultWorkbuddyHome(): string {
  return join(homedir(), ".workbuddy");
}

export function resolveWorkbuddyHome(input: { homePath?: string } = {}): string {
  return (
    input.homePath ??
    process.env.AGENT_METRICS_WORKBUDDY_HOME ??
    process.env.WORKBUDDY_HOME ??
    resolveDefaultWorkbuddyHome()
  );
}

export function resolveWorkbuddySourcePaths(input: { homePath?: string } = {}): {
  homePath: string;
  projectsRoot: string;
} {
  const homePath = resolveWorkbuddyHome(input);
  return {
    homePath,
    projectsRoot: join(homePath, "projects")
  };
}

/**
 * CodeBuddy CLI writes the same transcript schema as WorkBuddy (same record
 * types, same `providerData.usage`, same tool-call records) under
 * `~/.codebuddy/projects`, so its consumption is collected by this adapter and
 * reported as WorkBuddy usage.
 */
export function resolveCodebuddyHome(input: { codebuddyHomePath?: string } = {}): string {
  return input.codebuddyHomePath ?? process.env.AGENT_METRICS_CODEBUDDY_HOME ?? join(homedir(), ".codebuddy");
}

/**
 * Every home directory whose `projects` transcripts feed the WorkBuddy vendor
 * row: the WorkBuddy home first, then CodeBuddy CLI's home.
 */
export function resolveWorkbuddySyncRoots(
  input: { homePath?: string; codebuddyHomePath?: string } = {}
): WorkbuddySyncRoot[] {
  const workbuddyHome = resolveWorkbuddyHome({ homePath: input.homePath });
  const codebuddyHome = resolveCodebuddyHome({ codebuddyHomePath: input.codebuddyHomePath });
  const roots: WorkbuddySyncRoot[] = [
    { homePath: workbuddyHome, projectsRoot: join(workbuddyHome, "projects"), primary: true }
  ];
  if (codebuddyHome !== workbuddyHome) {
    roots.push({ homePath: codebuddyHome, projectsRoot: join(codebuddyHome, "projects"), primary: false });
  }
  return roots;
}

/**
 * WorkBuddy keeps one append-only transcript per agent session at
 * `~/.workbuddy/projects/<workspace-slug>/<session-id>.jsonl`. Agent-team
 * member transcripts live under
 * `~/.workbuddy/projects/<workspace-slug>/<session-id>/subagents/agent-<uuid>.jsonl`.
 * CodeBuddy CLI keeps the same layout under `~/.codebuddy/projects`.
 *
 * The files are re-read as a whole whenever they grow and de-duplicated through
 * the event ledger, because records are not guaranteed to carry a monotonic
 * sequence number.
 *
 * `cliLogLedgerPath` points at the CodeBuddy CLI log adapter's ledger. The log
 * adapter reads a request line the moment it is flushed, which is usually
 * before the transcript line for the same request, so this adapter has to skip
 * requests the log already counted — otherwise whichever adapter writes second
 * doubles the request.
 */
export async function syncWorkbuddySessions(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  cliLogLedgerPath?: string;
  homePath?: string;
  codebuddyHomePath?: string;
}): Promise<void> {
  const roots = resolveWorkbuddySyncRoots(input).filter((root) => existsSync(root.projectsRoot));
  if (roots.length === 0) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "workbuddy:"
  });
  const cliLogMessageIds = await loadCliLogMessageIds(input.cliLogLedgerPath);
  const baselineEventCount = seenEventIds.size;
  let cursorChanged = false;

  for (const root of roots) {
    const logs = await discoverSessionLogs(root.projectsRoot);
    if (logs.length === 0) {
      continue;
    }

    const timings = await readTimings(root.homePath);
    const previousSignature =
      cursorState.timingSignatures?.[root.projectsRoot] ??
      (root.primary ? cursorState.timingSignature : undefined);
    const timingChanged = previousSignature !== timings.signature;
    let rootChanged = false;

    for (const log of logs) {
      const previous = cursorState.files[log.logPath] ?? { size: 0 };
      let fileContents: Buffer;
      try {
        fileContents = await readFile(log.logPath);
      } catch {
        continue;
      }

      if (fileContents.length === 0) {
        continue;
      }

      if (fileContents.length === previous.size && previous.size > 0 && !timingChanged) {
        continue;
      }

      await syncSessionLog({
        text: fileContents.toString("utf8"),
        sessionIdHint: log.sessionIdHint,
        eventLogPath: input.eventLogPath,
        seenEventIds,
        cliLogMessageIds,
        cursorState,
        timings: timings.index
      });

      cursorState.files[log.logPath] = { size: fileContents.length };
      rootChanged = true;
    }

    if (rootChanged || timingChanged) {
      cursorState.timingSignatures = {
        ...cursorState.timingSignatures,
        [root.projectsRoot]: timings.signature
      };
      if (root.primary) {
        cursorState.timingSignature = timings.signature;
      }
      cursorChanged = true;
    }
  }

  if (cursorChanged) {
    await writeJsonFileAtomic(input.cursorPath, cursorState);
  }

  if (seenEventIds.size !== baselineEventCount) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

async function discoverSessionLogs(projectsRoot: string): Promise<DiscoveredSessionLog[]> {
  const logs: DiscoveredSessionLog[] = [];
  const workspaces = await readdir(projectsRoot, { withFileTypes: true });
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const workspaceDir = join(projectsRoot, workspace.name);
    const children = await readdir(workspaceDir, { withFileTypes: true });
    for (const child of children) {
      if (child.isFile()) {
        const match = SESSION_LOG_NAME.exec(child.name);
        if (match === null) {
          continue;
        }
        logs.push({ logPath: join(workspaceDir, child.name), sessionIdHint: match[1] });
        continue;
      }
      if (!child.isDirectory()) {
        continue;
      }
      logs.push(...(await listJsonlLogs(join(workspaceDir, child.name, "subagents"))));
    }
  }
  return logs.sort((left, right) => left.logPath.localeCompare(right.logPath));
}

async function listJsonlLogs(dir: string): Promise<DiscoveredSessionLog[]> {
  const logs: DiscoveredSessionLog[] = [];
  let children;
  try {
    children = await readdir(dir, { withFileTypes: true });
  } catch {
    return logs;
  }
  for (const child of children) {
    if (!child.isFile()) {
      continue;
    }
    const match = SESSION_LOG_NAME.exec(child.name);
    if (match === null) {
      continue;
    }
    logs.push({ logPath: join(dir, child.name), sessionIdHint: match[1] });
  }
  return logs;
}

async function syncSessionLog(input: {
  text: string;
  sessionIdHint: string;
  eventLogPath: string;
  seenEventIds: Set<string>;
  cliLogMessageIds: Set<string>;
  cursorState: WorkbuddyCursorState;
  timings: WorkbuddyTimingIndex;
}): Promise<void> {
  const records = parseRecords(input.text);
  if (records.length === 0) {
    return;
  }

  let sessionId = input.sessionIdHint;
  for (const record of records) {
    const id = readString(record.sessionId);
    if (id !== null) {
      sessionId = id;
      break;
    }
  }

  let workspacePath: string | null = null;
  let startedAt: number | null = null;
  for (const record of records) {
    if (startedAt === null) {
      startedAt = readNumber(record.timestamp);
    }
    if (workspacePath === null) {
      const cwd = readString(record.cwd);
      if (cwd !== null) {
        workspacePath = normalizeWorkspacePath(cwd);
      }
    }
    if (startedAt !== null && workspacePath !== null) {
      break;
    }
  }

  const resolvedWorkspace = workspacePath ?? ".";
  const parseState = createWorkbuddyParseState(input.timings);
  const pending: NormalizedEventV2[] = [];
  let countedByCliLog = 0;
  for (const record of records) {
    for (const event of normalizeWorkbuddyRecord(record, sessionId, resolvedWorkspace, parseState)) {
      if (isIngested(input.seenEventIds, event)) {
        continue;
      }
      // The CLI log records the request line before the transcript records the
      // same message, so a request that already arrived through the log must
      // not be written again here.
      if (event.type === "token.usage.recorded" && input.cliLogMessageIds.has(event.message_id)) {
        countedByCliLog += 1;
        continue;
      }
      pending.push(event);
    }
  }

  // A transcript cloned by WorkBuddy Switch contributes no new event once its
  // records were counted under the original session. Leaving it without a
  // session header keeps the cloned copy out of the session list. A session
  // whose only remaining events are usage rows already counted by the CLI log
  // is a real session, so it still needs its header.
  if (pending.length === 0 && countedByCliLog === 0) {
    return;
  }

  if (input.cursorState.sessions[sessionId] !== true) {
    for (const event of normalizeWorkbuddySessionHeader({
      id: sessionId,
      startedAt: startedAt ?? Date.now(),
      cwd: resolvedWorkspace
    })) {
      await appendIfNew(input.eventLogPath, input.seenEventIds, event);
    }
    input.cursorState.sessions[sessionId] = true;
  }

  for (const event of pending) {
    await appendIfNew(input.eventLogPath, input.seenEventIds, event);
  }
}

/** Ledger prefix the CodeBuddy CLI log adapter writes for each counted request. */
const CLI_LOG_USAGE_PREFIX = "codebuddy-cli:usage:";

/**
 * Message ids the CLI log adapter already counted. Requests recorded there are
 * the same requests this adapter reads from the transcript, so they must not be
 * written twice.
 */
async function loadCliLogMessageIds(ledgerPath: string | undefined): Promise<Set<string>> {
  const messageIds = new Set<string>();
  if (ledgerPath === undefined || !existsSync(ledgerPath)) {
    return messageIds;
  }
  for (const key of await loadEventLedger(ledgerPath)) {
    if (!key.startsWith(CLI_LOG_USAGE_PREFIX)) {
      continue;
    }
    const messageId = key.slice(CLI_LOG_USAGE_PREFIX.length).replace(/:cache$|:credit$/u, "");
    if (messageId.length > 0) {
      messageIds.add(messageId);
    }
  }
  return messageIds;
}

function parseRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // A partially flushed trailing line; the next size change re-reads it.
      continue;
    }
    if (isRecord(parsed)) {
      records.push(parsed);
    }
  }
  return records;
}

function ledgerKeys(event: NormalizedEventV2): { key: string; timingKey: string | null } {
  const key = event.source_record_id ?? event.event_id;
  // A timing-only replay keeps the same event identity and token accounting.
  // The canonical projector accepts only a null -> known timing enrichment.
  const timingKey = event.type === "token.usage.recorded" && (event.decode_duration_ms ?? 0) > 0
    ? `${key}:timing-v1`
    : null;
  return { key, timingKey };
}

function isIngested(seenEventIds: Set<string>, event: NormalizedEventV2): boolean {
  const { key, timingKey } = ledgerKeys(event);
  return seenEventIds.has(key) && (timingKey === null || seenEventIds.has(timingKey));
}

async function appendIfNew(
  eventLogPath: string,
  seenEventIds: Set<string>,
  event: NormalizedEventV2
): Promise<void> {
  if (isIngested(seenEventIds, event)) {
    return;
  }
  const { key, timingKey } = ledgerKeys(event);
  await appendJsonLine(eventLogPath, event);
  seenEventIds.add(key);
  if (timingKey !== null) seenEventIds.add(timingKey);
}

async function loadCursorState(cursorPath: string): Promise<WorkbuddyCursorState> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { sessions: {}, files: {} };
    }
    return {
      timingSignature: typeof parsed.timingSignature === "string" ? parsed.timingSignature : undefined,
      timingSignatures: isRecord(parsed.timingSignatures)
        ? Object.fromEntries(
            Object.entries(parsed.timingSignatures).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined,
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
              return [[key, { size }]] as Array<[string, FileCursor]>;
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

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
