import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import {
  normalizeOpenCodePartRow,
  normalizeOpenCodeMessageRow,
  normalizeOpenCodeSessionRow,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
  type OpenCodeProviderRegistry,
  type OpenCodeSessionRow
} from "./opencode.js";

type SyncCursor = {
  sessionUpdatedAt: number;
  messageUpdatedAt: number;
  partUpdatedAt: number;
  pendingMessageIds: string[];
};

type EventLedger = {
  eventIds: string[];
};

type SessionLookupRow = {
  id: string;
  directory: string;
  model: string | null;
};

type ReadOnlyDatabase = {
  close(): void;
  prepare<Result = unknown>(sql: string): {
    all(...params: unknown[]): Result[];
  };
};

export function resolveDefaultOpenCodeDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

export function resolveDefaultOpenCodeModelsPath(): string {
  return join(homedir(), ".cache", "opencode", "models.json");
}

export async function syncOpenCodeDatabase(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  dbPath?: string;
  modelsPath?: string;
}): Promise<void> {
  const dbPath =
    input.dbPath ??
    process.env.AGENT_METRICS_OPENCODE_DB_PATH ??
    resolveDefaultOpenCodeDbPath();
  const modelsPath =
    input.modelsPath ??
    process.env.AGENT_METRICS_OPENCODE_MODELS_PATH ??
    resolveDefaultOpenCodeModelsPath();

  if (!existsSync(dbPath)) {
    return;
  }

  const cursor = await loadCursor(input.cursorPath);
  const ledger = await loadLedger(input.ledgerPath);
  const providerRegistry = await loadProviderRegistry(modelsPath);
  const seenEventIds = await loadEventIdsFromEventLog(input.eventLogPath, "opencode:");
  const baselineEventCount = seenEventIds.size;

  for (const eventId of ledger.eventIds) {
    seenEventIds.add(eventId);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true }) as ReadOnlyDatabase;

  try {
    const sessionRows = db
      .prepare<OpenCodeSessionRow>(
        `SELECT
          id,
          directory,
          time_created,
          time_updated,
          time_archived,
          model,
          tokens_input,
          tokens_output,
          tokens_reasoning,
          tokens_cache_read,
          tokens_cache_write
        FROM session
        WHERE time_updated >= ?
        ORDER BY time_updated ASC, id ASC`
      )
      .all(cursor.sessionUpdatedAt);
    const messageRows = db
      .prepare<OpenCodeMessageRow>(
        `SELECT
          id,
          session_id,
          time_created,
          time_updated,
          data
        FROM message
        WHERE time_updated >= ?
        ORDER BY time_updated ASC, id ASC`
      )
      .all(cursor.messageUpdatedAt);
    const pendingMessageRows = selectMessagesByIds(
      db,
      cursor.pendingMessageIds,
      new Set(messageRows.map((row) => row.id))
    );
    const allMessageRows = dedupeMessageRows([...messageRows, ...pendingMessageRows]);
    const updatedToolRows = db
      .prepare<OpenCodePartRow>(
        `SELECT
          id,
          message_id,
          session_id,
          time_created,
          time_updated,
          data
        FROM part
        WHERE time_updated >= ?
        ORDER BY time_updated ASC, id ASC`
      )
      .all(cursor.partUpdatedAt);
    const partMessageRows = selectMessagesByIds(
      db,
      [...new Set(updatedToolRows.map((row) => row.message_id))],
      new Set(allMessageRows.map((row) => row.id))
    );
    const allKnownMessageRows = dedupeMessageRows([...allMessageRows, ...partMessageRows]);
    const messagePartRows = selectPartsByMessageIds(db, allKnownMessageRows.map((row) => row.id));
    const sessionLookup = loadSessionLookup(
      db,
      new Set([
        ...sessionRows.map((row) => row.id),
        ...allKnownMessageRows.map((row) => row.session_id),
        ...updatedToolRows.map((row) => row.session_id)
      ])
    );
    const messageLookup = new Map(allKnownMessageRows.map((row) => [row.id, row]));

    const partRowsByMessageId = new Map<string, OpenCodePartRow[]>();

    for (const row of messagePartRows) {
      const existing = partRowsByMessageId.get(row.message_id);
      if (existing) {
        existing.push(row);
      } else {
        partRowsByMessageId.set(row.message_id, [row]);
      }
    }

    const events = [
      ...sessionRows.flatMap((row) => normalizeOpenCodeSessionRow(row)),
      ...allMessageRows.flatMap((row) => {
        const session = sessionLookup.get(row.session_id);

        return normalizeOpenCodeMessageRow({
          row,
          sessionDirectory: session?.directory ?? null,
          sessionModel: session?.model ?? null,
          partRows: partRowsByMessageId.get(row.id) ?? [],
          providerRegistry
        });
      }),
      ...updatedToolRows.flatMap((row) => {
        const session = sessionLookup.get(row.session_id);
        const message = messageLookup.get(row.message_id) ?? null;

        return normalizeOpenCodePartRow({
          row,
          sessionDirectory: session?.directory ?? null,
          sessionModel: session?.model ?? null,
          messageRow: message,
          providerRegistry
        });
      })
    ].sort((left, right) =>
      left.timestamp === right.timestamp
        ? left.event_id.localeCompare(right.event_id)
        : left.timestamp.localeCompare(right.timestamp)
    );

    let ledgerChanged = seenEventIds.size !== baselineEventCount;

    for (const event of events) {
      if (seenEventIds.has(event.event_id)) {
        continue;
      }

      await appendJsonLine(input.eventLogPath, event);
      seenEventIds.add(event.event_id);
      ledgerChanged = true;
    }

    const nextCursor = {
      sessionUpdatedAt: maxCursorValue(cursor.sessionUpdatedAt, sessionRows.map((row) => row.time_updated)),
      messageUpdatedAt: maxCursorValue(cursor.messageUpdatedAt, messageRows.map((row) => row.time_updated)),
      partUpdatedAt: maxCursorValue(cursor.partUpdatedAt, updatedToolRows.map((row) => row.time_updated)),
      pendingMessageIds: collectPendingMessageIds(allMessageRows, seenEventIds)
    } satisfies SyncCursor;

    if (!isSameCursor(nextCursor, cursor)) {
      await writeJsonFileAtomic(input.cursorPath, nextCursor);
    }

    if (ledgerChanged) {
      await writeJsonFileAtomic(input.ledgerPath, {
        eventIds: [...seenEventIds].sort()
      } satisfies EventLedger);
    }
  } finally {
    db.close();
  }
}

