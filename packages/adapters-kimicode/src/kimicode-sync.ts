import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import {
  createKimicodeWireParseState,
  normalizeKimicodeSessionState,
  normalizeKimicodeWireRecord,
  type KimicodeSessionState,
  type KimicodeWireParseState
} from "./kimicode.js";

type WireParseStateSnapshot = Pick<
  KimicodeWireParseState,
  "lastModel" | "lastProviderId" | "lastMessageId" | "pendingStepTiming"
>;

type WireCursor = {
  offset: number;
  remainder: string;
  parseState?: WireParseStateSnapshot;
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
  let handle;
  try {
    handle = await open(input.wirePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return input.cursor;
  }

  try {
    const { size } = await handle.stat();
    if (size === input.cursor.offset) return input.cursor;
    const cursor =
      input.cursor.offset > size ? { offset: 0, remainder: "" } : input.cursor;
    let offset = cursor.offset;
    let remainder = cursor.remainder;
    let decodedBytes = 0;
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(Math.min(256 * 1024, size - offset));
    const parseState = createKimicodeWireParseState();
    if (cursor.parseState !== undefined) {
      parseState.lastModel = cursor.parseState.lastModel;
      parseState.lastProviderId = cursor.parseState.lastProviderId;
      parseState.lastMessageId = cursor.parseState.lastMessageId;
      parseState.pendingStepTiming = cursor.parseState.pendingStepTiming;
    }

    // Read only appended bytes, yielding to HTTP between bounded chunks. Old
    // wire histories can be large even when the current tick adds no records.
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const decoded = decoder.write(buffer.subarray(0, bytesRead));
      decodedBytes += Buffer.byteLength(decoded, "utf8");
      const completeLines = `${remainder}${decoded}`.split(/\r?\n/u);
      remainder = completeLines.pop() ?? "";
      for (const line of completeLines) {
        if (line.length === 0) continue;
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
    }

    // An append can stop partway through a UTF-8 character. Leave those bytes
    // behind the cursor so the next tick can decode the complete character.
    const pendingBytes = Math.max(0, offset - cursor.offset - decodedBytes);
    return {
      offset: offset - pendingBytes,
      remainder,
      parseState: {
        lastModel: parseState.lastModel,
        lastProviderId: parseState.lastProviderId,
        lastMessageId: parseState.lastMessageId,
        pendingStepTiming: parseState.pendingStepTiming
      }
    };
  } finally {
    await handle.close();
  }
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
              const parseState = readWireParseStateSnapshot(value.parseState);
              return [[key, { offset, remainder, ...(parseState === undefined ? {} : { parseState }) }]] as Array<
                [string, WireCursor]
              >;
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

function readWireParseStateSnapshot(value: unknown): WireParseStateSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const timing = isRecord(value.pendingStepTiming) ? value.pendingStepTiming : null;
  return {
    lastModel: readString(value.lastModel),
    lastProviderId: readString(value.lastProviderId),
    lastMessageId: readString(value.lastMessageId),
    pendingStepTiming:
      timing === null
        ? null
        : {
            firstTokenLatencyMs: readNonNegativeInt(timing.firstTokenLatencyMs),
            decodeDurationMs: readNonNegativeInt(timing.decodeDurationMs)
          }
  };
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
