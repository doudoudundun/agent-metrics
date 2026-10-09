import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { type NormalizedEventV2 } from "@agent-metrics/event-schema";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger,
  reconcileLedgerSessionsWithEventLog
} from "@agent-metrics/shared-utils";
import {
  extractCodexEventsFromRollout,
  type CodexProviderConfig
} from "./codex.js";

/** Re-check rollouts under this many days so ledger/jsonl drift self-heals. */
const RECENT_ROLLOUT_RECONCILE_DAYS = 4;

type RolloutFileSignature = {
  size: number;
  mtimeMs: number;
};

type SyncCursor = {
  rolloutFiles: Record<string, RolloutFileSignature>;
  logsLastId: number;
  sessionModels: Record<string, string>;
};


type CodexLogRow = {
  id: number;
  feedback_log_body: string | null;
};

type ReadOnlyDatabase = {
  close(): void;
  prepare<Result = unknown>(sql: string): {
    all(...params: unknown[]): Result[];
  };
};

export function resolveDefaultCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

export function resolveDefaultCodexMulticaSessionsRoot(): string {
  return join(homedir(), ".codex", "multica-sessions");
}

export function resolveDefaultCodexSessionsRoots(): string[] {
  return [resolveDefaultCodexSessionsRoot(), resolveDefaultCodexMulticaSessionsRoot()];
}

export function resolveDefaultCodexLogsDbPath(): string {
  return join(homedir(), ".codex", "logs_2.sqlite");
}