function selectPartsByMessageIds(db: ReadOnlyDatabase, messageIds: string[]): OpenCodePartRow[] {
  if (messageIds.length === 0) {
    return [];
  }

  const placeholders = messageIds.map(() => "?").join(", ");

  return db
    .prepare<OpenCodePartRow>(
      `SELECT
        id,
        message_id,
        session_id,
        time_created,
        time_updated,
        data
      FROM part
      WHERE message_id IN (${placeholders})
      ORDER BY time_created ASC, id ASC`
    )
    .all(...messageIds);
}

function selectMessagesByIds(
  db: ReadOnlyDatabase,
  messageIds: string[],
  excludeMessageIds?: Set<string>
): OpenCodeMessageRow[] {
  const ids = messageIds.filter((messageId) => !excludeMessageIds?.has(messageId));
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");

  return db
    .prepare<OpenCodeMessageRow>(
      `SELECT
        id,
        session_id,
        time_created,
        time_updated,
        data
      FROM message
      WHERE id IN (${placeholders})
      ORDER BY time_updated ASC, id ASC`
    )
    .all(...ids);
}

function dedupeMessageRows(rows: OpenCodeMessageRow[]): OpenCodeMessageRow[] {
  const deduped = new Map<string, OpenCodeMessageRow>();

  for (const row of rows) {
    deduped.set(row.id, row);
  }

  return [...deduped.values()].sort((left, right) =>
    left.time_updated === right.time_updated
      ? left.id.localeCompare(right.id)
      : left.time_updated - right.time_updated
  );
}

function loadSessionLookup(db: ReadOnlyDatabase, sessionIds: Set<string>): Map<string, SessionLookupRow> {
  if (sessionIds.size === 0) {
    return new Map();
  }

  const values = [...sessionIds];
  const placeholders = values.map(() => "?").join(", ");
  const rows = db
    .prepare<SessionLookupRow>(
      `SELECT id, directory, model FROM session WHERE id IN (${placeholders})`
    )
    .all(...values);

  return new Map(rows.map((row) => [row.id, row]));
}

async function loadCursor(cursorPath: string): Promise<SyncCursor> {
  const parsed = await readJsonFile(cursorPath);

  return {
    sessionUpdatedAt: normalizeCursorValue(parsed, "sessionUpdatedAt"),
    messageUpdatedAt: normalizeCursorValue(parsed, "messageUpdatedAt"),
    partUpdatedAt: normalizeCursorValue(parsed, "partUpdatedAt"),
    pendingMessageIds: normalizeStringArray(parsed, "pendingMessageIds")
  };
}

