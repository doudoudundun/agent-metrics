import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import { normalizeWorkspacePath } from "@agent-metrics/event-schema";
import {
  createWorkbuddyParseState,
  normalizeWorkbuddyRecord,
  normalizeWorkbuddySessionHeader
} from "./workbuddy.js";

const SESSION_LOG_NAME = /^(.+)\.jsonl$/u;

type FileCursor = {
  size: number;
};

type WorkbuddyCursorState = {
  sessions: Record<string, true>;
  files: Record<string, FileCursor>;
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
 * WorkBuddy keeps one append-only transcript per agent session at
 * `~/.workbuddy/projects/<workspace-slug>/<session-id>.jsonl`.
 *
 * The files are re-read as a whole whenever they grow and de-duplicated through
 * the event ledger, because records are not guaranteed to carry a monotonic
 * sequence number.
 */
export async function syncWorkbuddySessions(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  homePath?: string;
}): Promise<void> {
  const paths = resolveWorkbuddySourcePaths(input);
  if (!existsSync(paths.projectsRoot)) {
    return;
  }

  const logs = await discoverSessionLogs(paths.projectsRoot);
  if (logs.length === 0) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "workbuddy:"
  });
  const baselineEventCount = seenEventIds.size;
  let cursorChanged = false;

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

    if (fileContents.length === previous.size && previous.size > 0) {
      continue;
    }

    await syncSessionLog({
      text: fileContents.toString("utf8"),
      sessionIdHint: log.sessionIdHint,
      eventLogPath: input.eventLogPath,
      seenEventIds,
      cursorState
    });

    cursorState.files[log.logPath] = { size: fileContents.length };
    cursorChanged = true;
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
      if (!child.isFile()) {
        continue;
      }
      const match = SESSION_LOG_NAME.exec(child.name);
      if (match === null) {
        continue;
      }
      logs.push({ logPath: join(workspaceDir, child.name), sessionIdHint: match[1] });
    }
  }
  return logs.sort((left, right) => left.logPath.localeCompare(right.logPath));
}

async function syncSessionLog(input: {
  text: string;
  sessionIdHint: string;
  eventLogPath: string;
  seenEventIds: Set<string>;
  cursorState: WorkbuddyCursorState;
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

  const parseState = createWorkbuddyParseState();
  for (const record of records) {
    const events = normalizeWorkbuddyRecord(record, sessionId, resolvedWorkspace, parseState);
    for (const event of events) {
      await appendIfNew(input.eventLogPath, input.seenEventIds, event);
    }
  }
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

async function loadCursorState(cursorPath: string): Promise<WorkbuddyCursorState> {
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