export function resolveDefaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export function resolveCodexSessionsRoots(input: {
  sessionsRoot?: string;
  sessionsRoots?: string[];
} = {}): string[] {
  if (input.sessionsRoots && input.sessionsRoots.length > 0) {
    return [...new Set(input.sessionsRoots)];
  }

  if (input.sessionsRoot) {
    return [input.sessionsRoot];
  }

  const singleRoot = process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT?.trim();
  if (singleRoot) {
    return [singleRoot];
  }

  const multiRoots = process.env.AGENT_METRICS_CODEX_SESSIONS_ROOTS?.trim();
  if (multiRoots) {
    return [
      ...new Set(
        multiRoots
          .split(/[;|]/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      )
    ];
  }

  return resolveDefaultCodexSessionsRoots();
}

export function resolveCodexSourcePaths(input: {
  sessionsRoot?: string;
  sessionsRoots?: string[];
  logsDbPath?: string;
  configPath?: string;
} = {}): {
  sessionsRoot: string;
  sessionsRoots: string[];
  logsDbPath: string;
  configPath: string;
} {
  const sessionsRoots = resolveCodexSessionsRoots(input);
  return {
    sessionsRoot: sessionsRoots[0] ?? resolveDefaultCodexSessionsRoot(),
    sessionsRoots,
    logsDbPath:
      input.logsDbPath ??
      process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH ??
      resolveDefaultCodexLogsDbPath(),
    configPath:
      input.configPath ??
      process.env.AGENT_METRICS_CODEX_CONFIG_PATH ??
      resolveDefaultCodexConfigPath()
  };
}

/**
 * Windows paths under Multica can exceed MAX_PATH; Node fs needs the \\?\ prefix.
 * Keep logical (unprefixed) paths in cursor/ledger keys for stability.
 */
export function toFsPath(filePath: string): string {
  if (process.platform !== "win32") {
    return filePath;
  }
  if (filePath.startsWith("\\\\?\\")) {
    return filePath;
  }
  if (filePath.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${filePath.slice(2)}`;
  }
  return `\\\\?\\${filePath}`;
}

export function isMulticaSessionsPath(filePath: string): boolean {
  return /(?:^|[/\\])multica-sessions(?:[/\\]|$)/iu.test(filePath);
}

export async function syncCodexRollouts(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  sessionsRoot?: string;
  sessionsRoots?: string[];
  logsDbPath?: string;
  configPath?: string;
  /**
   * When true (default), re-check recent rollouts against events.jsonl to heal
   * ledger/cursor drift. Lightweight refresh passes false and only processes
   * files whose size/mtime changed.
   */
  reconcileRecent?: boolean;
}): Promise<void> {
  const { sessionsRoots, logsDbPath, configPath } = resolveCodexSourcePaths(input);
  const existingRoots = sessionsRoots.filter((root) => existsSync(toFsPath(root)));
  if (existingRoots.length === 0) {
    return;
  }

  const reconcileRecent = input.reconcileRecent !== false;
  const cursor = await loadCursor(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "codex:"
  });
  const baselineEventCount = seenEventIds.size;

  const providerConfigs = await loadProviderConfigs(configPath);
  const { sessionModels, logsLastId } = loadSessionModelsFromLogs({
    logsDbPath,
    previousModels: cursor.sessionModels,
    previousLastId: cursor.logsLastId
  });
  const rolloutFiles = (
    await Promise.all(existingRoots.map((root) => collectRolloutFiles(root)))
  )
    .flat()
    .sort();
  const nextRolloutFiles: Record<string, RolloutFileSignature> = {
    ...cursor.rolloutFiles
  };
  let ledgerChanged = seenEventIds.size !== baselineEventCount;

  // Recent rollouts: trust events.jsonl over ledger, and drop cursor so files
  // are re-read when ledger claimed "seen" but rows never landed in the log.
  if (reconcileRecent) {
    const recentSessionIds = new Set<string>();
    let recentCursorHit = false;
    for (const filePath of rolloutFiles) {
      if (!isRecentRolloutPath(filePath)) {
        continue;
      }
      const sessionId = sessionIdFromRolloutPath(filePath);
      if (sessionId === null) {
        continue;
      }
      recentSessionIds.add(sessionId);
      if (nextRolloutFiles[filePath] !== undefined) {
        recentCursorHit = true;
      }
    }

    if (recentSessionIds.size > 0 && recentCursorHit) {
      const reconciled = await reconcileLedgerSessionsWithEventLog({
        eventLogPath: input.eventLogPath,
        prefix: "codex:",
        seenEventIds,
        sessionIds: recentSessionIds,
        sessionIdFromKey: sessionIdFromCodexLedgerKey
      });
      if (reconciled.removed > 0 || reconciled.added > 0) {
        ledgerChanged = true;
      }
      if (reconciled.removed > 0) {
        for (const path of Object.keys(nextRolloutFiles)) {
          const sessionId = sessionIdFromRolloutPath(path);
          if (sessionId !== null && recentSessionIds.has(sessionId)) {
            delete nextRolloutFiles[path];
          }
        }
      }
    }
  }

  for (const filePath of rolloutFiles) {
    const signature = await readFileSignature(filePath);
    const previousSignature = nextRolloutFiles[filePath];

    if (isSameRolloutSignature(signature, previousSignature)) {
      continue;
    }

    const contents = await readFile(toFsPath(filePath), "utf8");
    let events;
    try {
      events = extractCodexEventsFromRollout({
        filePath,
        contents,
        sessionModels,
        providerConfigs,
        sourceInstanceId: isMulticaSessionsPath(filePath) ? "codex:multica" : undefined
      });
    } catch (error) {
      // One corrupt/legacy rollout must not fail the whole Codex adapter run.
      console.error(
        `[codex-sync] skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    for (const event of events) {
      // extractCodexEventsFromRollout already emits NormalizedEventV2;
      // source_record_id carries the stable pre-conversion legacy event_id
      // that the ledger has always keyed on.
      const ledgerKey = ledgerKeyFor(event);
      if (seenEventIds.has(ledgerKey)) {
        continue;
      }

      await appendJsonLine(input.eventLogPath, event);
      seenEventIds.add(ledgerKey);
      ledgerChanged = true;
    }

    // Only mark the file synced after its events were appended (or skipped as
    // already present). Avoids cursor advancing past a crashed mid-file write.
    nextRolloutFiles[filePath] = signature;
  }

  const nextCursor = {
    rolloutFiles: nextRolloutFiles,
    logsLastId,
    sessionModels
  } satisfies SyncCursor;

  if (!isSameCursor(nextCursor, cursor)) {
    await writeJsonFileAtomic(input.cursorPath, nextCursor);
  }

  if (ledgerChanged) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

function loadSessionModelsFromLogs(input: {
  logsDbPath: string;
  previousModels: Record<string, string>;
  previousLastId: number;
}): {
  sessionModels: Record<string, string>;
  logsLastId: number;
} {
  if (!existsSync(toFsPath(input.logsDbPath))) {
    return {
      sessionModels: { ...input.previousModels },
      logsLastId: input.previousLastId
    };
  }

  const db = new Database(toFsPath(input.logsDbPath), {
    readonly: true,
    fileMustExist: true
  }) as ReadOnlyDatabase;

  try {
    const rows = db
      .prepare<CodexLogRow>(
        `
          SELECT id, feedback_log_body
          FROM logs
          WHERE id > ?
            AND feedback_log_body IS NOT NULL
            AND feedback_log_body LIKE '%model=%'
            AND (
              feedback_log_body LIKE '%conversation.id=%'
              OR feedback_log_body LIKE '%thread.id=%'
            )
          ORDER BY id ASC
        `
      )
      .all(input.previousLastId);
    const sessionModels = {
      ...input.previousModels
    };
    let logsLastId = input.previousLastId;

    for (const row of rows) {
      logsLastId = row.id > logsLastId ? row.id : logsLastId;

      if (typeof row.feedback_log_body !== "string") {
        continue;
      }

      const match = /(?:conversation\.id|thread\.id)=([0-9a-f-]+).*?\bmodel=([^\s"]+)/iu.exec(
        row.feedback_log_body
      );
      if (!match) {
        continue;
      }

      sessionModels[match[1]] = match[2];
    }

    return {
      sessionModels,
      logsLastId
    };
  } finally {
    db.close();
  }
}

async function loadProviderConfigs(configPath: string): Promise<Record<string, CodexProviderConfig>> {
  if (!existsSync(toFsPath(configPath))) {
    return {};
  }

  const contents = await readFile(toFsPath(configPath), "utf8");
  const lines = contents.split(/\r?\n/u);
  const providerConfigs: Record<string, CodexProviderConfig> = {};
  let activeProviderId: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sectionMatch = /^\[model_providers\.([^\]]+)\]$/u.exec(line);

    if (sectionMatch) {
      activeProviderId = sectionMatch[1].replace(/^['"]|['"]$/gu, "");
      if (!providerConfigs[activeProviderId]) {
        providerConfigs[activeProviderId] = {
          baseUrl: null,
          host: null
        };
      }
      continue;
    }

    if (!activeProviderId) {
      continue;
    }

    const baseUrlMatch = /^base_url\s*=\s*"([^"]+)"$/u.exec(line);
    if (!baseUrlMatch) {
      continue;
    }

    const baseUrl = baseUrlMatch[1];
    providerConfigs[activeProviderId] = {
      baseUrl,
      host: extractHost(baseUrl)
    };
  }

  return providerConfigs;
}

async function collectRolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(toFsPath(root), { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectRolloutFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function readFileSignature(filePath: string): Promise<RolloutFileSignature> {
  const details = await stat(toFsPath(filePath));
  return {
    size: details.size,
    mtimeMs: details.mtimeMs
  };
}

function isSameRolloutSignature(
  left: RolloutFileSignature,
  right: RolloutFileSignature | undefined
): boolean {
  return !!right && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function loadCursor(cursorPath: string): Promise<SyncCursor> {
  const parsed = await readJsonFile(cursorPath);

  if (
    !parsed ||
    !isRecord(parsed)
  ) {
    return createEmptyCursor();
  }

  return {
    rolloutFiles: parseRolloutFiles(parsed.rolloutFiles),
    logsLastId:
      typeof parsed.logsLastId === "number" && Number.isInteger(parsed.logsLastId) && parsed.logsLastId >= 0
        ? parsed.logsLastId
        : 0,
    sessionModels: parseSessionModels(parsed.sessionModels)
  };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(toFsPath(filePath), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
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
  } catch {
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  }
}

function createEmptyCursor(): SyncCursor {
  return {
    rolloutFiles: {},
    logsLastId: 0,
    sessionModels: {}
  };
}

function parseRolloutFiles(value: unknown): Record<string, RolloutFileSignature> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value).flatMap(([filePath, signature]) => {
    if (!isRecord(signature)) {
      return [];
    }

    const size =
      typeof signature.size === "number" && Number.isInteger(signature.size) && signature.size >= 0
        ? signature.size
        : null;
    const mtimeMs =
      typeof signature.mtimeMs === "number" && signature.mtimeMs >= 0 ? signature.mtimeMs : null;

    if (size === null || mtimeMs === null) {
      return [];
    }

    return [[filePath, { size, mtimeMs }] as const];
  });

  return Object.fromEntries(entries);
}

function parseSessionModels(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function isSameCursor(left: SyncCursor, right: SyncCursor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractHost(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ledgerKeyFor(event: NormalizedEventV2): string {
  return event.source_record_id ?? event.event_id;
}

function sessionIdFromRolloutPath(filePath: string): string | null {
  const match = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match?.[1] ?? null;
}

function sessionIdFromCodexLedgerKey(ledgerKey: string): string | null {
  const match = ledgerKey.match(
    /^codex:session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i
  );
  return match?.[1] ?? null;
}

function isRecentRolloutPath(filePath: string, nowMs = Date.now()): boolean {
  const match = filePath.match(/[/\\](\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/);
  if (!match) {
    return true;
  }

  const fileDayMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return nowMs - fileDayMs < RECENT_ROLLOUT_RECONCILE_DAYS * 24 * 60 * 60 * 1000;
}
