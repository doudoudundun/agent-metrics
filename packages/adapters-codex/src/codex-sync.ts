import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { appendJsonLine, loadEventLedgerWithFallback, persistEventLedger } from "@agent-metrics/shared-utils";
import {
  extractCodexEventsFromRollout,
  type CodexProviderConfig
} from "./codex.js";

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

export function resolveDefaultCodexLogsDbPath(): string {
  return join(homedir(), ".codex", "logs_2.sqlite");
}

export function resolveDefaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export async function syncCodexRollouts(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  sessionsRoot?: string;
  logsDbPath?: string;
  configPath?: string;
}): Promise<void> {
  const sessionsRoot =
    input.sessionsRoot ??
    process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT ??
    resolveDefaultCodexSessionsRoot();
  if (!existsSync(sessionsRoot)) {
    return;
  }

  const logsDbPath =
    input.logsDbPath ??
    process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH ??
    resolveDefaultCodexLogsDbPath();
  const configPath =
    input.configPath ??
    process.env.AGENT_METRICS_CODEX_CONFIG_PATH ??
    resolveDefaultCodexConfigPath();
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
  const rolloutFiles = await collectRolloutFiles(sessionsRoot);
  const nextRolloutFiles: Record<string, RolloutFileSignature> = {
    ...cursor.rolloutFiles
  };
  let ledgerChanged = seenEventIds.size !== baselineEventCount;

  for (const filePath of rolloutFiles) {
    const signature = await readFileSignature(filePath);
    const previousSignature = cursor.rolloutFiles[filePath];

    nextRolloutFiles[filePath] = signature;

    if (isSameRolloutSignature(signature, previousSignature)) {
      continue;
    }

    const contents = await readFile(filePath, "utf8");
    const events = extractCodexEventsFromRollout({
      filePath,
      contents,
      sessionModels,
      providerConfigs
    });

    for (const event of events) {
      if (seenEventIds.has(event.event_id)) {
        continue;
      }

      await appendJsonLine(input.eventLogPath, event);
      seenEventIds.add(event.event_id);
      ledgerChanged = true;
    }
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
  if (!existsSync(input.logsDbPath)) {
    return {
      sessionModels: { ...input.previousModels },
      logsLastId: input.previousLastId
    };
  }

  const db = new Database(input.logsDbPath, { readonly: true, fileMustExist: true }) as ReadOnlyDatabase;

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
  if (!existsSync(configPath)) {
    return {};
  }

  const contents = await readFile(configPath, "utf8");
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
  const entries = await readdir(root, { withFileTypes: true });

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
  const details = await stat(filePath);
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
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
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