async function loadLedger(ledgerPath: string): Promise<EventLedger> {
  const parsed = await readJsonFile(ledgerPath);

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("eventIds" in parsed) ||
    !Array.isArray(parsed.eventIds)
  ) {
    return { eventIds: [] };
  }

  return {
    eventIds: parsed.eventIds.filter((entry): entry is string => typeof entry === "string")
  };
}

async function loadEventIdsFromEventLog(eventLogPath: string, prefix: string): Promise<Set<string>> {
  const eventIds = new Set<string>();
  let contents: string;

  try {
    contents = await readFile(eventLogPath, "utf8");
  } catch {
    return eventIds;
  }

  for (const line of contents.split("\n").filter((entry) => entry.length > 0)) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "event_id" in parsed &&
      typeof parsed.event_id === "string" &&
      parsed.event_id.startsWith(prefix)
    ) {
      eventIds.add(parsed.event_id);
    }
  }

  return eventIds;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
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

function normalizeCursorValue(
  value: Record<string, unknown> | null,
  key: keyof SyncCursor
): number {
  if (!value) {
    return 0;
  }

  const raw = value[key];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

function normalizeStringArray(
  value: Record<string, unknown> | null,
  key: "pendingMessageIds"
): string[] {
  if (!value) {
    return [];
  }

  const raw = value[key];
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function maxCursorValue(current: number, values: number[]): number {
  return values.reduce((max, value) => (value > max ? value : max), current);
}

function isSameCursor(left: SyncCursor, right: SyncCursor): boolean {
  return (
    left.sessionUpdatedAt === right.sessionUpdatedAt &&
    left.messageUpdatedAt === right.messageUpdatedAt &&
    left.partUpdatedAt === right.partUpdatedAt &&
    isSameStringArray(left.pendingMessageIds, right.pendingMessageIds)
  );
}

function isSameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectPendingMessageIds(
  messageRows: OpenCodeMessageRow[],
  seenEventIds: Set<string>
): string[] {
  const pending = new Set<string>();

  for (const row of messageRows) {
    if (shouldRetryMessageForTokens(row, seenEventIds)) {
      pending.add(row.id);
    }
  }

  return [...pending].sort();
}

function shouldRetryMessageForTokens(
  row: OpenCodeMessageRow,
  seenEventIds: Set<string>
): boolean {
  const inspection = inspectOpenCodeMessage(row.data);
  if (inspection.role !== "assistant" || inspection.hasTokens) {
    return false;
  }

  return !seenEventIds.has(buildOpenCodeUsageEventId(row.id));
}

function inspectOpenCodeMessage(data: string): {
  role: string | null;
  hasTokens: boolean;
} {
  try {
    const parsed = JSON.parse(data) as unknown;
    const record = isRecord(parsed) ? parsed : null;
    if (record === null) {
      return {
        role: null,
        hasTokens: false
      };
    }

    return {
      role: normalizeNonEmptyString(record.role),
      hasTokens: hasOpenCodeTokenPayload(record)
    };
  } catch {
    return {
      role: null,
      hasTokens: false
    };
  }
}

function hasOpenCodeTokenPayload(message: Record<string, unknown>): boolean {
  const tokens = isRecord(message.tokens) ? message.tokens : null;
  if (tokens === null) {
    return false;
  }

  const cache = isRecord(tokens.cache) ? tokens.cache : null;
  const inputTokens = normalizeInteger(tokens.input) ?? 0;
  const outputTokens =
    (normalizeInteger(tokens.output) ?? 0) + (normalizeInteger(tokens.reasoning) ?? 0);
  const cacheCreationTokens = normalizeInteger(cache?.write) ?? 0;
  const cacheReadTokens = normalizeInteger(cache?.read) ?? 0;

  return (
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheCreationTokens > 0 ||
    cacheReadTokens > 0
  );
}

function buildOpenCodeUsageEventId(messageId: string): string {
  return `opencode:message:${messageId}:usage`;
}

async function loadProviderRegistry(modelsPath: string): Promise<OpenCodeProviderRegistry> {
  if (!existsSync(modelsPath)) {
    return {};
  }

  const parsed = await readJsonFile(modelsPath);
  if (parsed === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([providerId, value]) => {
      if (!isRecord(value)) {
        return [];
      }

      const baseUrl = normalizeNonEmptyString(value.api);
      return [
        [
          providerId,
          {
            baseUrl,
            host: extractHost(baseUrl)
          }
        ] as const
      ];
    })
  );
}

function extractHost(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
