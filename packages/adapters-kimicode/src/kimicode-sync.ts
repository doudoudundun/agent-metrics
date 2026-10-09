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
import {
  createKimicodeWireParseState,
  normalizeKimicodeSessionState,
  normalizeKimicodeWireRecord,
  type KimicodeSessionState
} from "./kimicode.js";

type WireCursor = {
  offset: number;
  remainder: string;
};

type KimicodeCursorState = {
  wires: Record<string, WireCursor>;
  sessions: Record<string, true>;
};

export function resolveDefaultKimicodeHome(): string {
  return join(homedir(), ".kimi-code");
}

export function resolveKimicodeHome(input: { homePath?: string } = {}): string {
  return (
    input.homePath ??
    process.env.AGENT_METRICS_KIMICODE_HOME ??
    process.env.KIMI_CODE_HOME ??
    resolveDefaultKimicodeHome()
  );
}

export function resolveKimicodeSourcePaths(input: { homePath?: string } = {}): {
  homePath: string;
  sessionsRoot: string;
  sessionIndexPath: string;
} {
  const homePath = resolveKimicodeHome(input);
  return {
    homePath,
    sessionsRoot: join(homePath, "sessions"),
    sessionIndexPath: join(homePath, "session_index.jsonl")
  };
}

export async function syncKimicodeSessions(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  homePath?: string;
}): Promise<void> {
  const paths = resolveKimicodeSourcePaths(input);
  if (!existsSync(paths.homePath)) {
    return;
  }

  const sessions = await discoverKimicodeSessions(paths.sessionIndexPath, paths.sessionsRoot);
  if (sessions.length === 0) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "kimicode:"
  });
  const baselineEventCount = seenEventIds.size;
  let cursorChanged = false;

  for (const session of sessions) {
    const state = await readSessionState(session.statePath);
    const sessionId = state?.id ?? session.sessionId;
    const workspacePath = state?.cwd ?? session.workDir ?? "unknown";

    if (state !== null && cursorState.sessions[sessionId] !== true) {
      for (const event of normalizeKimicodeSessionState({ state, workspacePath })) {
        const ledgerKey = event.source_record_id ?? event.event_id;
        if (seenEventIds.has(ledgerKey)) {
          continue;
        }
        await appendJsonLine(input.eventLogPath, event);
        seenEventIds.add(ledgerKey);
      }
      cursorState.sessions[sessionId] = true;
      cursorChanged = true;
    }

    const wirePaths = await discoverWirePaths(session.sessionDir, state);
    for (const wirePath of wirePaths) {
      const previous = cursorState.wires[wirePath] ?? { offset: 0, remainder: "" };
      const next = await syncWireFile({
        wirePath,
        cursor: previous,
        eventLogPath: input.eventLogPath,
        seenEventIds,
        sessionId,
        workspacePath,
        agentId: agentIdFromWirePath(wirePath)
      });
      if (next.offset !== previous.offset || next.remainder !== previous.remainder) {
        cursorState.wires[wirePath] = next;
        cursorChanged = true;
      }
    }
  }

  if (cursorChanged) {
    await writeJsonFileAtomic(input.cursorPath, cursorState);
  }

  if (seenEventIds.size !== baselineEventCount) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

type DiscoveredSession = {
  sessionId: string;
  sessionDir: string;
  statePath: string;
  workDir: string | null;
};

async function discoverKimicodeSessions(
  sessionIndexPath: string,
  sessionsRoot: string
): Promise<DiscoveredSession[]> {
  const fromIndex = await readSessionIndex(sessionIndexPath);
  if (fromIndex.length > 0) {
    return fromIndex;
  }

  return walkSessionDirectories(sessionsRoot);
}

async function readSessionIndex(sessionIndexPath: string): Promise<DiscoveredSession[]> {
  let contents: string;
  try {
    contents = await readFile(sessionIndexPath, "utf8");
  } catch {
    return [];
  }

  const sessions: DiscoveredSession[] = [];
  for (const line of contents.split(/\r?\n/u).filter((entry) => entry.length > 0)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const sessionId = readString(parsed.sessionId);
    const sessionDir = readString(parsed.sessionDir);
    if (sessionId === null || sessionDir === null) {
      continue;
    }
    sessions.push({
      sessionId,
      sessionDir,
      statePath: join(sessionDir, "state.json"),
      workDir: readString(parsed.workDir)
    });
  }
  return sessions;
}

async function walkSessionDirectories(sessionsRoot: string): Promise<DiscoveredSession[]> {
  if (!existsSync(sessionsRoot)) {
    return [];
  }

  const sessions: DiscoveredSession[] = [];
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
      sessions.push({
        sessionId: child.name,
        sessionDir,
        statePath: join(sessionDir, "state.json"),
        workDir: null
      });
    }
  }
  return sessions;
}

async function readSessionState(statePath: string): Promise<KimicodeSessionState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    return parsed as KimicodeSessionState;
  } catch {
    return null;
  }
}

async function discoverWirePaths(
  sessionDir: string,
  state: KimicodeSessionState | null
): Promise<string[]> {
  const wires = new Set<string>();
  if (state?.agents) {
    for (const agent of Object.values(state.agents)) {
      if (typeof agent.homedir === "string" && agent.homedir.length > 0) {
        wires.add(join(agent.homedir, "wire.jsonl"));
      }
    }
  }

  const agentsRoot = join(sessionDir, "agents");
  if (existsSync(agentsRoot)) {
    const agents = await readdir(agentsRoot, { withFileTypes: true });
    for (const agent of agents) {
      if (agent.isDirectory()) {
        wires.add(join(agentsRoot, agent.name, "wire.jsonl"));
      }
    }
  }

  return [...wires].filter((path) => existsSync(path)).sort();
}

function agentIdFromWirePath(wirePath: string): string {
  const parent = dirname(wirePath);
  const agentId = parent.split(/[/\\]/u).at(-1);
  return agentId && agentId.length > 0 ? agentId : "main";
}

async function syncWireFile(input: {
  wirePath: string;
  cursor: WireCursor;
  eventLogPath: string;
  seenEventIds: Set<string>;
  sessionId: string;
  workspacePath: string;
  agentId: string;
}): Promise<WireCursor> {
  let fileContents: Buffer;
  try {
    fileContents = await readFile(input.wirePath);
  } catch {
    return input.cursor;
  }

  const cursor =
    input.cursor.offset > fileContents.length ? { offset: 0, remainder: "" } : input.cursor;
  const pendingText = `${cursor.remainder}${fileContents.subarray(cursor.offset).toString("utf8")}`;
  const splitLines = pendingText.split(/\r?\n/u);
  const hasCompleteTrailingNewline = pendingText.endsWith("\n") || pendingText.endsWith("\r");
  const remainder =
    hasCompleteTrailingNewline || splitLines.length === 0 ? "" : (splitLines.pop() ?? "");
  const completeLines = splitLines.filter((line) => line.length > 0);
  const parseState = createKimicodeWireParseState();

  for (const line of completeLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    const events = normalizeKimicodeWireRecord(parsed, {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      agentId: input.agentId
    }, parseState);

    for (const event of events) {
      const ledgerKey = event.source_record_id ?? event.event_id;
      if (input.seenEventIds.has(ledgerKey)) {
        continue;
      }
      await appendJsonLine(input.eventLogPath, event);
      input.seenEventIds.add(ledgerKey);
    }
  }

  return {
    offset: fileContents.length,
    remainder
  };
}

async function loadCursorState(cursorPath: string): Promise<KimicodeCursorState> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { wires: {}, sessions: {} };
    }
    return {
      wires: isRecord(parsed.wires)
        ? Object.fromEntries(
            Object.entries(parsed.wires).flatMap(([key, value]) => {
              if (!isRecord(value)) {
                return [];
              }
              const offset = typeof value.offset === "number" && value.offset >= 0 ? value.offset : 0;
              const remainder = typeof value.remainder === "string" ? value.remainder : "";
              return [[key, { offset, remainder }]] as Array<[string, WireCursor]>;
            })
          )
        : {},
      sessions: isRecord(parsed.sessions)
        ? Object.fromEntries(
            Object.entries(parsed.sessions)
              .filter((entry): entry is [string, true] => entry[1] === true)
          )
        : {}
    };
  } catch {
    return { wires: {}, sessions: {} };
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
